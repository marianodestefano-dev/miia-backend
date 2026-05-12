'use strict';

jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));

let agg, summ;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
  agg = require('../core/dashboard_aggregator');
  summ = require('../core/dashboard_summary');
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (summ && summ.__setFirestoreForTests) summ.__setFirestoreForTests(null);
  jest.restoreAllMocks();
});

function makeDb({ exists = true, data = null } = {}) {
  return {
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({
        collection: jest.fn().mockReturnValue({
          doc: jest.fn().mockReturnValue({
            get: jest.fn().mockResolvedValue({ exists, data: () => data }),
          }),
        }),
      }),
    }),
  };
}

describe('P2 -- dashboard_aggregator branches sin cubrir', () => {
  test('getTimeframeRange default branch -> from=dayStart cuando timeframe desconocido', () => {
    const r = agg.getTimeframeRange('unknown_timeframe');
    expect(r).toHaveProperty('from');
    expect(r).toHaveProperty('to');
    expect(r.from).toBeLessThan(r.to);
  });

  test('buildLeadsFunnelData: category unknown -> cae en else funnel.frio (line 68)', () => {
    const scoredLeads = [
      { phone: '+5491111', score: 80, category: 'unknown_cat' },
      { phone: '+5492222', score: 70, category: null },
    ];
    const r = agg.buildLeadsFunnelData(scoredLeads);
    expect(r.funnel.frio).toBe(2);
  });

  test('buildLeadsFunnelData: todos los ramos del switch de categoria', () => {
    const scoredLeads = [
      { phone: '+1', score: 0, category: 'spam' },
      { phone: '+2', score: 10, category: 'cold' },
      { phone: '+3', score: 50, category: 'warm' },
      { phone: '+4', score: 80, category: 'hot' },
      { phone: '+5', score: 90, category: 'ready' },
    ];
    const r = agg.buildLeadsFunnelData(scoredLeads);
    expect(r.funnel.spam).toBe(1);
    expect(r.funnel.frio).toBe(1);
    expect(r.funnel.interesado).toBe(1);
    expect(r.funnel.caliente).toBe(1);
    expect(r.funnel.listo).toBe(1);
  });
});

describe('P2 -- dashboard_summary branches sin cubrir', () => {
  test('snap.exists=true, conversations con datos reales -> totalConversations correcto', async () => {
    const data = {
      conversations: { '+5491111': [{ timestamp: Date.now(), role: 'user', text: 'hola' }] },
      contactTypes: { '+5491111': 'lead' },
    };
    summ.__setFirestoreForTests(makeDb({ exists: true, data }));
    const r = await summ.buildDashboardSummary('uid1');
    expect(r.totalConversations).toBe(1);
    expect(r.totalLeads).toBe(1);
  });

  test('snap.exists=true, conversations[phone] no es array -> usa [] (branch line 68)', async () => {
    const data = {
      conversations: { '+5491111': 'string-no-array' },
      contactTypes: {},
    };
    summ.__setFirestoreForTests(makeDb({ exists: true, data }));
    const r = await summ.buildDashboardSummary('uid1');
    expect(r.totalConversations).toBe(1);
    expect(r.recentMessageCount).toBe(0);
  });

  test('snap.exists=true, data.conversations null -> {} (branch || {})', async () => {
    const data = { conversations: null, contactTypes: null };
    summ.__setFirestoreForTests(makeDb({ exists: true, data }));
    const r = await summ.buildDashboardSummary('uid1');
    expect(r.totalConversations).toBe(0);
    expect(r.totalLeads).toBe(0);
  });

  test('snap.exists=true, data null -> {} por ambos branches (line 52-53)', async () => {
    summ.__setFirestoreForTests(makeDb({ exists: true, data: null }));
    const r = await summ.buildDashboardSummary('uid1');
    expect(r.totalConversations).toBe(0);
  });

  test('contactTypes con miia_lead y client -> cuenta cada uno', async () => {
    const data = {
      conversations: { '+1': [], '+2': [] },
      contactTypes: { '+1': 'miia_lead', '+2': 'client' },
    };
    summ.__setFirestoreForTests(makeDb({ exists: true, data }));
    const r = await summ.buildDashboardSummary('uid1');
    expect(r.totalLeads).toBe(1);
    expect(r.totalClients).toBe(1);
  });
});
