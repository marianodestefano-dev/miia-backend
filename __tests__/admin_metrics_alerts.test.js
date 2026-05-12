'use strict';

const a = require('../core/admin_metrics_alerts');
const {
  getEnterpriseMetrics,
  getGlobalMetrics,
  persistGlobalMetrics,
  emitCeoAlert,
  listActiveAlerts,
  resolveAlert,
  ALERT_LEVELS,
  CHURN_INACTIVITY_DAYS,
  __setFirestoreForTests,
} = a;

// ── Mock ──────────────────────────────────────────────────────────────────────

function makeDb(opts) {
  const o = opts || {};
  const enterprises = o.enterprises || {};
  const membersByEnt = o.membersByEnt || {};
  const alerts = o.alerts || {};
  const adminMetrics = o.adminMetrics || {};
  const captures = { alertSets: [], adminMetricsSets: [] };

  const entDocFn = jest.fn((id) => ({
    get: jest.fn().mockResolvedValue({ exists: !!enterprises[id], data: () => enterprises[id] || {} }),
    collection: function (subName) {
      const members = membersByEnt[id] || {};
      return {
        get: jest.fn().mockResolvedValue({
          forEach: function (cb) {
            Object.keys(members).forEach(function (uid) {
              cb({ data: () => members[uid] });
            });
          },
        }),
      };
    },
  }));

  const entCol = {
    doc: entDocFn,
    get: jest.fn().mockResolvedValue({
      forEach: function (cb) {
        Object.keys(enterprises).forEach(function (id) {
          cb({ data: () => enterprises[id] });
        });
      },
    }),
  };

  const alertDocFn = jest.fn((id) => ({
    get: jest.fn().mockResolvedValue({ exists: !!alerts[id], data: () => alerts[id] || {} }),
    set: jest.fn((payload, merge) => { captures.alertSets.push({ id, payload, merge }); return Promise.resolve({}); }),
  }));
  const alertsCol = {
    doc: alertDocFn,
    get: jest.fn().mockResolvedValue({
      forEach: function (cb) {
        Object.keys(alerts).forEach(function (id) {
          cb({ data: () => alerts[id] });
        });
      },
    }),
  };

  const adminMetricsDocFn = jest.fn((id) => ({
    get: jest.fn().mockResolvedValue({ exists: !!adminMetrics[id], data: () => adminMetrics[id] || {} }),
    set: jest.fn((payload, merge) => { captures.adminMetricsSets.push({ id, payload, merge }); return Promise.resolve({}); }),
  }));

  const db = {
    collection: jest.fn((name) => {
      if (name === 'enterprises') return entCol;
      if (name === 'ceo_alerts') return alertsCol;
      return { doc: adminMetricsDocFn };
    }),
  };
  return { db, captures };
}

beforeEach(() => {
  __setFirestoreForTests(null);
});

// ── getEnterpriseMetrics ──────────────────────────────────────────────────────

describe('getEnterpriseMetrics', () => {
  test('enterpriseId null -> throw', async () => {
    await expect(getEnterpriseMetrics(null)).rejects.toThrow('enterpriseId_requerido');
  });

  test('no encontrada -> throw', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    await expect(getEnterpriseMetrics('ent_1')).rejects.toThrow('enterprise_no_encontrada');
  });

  test('OK sin members -> activeMembers=0, lastActivity=null, churnRisk=true', async () => {
    const { db } = makeDb({
      enterprises: { ent_1: { name: 'Acme', plan: 'pro', active: true } },
      membersByEnt: { ent_1: {} },
    });
    __setFirestoreForTests(db);
    const r = await getEnterpriseMetrics('ent_1');
    expect(r.activeMembers).toBe(0);
    expect(r.lastActivity).toBeNull();
    expect(r.churnRisk).toBe(true);
    expect(r.mrr_usd).toBe(79);
    expect(r.arr_usd).toBe(948);
  });

  test('OK con members activos y lastSeenAt -> calcula churn', async () => {
    const recent = new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(); // 2 dias atras
    const { db } = makeDb({
      enterprises: { ent_1: { name: 'Acme', plan: 'starter', active: true } },
      membersByEnt: {
        ent_1: {
          u1: { active: true, lastSeenAt: recent },
          u2: { active: false, lastSeenAt: recent },
          u3: { active: true }, // sin lastSeenAt
        },
      },
    });
    __setFirestoreForTests(db);
    const r = await getEnterpriseMetrics('ent_1');
    expect(r.activeMembers).toBe(2);
    expect(r.daysSinceActivity).toBeLessThanOrEqual(2);
    expect(r.churnRisk).toBe(false);
  });

  test('OK - lastActivity mayor a CHURN_INACTIVITY_DAYS -> churnRisk=true', async () => {
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString();
    const { db } = makeDb({
      enterprises: { ent_1: { plan: 'enterprise' } },
      membersByEnt: { ent_1: { u1: { active: true, lastSeenAt: old } } },
    });
    __setFirestoreForTests(db);
    const r = await getEnterpriseMetrics('ent_1');
    expect(r.churnRisk).toBe(true);
    expect(r.daysSinceActivity).toBeGreaterThanOrEqual(CHURN_INACTIVITY_DAYS);
  });

  test('lastActivity invalida (NaN) -> Infinity, churnRisk=true', async () => {
    const { db } = makeDb({
      enterprises: { ent_1: { plan: 'pro' } },
      membersByEnt: { ent_1: { u1: { active: true, lastSeenAt: 'not-a-date' } } },
    });
    __setFirestoreForTests(db);
    const r = await getEnterpriseMetrics('ent_1');
    expect(r.churnRisk).toBe(true);
  });

  test('plan invalido -> mrr=0', async () => {
    const { db } = makeDb({
      enterprises: { ent_1: { plan: 'unknown' } },
      membersByEnt: { ent_1: {} },
    });
    __setFirestoreForTests(db);
    const r = await getEnterpriseMetrics('ent_1');
    expect(r.mrr_usd).toBe(0);
    expect(r.arr_usd).toBe(0);
  });

  test('ent.active=false -> active=false', async () => {
    const { db } = makeDb({
      enterprises: { ent_1: { plan: 'pro', active: false } },
      membersByEnt: { ent_1: {} },
    });
    __setFirestoreForTests(db);
    const r = await getEnterpriseMetrics('ent_1');
    expect(r.active).toBe(false);
  });

  test('ent sin name ni plan -> null', async () => {
    const { db } = makeDb({
      enterprises: { ent_1: {} },
      membersByEnt: { ent_1: {} },
    });
    __setFirestoreForTests(db);
    const r = await getEnterpriseMetrics('ent_1');
    expect(r.name).toBeNull();
    expect(r.plan).toBeNull();
  });

  test('member con lastSeenAt mas reciente reemplaza previo', async () => {
    const t1 = new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString();
    const t2 = new Date(Date.now() - 1000 * 60 * 60 * 24 * 1).toISOString();
    const { db } = makeDb({
      enterprises: { ent_1: { plan: 'pro' } },
      membersByEnt: {
        ent_1: {
          u1: { active: true, lastSeenAt: t1 },
          u2: { active: true, lastSeenAt: t2 },
        },
      },
    });
    __setFirestoreForTests(db);
    const r = await getEnterpriseMetrics('ent_1');
    expect(r.lastActivity).toBe(t2);
  });
});

// ── getGlobalMetrics ──────────────────────────────────────────────────────────

describe('getGlobalMetrics', () => {
  test('sin enterprises -> 0', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await getGlobalMetrics();
    expect(r.totalEnterprises).toBe(0);
    expect(r.mrr_usd).toBe(0);
  });

  test('mix de planes -> calcula MRR/ARR', async () => {
    const { db } = makeDb({
      enterprises: {
        e1: { plan: 'starter', active: true },
        e2: { plan: 'pro', active: true },
        e3: { plan: 'enterprise', active: true },
        e4: { plan: 'pro', active: false }, // no suma MRR pero suma byPlan
      },
    });
    __setFirestoreForTests(db);
    const r = await getGlobalMetrics();
    expect(r.totalEnterprises).toBe(4);
    expect(r.activeEnterprises).toBe(3);
    expect(r.mrr_usd).toBe(29 + 79 + 199);
    expect(r.byPlan.pro).toBe(2);
  });

  test('plan no listado en byPlan -> no rompe', async () => {
    const { db } = makeDb({
      enterprises: { e1: { plan: 'mega', active: true } },
    });
    __setFirestoreForTests(db);
    const r = await getGlobalMetrics();
    expect(r.totalEnterprises).toBe(1);
    expect(r.byPlan.starter).toBe(0);
  });
});

// ── persistGlobalMetrics ──────────────────────────────────────────────────────

describe('persistGlobalMetrics', () => {
  test('persiste snapshot', async () => {
    const { db, captures } = makeDb({
      enterprises: { e1: { plan: 'starter', active: true } },
    });
    __setFirestoreForTests(db);
    const r = await persistGlobalMetrics();
    expect(r.totalEnterprises).toBe(1);
    expect(captures.adminMetricsSets[0].id).toBe('global');
    expect(captures.adminMetricsSets[0].payload.totalEnterprises).toBe(1);
  });
});

// ── emitCeoAlert ──────────────────────────────────────────────────────────────

describe('emitCeoAlert', () => {
  test('alert null -> throw', async () => {
    await expect(emitCeoAlert(null)).rejects.toThrow('alert_type_requerido');
  });
  test('sin type -> throw', async () => {
    await expect(emitCeoAlert({})).rejects.toThrow('alert_type_requerido');
  });
  test('type invalido -> throw', async () => {
    await expect(emitCeoAlert({ type: 'foo', message: 'x' })).rejects.toThrow('alert_type_invalido');
  });
  test('sin message -> throw', async () => {
    await expect(emitCeoAlert({ type: 'churn_risk' })).rejects.toThrow('message_requerido');
  });

  test('OK con level default (warning)', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await emitCeoAlert({ type: 'churn_risk', message: 'Acme inactiva 21d' });
    expect(r.level).toBe('warning');
    expect(r.alertId).toMatch(/^alt_/);
    expect(captures.alertSets[0].payload.resolved).toBe(false);
  });

  test('OK con level critical valido', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await emitCeoAlert({ type: 'billing_failure', message: 'Stripe down', level: 'critical' });
    expect(r.level).toBe('critical');
  });

  test('level invalido -> warning', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await emitCeoAlert({ type: 'churn_risk', message: 'X', level: 'extreme' });
    expect(r.level).toBe('warning');
  });

  test('message largo -> truncado a 500', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await emitCeoAlert({ type: 'churn_risk', message: 'x'.repeat(1000) });
    expect(captures.alertSets[0].payload.message.length).toBe(500);
  });

  test('OK con enterpriseId y payload', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await emitCeoAlert({ type: 'usage_spike', message: 'X', enterpriseId: 'ent_1', payload: { metric: 'tickets', value: 500 } });
    expect(captures.alertSets[0].payload.enterpriseId).toBe('ent_1');
    expect(captures.alertSets[0].payload.payload.metric).toBe('tickets');
  });

  test('OK sin enterpriseId/payload -> null', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await emitCeoAlert({ type: 'milestone_reached', message: 'X' });
    expect(captures.alertSets[0].payload.enterpriseId).toBeNull();
    expect(captures.alertSets[0].payload.payload).toBeNull();
  });
});

// ── listActiveAlerts ──────────────────────────────────────────────────────────

describe('listActiveAlerts', () => {
  test('sin alertas -> []', async () => {
    const { db } = makeDb({ alerts: {} });
    __setFirestoreForTests(db);
    expect(await listActiveAlerts()).toEqual([]);
  });

  test('filtra resueltas, ordena por level + fecha', async () => {
    const { db } = makeDb({
      alerts: {
        a1: { alertId: 'a1', level: 'warning', resolved: false, createdAt: '2026-05-01' },
        a2: { alertId: 'a2', level: 'critical', resolved: false, createdAt: '2026-05-02' },
        a3: { alertId: 'a3', level: 'info', resolved: false, createdAt: '2026-05-03' },
        a4: { alertId: 'a4', level: 'critical', resolved: true, createdAt: '2026-05-04' },
        a5: { alertId: 'a5', level: 'critical', resolved: false, createdAt: '2026-05-05' },
      },
    });
    __setFirestoreForTests(db);
    const r = await listActiveAlerts();
    expect(r).toHaveLength(4);
    expect(r[0].alertId).toBe('a5'); // critical, mas reciente
    expect(r[1].alertId).toBe('a2'); // critical, mas viejo
    expect(r[2].alertId).toBe('a1'); // warning
    expect(r[3].alertId).toBe('a3'); // info
  });

  test('limit > 200 -> capped a 200', async () => {
    const alertsObj = {};
    for (let i = 0; i < 300; i++) {
      alertsObj['a' + i] = { alertId: 'a' + i, level: 'info', resolved: false, createdAt: new Date().toISOString() };
    }
    const { db } = makeDb({ alerts: alertsObj });
    __setFirestoreForTests(db);
    const r = await listActiveAlerts({ limit: 1000 });
    expect(r).toHaveLength(200);
  });

  test('limit default 50', async () => {
    const alertsObj = {};
    for (let i = 0; i < 100; i++) {
      alertsObj['a' + i] = { alertId: 'a' + i, level: 'info', resolved: false, createdAt: new Date().toISOString() };
    }
    const { db } = makeDb({ alerts: alertsObj });
    __setFirestoreForTests(db);
    const r = await listActiveAlerts();
    expect(r).toHaveLength(50);
  });

  test('alerta con level no estandar -> ordenado al final', async () => {
    const { db } = makeDb({
      alerts: {
        a1: { alertId: 'a1', level: 'critical', resolved: false, createdAt: '2026-05-01' },
        a2: { alertId: 'a2', level: 'mega', resolved: false, createdAt: '2026-05-02' },
      },
    });
    __setFirestoreForTests(db);
    const r = await listActiveAlerts();
    expect(r[0].alertId).toBe('a1');
    expect(r[1].alertId).toBe('a2');
  });

  test('ambas alertas con level no estandar -> ordena por fecha desc', async () => {
    const { db } = makeDb({
      alerts: {
        a1: { alertId: 'a1', level: 'mega', resolved: false, createdAt: '2026-05-01' },
        a2: { alertId: 'a2', level: 'mega', resolved: false, createdAt: '2026-05-02' },
      },
    });
    __setFirestoreForTests(db);
    const r = await listActiveAlerts();
    expect(r[0].alertId).toBe('a2');
  });
});

// ── resolveAlert ──────────────────────────────────────────────────────────────

describe('resolveAlert', () => {
  test('alertId null -> throw', async () => {
    await expect(resolveAlert(null)).rejects.toThrow('alertId_requerido');
  });

  test('alerta no encontrada -> throw', async () => {
    const { db } = makeDb({ alerts: {} });
    __setFirestoreForTests(db);
    await expect(resolveAlert('alt_1')).rejects.toThrow('alerta_no_encontrada');
  });

  test('alerta ya resuelta -> throw', async () => {
    const { db } = makeDb({ alerts: { 'alt_1': { resolved: true } } });
    __setFirestoreForTests(db);
    await expect(resolveAlert('alt_1')).rejects.toThrow('alerta_ya_resuelta');
  });

  test('OK con resolvedBy y resolution', async () => {
    const { db, captures } = makeDb({ alerts: { 'alt_1': { resolved: false } } });
    __setFirestoreForTests(db);
    const r = await resolveAlert('alt_1', { resolvedBy: 'u_mariano', resolution: 'Contactamos al cliente' });
    expect(r.ok).toBe(true);
    expect(captures.alertSets[0].payload.resolved).toBe(true);
    expect(captures.alertSets[0].payload.resolvedBy).toBe('u_mariano');
    expect(captures.alertSets[0].payload.resolution).toBe('Contactamos al cliente');
  });

  test('OK sin opts -> resolvedBy/resolution null', async () => {
    const { db, captures } = makeDb({ alerts: { 'alt_1': { resolved: false } } });
    __setFirestoreForTests(db);
    await resolveAlert('alt_1');
    expect(captures.alertSets[0].payload.resolvedBy).toBeNull();
    expect(captures.alertSets[0].payload.resolution).toBeNull();
  });

  test('resolution larga -> truncada a 500', async () => {
    const { db, captures } = makeDb({ alerts: { 'alt_1': { resolved: false } } });
    __setFirestoreForTests(db);
    await resolveAlert('alt_1', { resolution: 'x'.repeat(1000) });
    expect(captures.alertSets[0].payload.resolution.length).toBe(500);
  });
});
