'use strict';

const {
  incrementMetric, getMetrics, getDailyBreakdown,
  METRIC_TYPES, PERIOD_TYPES, __setFirestoreForTests,
  _dayKey, _getPeriodRange,
} = require('../core/analytics_aggregator');

const UID = 'testUid1234567890abcdef';
const NOW = new Date('2026-05-01T12:00:00.000Z').getTime();

function makeMockDb({ docsMap = {}, throwGet = false, throwSet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
            },
          }),
          where: () => ({
            where: () => ({
              get: async () => {
                if (throwGet) throw new Error('get error');
                const docs = Object.entries(docsMap).map(([id, data]) => ({ id, data: () => data }));
                return { forEach: (fn) => docs.forEach(fn) };
              },
            }),
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('METRIC_TYPES y PERIOD_TYPES', () => {
  test('METRIC_TYPES es frozen con 8 metricas', () => {
    expect(Array.isArray(METRIC_TYPES)).toBe(true);
    expect(METRIC_TYPES.length).toBe(8);
    expect(() => { METRIC_TYPES.push('x'); }).toThrow();
  });
  test('PERIOD_TYPES es frozen con day/week/month', () => {
    expect(PERIOD_TYPES).toContain('day');
    expect(PERIOD_TYPES).toContain('week');
    expect(PERIOD_TYPES).toContain('month');
    expect(() => { PERIOD_TYPES.push('x'); }).toThrow();
  });
});

describe('_dayKey', () => {
  test('formatea fecha como YYYY-MM-DD', () => {
    expect(_dayKey(new Date('2026-05-01T00:00:00Z'))).toBe('2026-05-01');
    expect(_dayKey(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-31');
  });
  test('pad con 0 en mes y dia de un digito', () => {
    expect(_dayKey(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05');
  });
});

describe('_getPeriodRange', () => {
  test('day: start === end, days=1', () => {
    const now = new Date('2026-05-01T12:00:00Z');
    const r = _getPeriodRange('day', now);
    expect(r.days).toBe(1);
    expect(_dayKey(r.start)).toBe(_dayKey(now));
    expect(_dayKey(r.end)).toBe(_dayKey(now));
  });
  test('week: 7 dias', () => {
    const now = new Date('2026-05-01T12:00:00Z');
    const r = _getPeriodRange('week', now);
    expect(r.days).toBe(7);
    expect(_dayKey(r.start)).toBe('2026-04-25');
    expect(_dayKey(r.end)).toBe('2026-05-01');
  });
  test('month: 30 dias', () => {
    const now = new Date('2026-05-01T12:00:00Z');
    const r = _getPeriodRange('month', now);
    expect(r.days).toBe(30);
    expect(_dayKey(r.start)).toBe('2026-04-02');
    expect(_dayKey(r.end)).toBe('2026-05-01');
  });
});

describe('incrementMetric â€” validacion', () => {
  test('lanza si uid undefined', async () => {
    await expect(incrementMetric(undefined, 'messages_received')).rejects.toThrow('uid requerido');
  });
  test('lanza si metrica invalida', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(incrementMetric(UID, 'metrica_fake')).rejects.toThrow('metrica invalida');
  });
  test('lanza si value es 0', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(incrementMetric(UID, 'messages_received', 0)).rejects.toThrow('numero positivo');
  });
  test('lanza si value es negativo', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(incrementMetric(UID, 'messages_received', -1)).rejects.toThrow('numero positivo');
  });
  test('usa value=1 por default', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(incrementMetric(UID, 'messages_received', undefined, NOW)).resolves.toBeUndefined();
  });
  test('lanza si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(incrementMetric(UID, 'messages_received', 1, NOW)).rejects.toThrow('set error');
  });
});

describe('getMetrics â€” validacion', () => {
  test('lanza si uid undefined', async () => {
    await expect(getMetrics(undefined, 'day')).rejects.toThrow('uid requerido');
  });
  test('lanza si period invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getMetrics(UID, 'year')).rejects.toThrow('period invalido');
  });
});

describe('getMetrics â€” totales', () => {
  test('retorna ceros si no hay docs en Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ docsMap: {} }));
    const r = await getMetrics(UID, 'day', NOW);
    expect(r.uid).toBe(UID);
    expect(r.period).toBe('day');
    for (const m of METRIC_TYPES) expect(r.metrics[m]).toBe(0);
  });

  test('suma correctamente docs del periodo', async () => {
    const docsMap = {
      '2026-04-25': { messages_received: 10, messages_sent: 5 },
      '2026-04-26': { messages_received: 3, messages_sent: 2 },
    };
    __setFirestoreForTests(makeMockDb({ docsMap }));
    const r = await getMetrics(UID, 'week', NOW);
    expect(r.metrics.messages_received).toBe(13);
    expect(r.metrics.messages_sent).toBe(7);
    expect(r.metrics.contacts_new).toBe(0);
  });

  test('ignora campos que no son number', async () => {
    const docsMap = {
      '2026-05-01': { messages_received: 5, updatedAt: '2026-05-01T12:00:00Z' },
    };
    __setFirestoreForTests(makeMockDb({ docsMap }));
    const r = await getMetrics(UID, 'day', NOW);
    expect(r.metrics.messages_received).toBe(5);
  });

  test('fail-open si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getMetrics(UID, 'day', NOW);
    expect(r.uid).toBe(UID);
    for (const m of METRIC_TYPES) expect(r.metrics[m]).toBe(0);
  });

  test('retorna startDate y endDate correctas para week', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getMetrics(UID, 'week', NOW);
    expect(r.startDate).toBe('2026-04-25');
    expect(r.endDate).toBe('2026-05-01');
    expect(r.days).toBe(7);
  });

  test('retorna startDate y endDate correctas para month', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getMetrics(UID, 'month', NOW);
    expect(r.startDate).toBe('2026-04-02');
    expect(r.endDate).toBe('2026-05-01');
    expect(r.days).toBe(30);
  });
});

describe('getDailyBreakdown', () => {
  test('lanza si uid undefined', async () => {
    await expect(getDailyBreakdown(undefined, 7)).rejects.toThrow('uid requerido');
  });
  test('lanza si nDays es 0', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getDailyBreakdown(UID, 0)).rejects.toThrow('entre 1 y 365');
  });
  test('lanza si nDays > 365', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getDailyBreakdown(UID, 366)).rejects.toThrow('entre 1 y 365');
  });
  test('usa 7 dias por default', async () => {
    __setFirestoreForTests(makeMockDb({ docsMap: {} }));
    const r = await getDailyBreakdown(UID, undefined, NOW);
    expect(r.length).toBe(7);
  });
  test('retorna array con un item por dia', async () => {
    __setFirestoreForTests(makeMockDb({ docsMap: {} }));
    const r = await getDailyBreakdown(UID, 3, NOW);
    expect(r.length).toBe(3);
    expect(r[0].date).toBe('2026-04-29');
    expect(r[1].date).toBe('2026-04-30');
    expect(r[2].date).toBe('2026-05-01');
  });
  test('rellena 0 para dias sin datos', async () => {
    __setFirestoreForTests(makeMockDb({ docsMap: {} }));
    const r = await getDailyBreakdown(UID, 3, NOW);
    for (const day of r) {
      for (const m of METRIC_TYPES) expect(day.metrics[m]).toBe(0);
    }
  });
  test('incluye datos de Firestore en dias correspondientes', async () => {
    const docsMap = {
      '2026-04-30': { messages_received: 42, messages_sent: 10 },
    };
    __setFirestoreForTests(makeMockDb({ docsMap }));
    const r = await getDailyBreakdown(UID, 3, NOW);
    const apr30 = r.find(d => d.date === '2026-04-30');
    expect(apr30).toBeDefined();
    expect(apr30.metrics.messages_received).toBe(42);
    expect(apr30.metrics.messages_sent).toBe(10);
    const may01 = r.find(d => d.date === '2026-05-01');
    expect(may01.metrics.messages_received).toBe(0);
  });
  test('fail-open retorna array vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getDailyBreakdown(UID, 7, NOW);
    expect(r).toEqual([]);
  });
});
