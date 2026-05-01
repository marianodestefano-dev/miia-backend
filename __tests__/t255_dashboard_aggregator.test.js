'use strict';

const {
  buildOverviewSection, buildLeadsFunnelData,
  buildRevenueData, buildConversationsSection,
  buildDashboardSnapshot, saveDashboardSnapshot,
  getLatestDashboardSnapshot, buildDashboardText,
  getTimeframeRange, isValidSection, isValidTimeframe,
  DASHBOARD_SECTIONS, TIMEFRAMES,
  __setFirestoreForTests,
} = require('../core/dashboard_aggregator');

const UID = 'testUid1234567890';
const NOW = 1746100000000;

function makeMockDb({ stored = {}, throwGet = false, throwSet = false } = {}) {
  const db_stored = { ...stored };
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              db_stored[id] = opts && opts.merge ? { ...(db_stored[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { exists: !!db_stored[id], data: () => db_stored[id] };
            },
          }),
          where: (field, op, val) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const entries = Object.values(db_stored).filter(d => d && d[field] === val);
              return { forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return { forEach: fn => Object.values(db_stored).forEach(d => fn({ data: () => d })) };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

describe('Constantes', () => {
  test('DASHBOARD_SECTIONS tiene 6', () => { expect(DASHBOARD_SECTIONS.length).toBe(6); });
  test('frozen DASHBOARD_SECTIONS', () => { expect(() => { DASHBOARD_SECTIONS.push('x'); }).toThrow(); });
  test('TIMEFRAMES tiene 4', () => { expect(TIMEFRAMES.length).toBe(4); });
  test('frozen TIMEFRAMES', () => { expect(() => { TIMEFRAMES.push('x'); }).toThrow(); });
});

describe('isValidSection / isValidTimeframe', () => {
  test('overview es seccion valida', () => { expect(isValidSection('overview')).toBe(true); });
  test('bad_section invalida', () => { expect(isValidSection('bad')).toBe(false); });
  test('week es timeframe valido', () => { expect(isValidTimeframe('week')).toBe(true); });
  test('yearly invalido', () => { expect(isValidTimeframe('yearly')).toBe(false); });
});

describe('getTimeframeRange', () => {
  test('today: from y to dentro del mismo dia', () => {
    const r = getTimeframeRange('today', NOW);
    expect(r.to).toBe(NOW);
    expect(r.from).toBeLessThanOrEqual(NOW);
    expect(NOW - r.from).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
  test('week: from ~7 dias antes', () => {
    const r = getTimeframeRange('week', NOW);
    expect(NOW - r.from).toBeGreaterThanOrEqual(6 * 24 * 60 * 60 * 1000);
  });
  test('month: from ~30 dias antes', () => {
    const r = getTimeframeRange('month', NOW);
    expect(NOW - r.from).toBeGreaterThanOrEqual(29 * 24 * 60 * 60 * 1000);
  });
  test('quarter: from ~90 dias antes', () => {
    const r = getTimeframeRange('quarter', NOW);
    expect(NOW - r.from).toBeGreaterThanOrEqual(89 * 24 * 60 * 60 * 1000);
  });
});

describe('buildOverviewSection', () => {
  test('sin opts retorna defaults', () => {
    const s = buildOverviewSection();
    expect(s.section).toBe('overview');
    expect(s.totalLeads).toBe(0);
    expect(s.conversionRate).toBe(0);
  });
  test('calcula conversionRate correctamente', () => {
    const s = buildOverviewSection({ totalLeads: 100, convertedLeads: 25 });
    expect(s.conversionRate).toBe(0.25);
  });
  test('conversionRate 0 si totalLeads es 0', () => {
    const s = buildOverviewSection({ totalLeads: 0, convertedLeads: 0 });
    expect(s.conversionRate).toBe(0);
  });
  test('incluye todos los campos esperados', () => {
    const s = buildOverviewSection({ totalRevenue: 500, pendingPayments: 100, avgResponseTime: 45 });
    expect(s.totalRevenue).toBe(500);
    expect(s.pendingPayments).toBe(100);
    expect(s.avgResponseTime).toBe(45);
  });
});

describe('buildLeadsFunnelData', () => {
  test('array vacio retorna empty funnel', () => {
    const r = buildLeadsFunnelData([]);
    expect(r.total).toBe(0);
    expect(r.topLeads).toEqual([]);
  });
  test('null retorna empty funnel', () => {
    const r = buildLeadsFunnelData(null);
    expect(r.total).toBe(0);
  });
  test('clasifica leads por categoria', () => {
    const leads = [
      { phone: '+1', score: 90, category: 'ready' },
      { phone: '+2', score: 70, category: 'hot' },
      { phone: '+3', score: 40, category: 'warm' },
      { phone: '+4', score: 15, category: 'cold' },
      { phone: '+5', score: 5, category: 'spam' },
    ];
    const r = buildLeadsFunnelData(leads);
    expect(r.funnel.listo).toBe(1);
    expect(r.funnel.caliente).toBe(1);
    expect(r.funnel.interesado).toBe(1);
    expect(r.funnel.frio).toBe(1);
    expect(r.funnel.spam).toBe(1);
    expect(r.total).toBe(5);
  });
  test('topLeads excluye spam y ordena por score', () => {
    const leads = [
      { phone: '+1', score: 90, category: 'ready' },
      { phone: '+2', score: 70, category: 'hot' },
      { phone: '+3', score: 5, category: 'spam' },
    ];
    const r = buildLeadsFunnelData(leads);
    expect(r.topLeads.length).toBe(2);
    expect(r.topLeads[0].score).toBe(90);
    expect(r.topLeads.find(l => l.category === 'spam')).toBeUndefined();
  });
  test('topLeads max 5', () => {
    const leads = Array.from({ length: 10 }, (_, i) => ({ phone: '+' + i, score: 50 + i, category: 'hot' }));
    const r = buildLeadsFunnelData(leads);
    expect(r.topLeads.length).toBe(5);
  });
});

describe('buildRevenueData', () => {
  test('array vacio retorna zeros', () => {
    const r = buildRevenueData([], 'month');
    expect(r.total).toBe(0);
    expect(r.paymentCount).toBe(0);
  });
  test('null retorna zeros', () => {
    const r = buildRevenueData(null, 'month');
    expect(r.total).toBe(0);
  });
  test('suma solo payments confirmados', () => {
    const payments = [
      { amount: 100, status: 'confirmed', currency: 'USD' },
      { amount: 50, status: 'pending', currency: 'USD' },
      { amount: 200, status: 'confirmed', currency: 'USD' },
    ];
    const r = buildRevenueData(payments, 'month');
    expect(r.total).toBe(300);
    expect(r.byCurrency.USD).toBe(300);
  });
  test('byStatus incluye todos los estados', () => {
    const payments = [
      { amount: 100, status: 'confirmed', currency: 'USD' },
      { amount: 50, status: 'pending', currency: 'ARS' },
    ];
    const r = buildRevenueData(payments, 'month');
    expect(r.byStatus.confirmed).toBe(100);
    expect(r.byStatus.pending).toBe(50);
  });
  test('incluye timeframe en resultado', () => {
    const r = buildRevenueData([], 'week');
    expect(r.timeframe).toBe('week');
  });
});

describe('buildConversationsSection', () => {
  test('array vacio retorna empty', () => {
    const r = buildConversationsSection([]);
    expect(r.total).toBe(0);
    expect(r.topTopics).toEqual([]);
  });
  test('null retorna empty', () => {
    const r = buildConversationsSection(null);
    expect(r.total).toBe(0);
  });
  test('agrupa por sentimiento', () => {
    const convs = [
      { sentiment: { label: 'positive' }, keyMoments: [] },
      { sentiment: { label: 'positive' }, keyMoments: [] },
      { sentiment: { label: 'negative' }, keyMoments: [] },
    ];
    const r = buildConversationsSection(convs);
    expect(r.bySentiment.positive).toBe(2);
    expect(r.bySentiment.negative).toBe(1);
    expect(r.total).toBe(3);
  });
  test('extrae topTopics de keyMoments', () => {
    const convs = [
      { sentiment: { label: 'neutral' }, keyMoments: [{ type: 'price_inquiry' }, { type: 'price_inquiry' }] },
      { sentiment: { label: 'neutral' }, keyMoments: [{ type: 'appointment_request' }] },
    ];
    const r = buildConversationsSection(convs);
    expect(r.topTopics[0].type).toBe('price_inquiry');
    expect(r.topTopics[0].count).toBe(2);
  });
});

describe('buildDashboardSnapshot', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildDashboardSnapshot(undefined, {})).toThrow('uid requerido');
  });
  test('lanza si sections no definido', () => {
    expect(() => buildDashboardSnapshot(UID, null)).toThrow('sections requerido');
  });
  test('construye snapshot correctamente', () => {
    const sections = { overview: buildOverviewSection({ totalLeads: 10 }) };
    const s = buildDashboardSnapshot(UID, sections, { timeframe: 'week', date: '2026-05-01' });
    expect(s.uid).toBe(UID);
    expect(s.timeframe).toBe('week');
    expect(s.date).toBe('2026-05-01');
    expect(s.snapshotId).toContain('week');
    expect(s.sections.overview.totalLeads).toBe(10);
  });
  test('timeframe invalido cae a month', () => {
    const s = buildDashboardSnapshot(UID, {}, { timeframe: 'yearly' });
    expect(s.timeframe).toBe('month');
  });
});

describe('saveDashboardSnapshot', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveDashboardSnapshot(undefined, { snapshotId: 'x' })).rejects.toThrow('uid requerido');
  });
  test('lanza si snapshot invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveDashboardSnapshot(UID, null)).rejects.toThrow('snapshot invalido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const s = buildDashboardSnapshot(UID, {}, { date: '2026-05-01' });
    const id = await saveDashboardSnapshot(UID, s);
    expect(id).toBe(s.snapshotId);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const s = buildDashboardSnapshot(UID, {}, { date: '2026-05-01' });
    await expect(saveDashboardSnapshot(UID, s)).rejects.toThrow('set error');
  });
});

describe('getLatestDashboardSnapshot', () => {
  test('lanza si uid undefined', async () => {
    await expect(getLatestDashboardSnapshot(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna null si no hay snapshots', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getLatestDashboardSnapshot(UID)).toBeNull();
  });
  test('retorna el mas reciente', async () => {
    const s1 = buildDashboardSnapshot(UID, {}, { timeframe: 'week', date: '2026-05-01', generatedAt: 1000 });
    const s2 = buildDashboardSnapshot(UID, {}, { timeframe: 'week', date: '2026-05-02', generatedAt: 2000 });
    __setFirestoreForTests(makeMockDb({ stored: { [s1.snapshotId]: s1, [s2.snapshotId]: s2 } }));
    const latest = await getLatestDashboardSnapshot(UID, 'week');
    expect(latest.date).toBe('2026-05-02');
  });
  test('fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getLatestDashboardSnapshot(UID)).toBeNull();
  });
});

describe('buildDashboardText', () => {
  test('retorna vacio si null', () => { expect(buildDashboardText(null)).toBe(''); });
  test('incluye fecha y timeframe', () => {
    const s = buildDashboardSnapshot(UID, {}, { date: '2026-05-01', timeframe: 'week' });
    const text = buildDashboardText(s);
    expect(text).toContain('2026-05-01');
    expect(text).toContain('week');
  });
  test('incluye overview si presente', () => {
    const sections = { overview: buildOverviewSection({ totalLeads: 42, totalRevenue: 1500 }) };
    const s = buildDashboardSnapshot(UID, sections, { date: '2026-05-01' });
    const text = buildDashboardText(s);
    expect(text).toContain('42');
    expect(text).toContain('1500');
  });
  test('incluye funnel si leads presente', () => {
    const leads = [{ phone: '+1', score: 90, category: 'ready' }];
    const sections = {
      overview: buildOverviewSection({ totalLeads: 1 }),
      leads: buildLeadsFunnelData(leads),
    };
    const s = buildDashboardSnapshot(UID, sections, { date: '2026-05-01' });
    const text = buildDashboardText(s);
    expect(text).toContain('Funnel');
  });
});
