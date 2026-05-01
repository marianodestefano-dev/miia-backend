'use strict';

const {
  recordMetric, getMetricSummary, getDashboard, compareMetrics,
  METRIC_TYPES, PERIOD_TYPES, DEFAULT_PERIOD, MAX_HISTORY_DAYS,
  __setFirestoreForTests,
} = require('../core/analytics_dashboard');

const UID = 'testUid1234567890';
const NOW = new Date('2026-05-04T15:00:00.000Z').getTime();

function makeEvent(metricType, value, daysAgo) {
  const recordedAt = new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return { metricType, value, recordedAt, dateKey: recordedAt.slice(0, 10) };
}

function makeMockDb({ events = [], throwSet = false } = {}) {
  const eventsMap = {};
  events.forEach((e, i) => { eventsMap['ev' + i] = e; });

  const filterByType = (type, fromDate) =>
    Object.entries(eventsMap)
      .filter(([, e]) => e.metricType === type && e.recordedAt >= fromDate)
      .map(([id, e]) => ({ id, data: () => e }));

  const eventDoc = {
    set: async (data) => { if (throwSet) throw new Error('set error'); },
  };
  const eventsColl = {
    doc: () => eventDoc,
    where: (field, op, val) => ({
      where: (f2, op2, val2) => ({
        get: async () => {
          const filtered = filterByType(val, val2);
          return { forEach: fn => filtered.forEach(fn) };
        },
      }),
    }),
  };
  const analyticsDoc = { collection: () => eventsColl };
  return { collection: () => ({ doc: () => analyticsDoc }) };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('METRIC_TYPES y constants', () => {
  test('incluye messages_received y new_leads', () => {
    expect(METRIC_TYPES).toContain('messages_received');
    expect(METRIC_TYPES).toContain('new_leads');
  });
  test('es frozen', () => {
    expect(() => { METRIC_TYPES.push('x'); }).toThrow();
  });
  test('PERIOD_TYPES incluye day week month quarter', () => {
    expect(PERIOD_TYPES).toContain('day');
    expect(PERIOD_TYPES).toContain('week');
    expect(PERIOD_TYPES).toContain('month');
    expect(PERIOD_TYPES).toContain('quarter');
  });
  test('DEFAULT_PERIOD es week', () => {
    expect(DEFAULT_PERIOD).toBe('week');
  });
  test('MAX_HISTORY_DAYS es 90', () => {
    expect(MAX_HISTORY_DAYS).toBe(90);
  });
});

describe('recordMetric', () => {
  test('lanza si uid undefined', async () => {
    await expect(recordMetric(undefined, 'new_leads')).rejects.toThrow('uid requerido');
  });
  test('lanza si metricType undefined', async () => {
    await expect(recordMetric(UID, undefined)).rejects.toThrow('metricType requerido');
  });
  test('lanza si metricType invalido', async () => {
    await expect(recordMetric(UID, 'metrica_falsa')).rejects.toThrow('metricType invalido');
  });
  test('registra sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordMetric(UID, 'new_leads', 1)).resolves.toBeUndefined();
  });
  test('registra con value default 1', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordMetric(UID, 'messages_received')).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordMetric(UID, 'new_leads')).rejects.toThrow('set error');
  });
});


describe('getMetricSummary', () => {
  test('lanza si uid undefined', async () => {
    await expect(getMetricSummary(undefined, 'new_leads')).rejects.toThrow('uid requerido');
  });
  test('lanza si metricType invalido', async () => {
    await expect(getMetricSummary(UID, 'falso')).rejects.toThrow('metricType invalido');
  });
  test('retorna zeros si sin eventos', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getMetricSummary(UID, 'new_leads', 'week', NOW);
    expect(r.total).toBe(0);
    expect(r.count).toBe(0);
    expect(r.average).toBe(0);
  });
  test('suma valores del periodo', async () => {
    const events = [
      makeEvent('new_leads', 3, 1),
      makeEvent('new_leads', 5, 3),
      makeEvent('new_leads', 2, 30),
    ];
    __setFirestoreForTests(makeMockDb({ events }));
    const r = await getMetricSummary(UID, 'new_leads', 'week', NOW);
    expect(r.total).toBe(8);
    expect(r.count).toBe(2);
    expect(r.average).toBe(4);
  });
  test('usa DEFAULT_PERIOD si period invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getMetricSummary(UID, 'new_leads', 'invalid_period', NOW);
    expect(r.period).toBe(DEFAULT_PERIOD);
  });
  test('fail-open retorna zeros si Firestore falla', async () => {
    __setFirestoreForTests({
      collection: () => ({
        doc: () => ({
          collection: () => ({
            where: () => ({ where: () => ({ get: async () => { throw new Error('err'); } }) }),
          }),
        }),
      }),
    });
    const r = await getMetricSummary(UID, 'new_leads', 'week', NOW);
    expect(r.total).toBe(0);
  });
});

describe('getDashboard', () => {
  test('lanza si uid undefined', async () => {
    await expect(getDashboard(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna dashboard con todas las metricas', async () => {
    __setFirestoreForTests(makeMockDb());
    const d = await getDashboard(UID, 'week', NOW);
    expect(d.uid).toBe(UID);
    expect(d.period).toBe('week');
    expect(d.metrics).toBeDefined();
    expect(d.summary).toBeDefined();
    for (const m of METRIC_TYPES) {
      expect(d.metrics[m]).toBeDefined();
    }
  });
  test('summary tiene campos correctos', async () => {
    __setFirestoreForTests(makeMockDb());
    const d = await getDashboard(UID, 'day', NOW);
    expect(d.summary).toHaveProperty('totalMessages');
    expect(d.summary).toHaveProperty('newLeads');
    expect(d.summary).toHaveProperty('totalRevenue');
    expect(d.summary).toHaveProperty('engagementRate');
  });
  test('engagementRate es 0 si sin mensajes recibidos', async () => {
    __setFirestoreForTests(makeMockDb());
    const d = await getDashboard(UID, 'day', NOW);
    expect(d.summary.engagementRate).toBe(0);
  });
});

describe('compareMetrics', () => {
  test('lanza si uid undefined', async () => {
    await expect(compareMetrics(undefined, 'new_leads')).rejects.toThrow('uid requerido');
  });
  test('lanza si metricType invalido', async () => {
    await expect(compareMetrics(UID, 'falso')).rejects.toThrow('metricType invalido');
  });
  test('retorna current, previous, change y changePercent', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await compareMetrics(UID, 'new_leads', 'week', NOW);
    expect(r).toHaveProperty('current');
    expect(r).toHaveProperty('previous');
    expect(r).toHaveProperty('change');
    expect(r).toHaveProperty('changePercent');
  });
  test('change = 0 si sin datos', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await compareMetrics(UID, 'new_leads', 'day', NOW);
    expect(r.change).toBe(0);
    expect(r.changePercent).toBe(0);
  });
});
