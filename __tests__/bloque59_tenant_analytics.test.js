const { getMessageStats, getLeadFunnel, getTopContacts, exportAnalyticsCSV, getRetentionRate, __setFirestoreForTests } = require('../core/tenant_analytics');

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

describe('T367 - tenant_analytics', () => {
  test('getMessageStats returns zeros when no conversations', async () => {
    const stats = await getMessageStats('uid1');
    expect(stats.total).toBe(0);
    expect(stats.sent).toBe(0);
    expect(stats.received).toBe(0);
    expect(stats.byDay).toEqual({});
  });

  test('getMessageStats throws if no uid', async () => {
    await expect(getMessageStats(null)).rejects.toThrow('uid required');
  });

  test('getLeadFunnel returns correct funnel counts', async () => {
    const now = Date.now();
    await db.collection('leads').doc('l1').set({ uid: 'uid2', status: 'new', createdAt: now });
    await db.collection('leads').doc('l2').set({ uid: 'uid2', status: 'converted', createdAt: now });
    await db.collection('leads').doc('l3').set({ uid: 'uid2', status: 'lost', createdAt: now });
    const funnel = await getLeadFunnel('uid2');
    expect(funnel.new).toBe(3);
    expect(funnel.converted).toBe(1);
    expect(funnel.lost).toBe(1);
    expect(funnel.contacted).toBe(2);
  });

  test('getTopContacts returns empty when no data', async () => {
    const contacts = await getTopContacts('uid1', 5);
    expect(Array.isArray(contacts)).toBe(true);
    expect(contacts.length).toBe(0);
  });

  test('exportAnalyticsCSV generates CSV string', () => {
    const stats = { byDay: { '2026-01-01': 10, '2026-01-02': 5 } };
    const csv = exportAnalyticsCSV('uid1', stats);
    expect(csv).toContain('date,total');
    expect(csv).toContain('2026-01-01,10');
    expect(csv).toContain('2026-01-02,5');
  });

  test('exportAnalyticsCSV throws if no uid or stats', () => {
    expect(() => exportAnalyticsCSV(null, {})).toThrow('uid and stats required');
    expect(() => exportAnalyticsCSV('uid1', null)).toThrow('uid and stats required');
  });

  test('getRetentionRate returns 0 when no leads', async () => {
    const rate = await getRetentionRate('uid_empty');
    expect(rate).toBe(0);
  });

  test('getRetentionRate calculates 50% for 2 active 2 inactive', async () => {
    const recent = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
    await db.collection('leads').doc('r1').set({ uid: 'uid3', lastSeen: recent });
    await db.collection('leads').doc('r2').set({ uid: 'uid3', lastSeen: recent });
    await db.collection('leads').doc('r3').set({ uid: 'uid3', lastSeen: old });
    await db.collection('leads').doc('r4').set({ uid: 'uid3', lastSeen: old });
    const rate = await getRetentionRate('uid3');
    expect(rate).toBe(50);
  });
});
