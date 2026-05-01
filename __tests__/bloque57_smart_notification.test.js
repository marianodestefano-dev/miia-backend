const { buildDailySummary, buildWeeklySummary, formatSummaryMessage, scheduleNotification, shouldNotify, __setFirestoreForTests } = require('../core/smart_notification');

function makeDb() {
  const store = {};
  function makeDoc(p) {
    return {
      get: async () => { const d = store[p]; return { exists: !!d, data: () => d }; },
      set: async (data, opts) => {
        if (opts && opts.merge) store[p] = Object.assign({}, store[p] || {}, data);
        else store[p] = Object.assign({}, data);
      },
      collection: (sub) => makeCol(p + '/' + sub),
    };
  }
  function makeCol(p) {
    return {
      doc: (id) => makeDoc(p + '/' + id),
      where: (f, op, v) => ({
        where: (f2, op2, v2) => ({
          get: async () => {
            const prefix = p + '/';
            const docs = Object.entries(store)
              .filter(([k, d]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && d[f] === v && d[f2] === v2)
              .map(([, d]) => ({ data: () => d }));
            return { docs, forEach: fn => docs.forEach(fn), empty: docs.length === 0 };
          }
        }),
        get: async () => {
          const prefix = p + '/';
          const docs = Object.entries(store)
            .filter(([k, d]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && d[f] === v)
            .map(([, d]) => ({ data: () => d }));
          return { docs, forEach: fn => docs.forEach(fn), empty: docs.length === 0 };
        }
      }),
    };
  }
  return { collection: (col) => makeCol(col) };
}

let db;
beforeEach(() => { db = makeDb(); __setFirestoreForTests(db); });
afterAll(() => { __setFirestoreForTests(null); });

describe('T363 - smart_notification', () => {
  test('buildDailySummary returns daily period with numeric fields', async () => {
    const summary = await buildDailySummary('uid1');
    expect(summary.period).toBe('daily');
    expect(typeof summary.sent).toBe('number');
    expect(typeof summary.received).toBe('number');
    expect(typeof summary.newLeads).toBe('number');
    expect(summary.date).toBeDefined();
  });

  test('buildWeeklySummary returns weekly period', async () => {
    const summary = await buildWeeklySummary('uid1');
    expect(summary.period).toBe('weekly');
    expect(summary.weekStart).toBeDefined();
    expect(typeof summary.newLeads).toBe('number');
  });

  test('buildDailySummary throws if no uid', async () => {
    await expect(buildDailySummary(null)).rejects.toThrow('uid required');
  });

  test('formatSummaryMessage formats daily summary', () => {
    const msg = formatSummaryMessage({ period: "daily", sent: 10, received: 5, newLeads: 2 });
    expect(msg).toContain('10');
    expect(msg).toContain('5');
  });

  test('formatSummaryMessage formats weekly summary', () => {
    const msg = formatSummaryMessage({ period: "weekly", sent: 50, received: 30, newLeads: 8 });
    expect(msg).toContain('50');
    expect(msg).toContain('30');
  });

  test('scheduleNotification and shouldNotify work together', async () => {
    await scheduleNotification('uid3', 'daily', '0 9 * * *');
    const result = await shouldNotify('uid3', 'daily');
    expect(result).toBe(true);
  });

  test('shouldNotify returns false for unconfigured uid', async () => {
    const result = await shouldNotify('unknown_uid', 'daily');
    expect(result).toBe(false);
  });
});
