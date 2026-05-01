'use strict';

const {
  getPeriodKey, isValidMetric, recordGrowthEvent, getGrowthPeriod,
  calculateConversionRate, calculateRetentionRate, buildGrowthSummary,
  GROWTH_METRICS, PERIOD_TYPES, DEFAULT_PERIOD,
  __setFirestoreForTests,
} = require('../core/growth_tracker');

const UID = 'testUid1234567890';

function makeMockDb({ existingData = null, throwGet = false, throwSet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              if (!existingData) return { exists: false, data: () => ({}) };
              return { exists: true, data: () => existingData };
            },
            set: async () => { if (throwSet) throw new Error('set error'); },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('GROWTH_METRICS / PERIOD_TYPES / DEFAULT_PERIOD', () => {
  test('tiene metricas comunes', () => {
    expect(GROWTH_METRICS).toContain('new_leads');
    expect(GROWTH_METRICS).toContain('converted_leads');
    expect(GROWTH_METRICS).toContain('broadcast_reach');
  });
  test('GROWTH_METRICS es frozen', () => {
    expect(() => { GROWTH_METRICS.push('extra'); }).toThrow();
  });
  test('PERIOD_TYPES tiene daily weekly monthly', () => {
    expect(PERIOD_TYPES).toContain('daily');
    expect(PERIOD_TYPES).toContain('weekly');
    expect(PERIOD_TYPES).toContain('monthly');
  });
  test('DEFAULT_PERIOD es weekly', () => {
    expect(DEFAULT_PERIOD).toBe('weekly');
  });
});

describe('getPeriodKey', () => {
  test('lanza si periodType invalido', () => {
    expect(() => getPeriodKey('yearly')).toThrow('periodType invalido');
  });
  test('daily retorna YYYY-MM-DD', () => {
    const key = getPeriodKey('daily', '2026-05-04T15:00:00Z');
    expect(key).toBe('2026-05-04');
  });
  test('monthly retorna YYYY-MM', () => {
    const key = getPeriodKey('monthly', '2026-05-04T15:00:00Z');
    expect(key).toBe('2026-05');
  });
  test('weekly retorna YYYY-WNN', () => {
    const key = getPeriodKey('weekly', '2026-05-04T15:00:00Z');
    expect(key).toMatch(/^2026-W\d{2}$/);
  });
});

describe('isValidMetric', () => {
  test('true para metricas validas', () => {
    expect(isValidMetric('new_leads')).toBe(true);
    expect(isValidMetric('referrals_sent')).toBe(true);
  });
  test('false para metrica invalida', () => {
    expect(isValidMetric('ventas_invisibles')).toBe(false);
  });
});

describe('recordGrowthEvent', () => {
  test('lanza si uid undefined', async () => {
    await expect(recordGrowthEvent(undefined, 'new_leads')).rejects.toThrow('uid requerido');
  });
  test('lanza si metric invalida', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordGrowthEvent(UID, 'falsa')).rejects.toThrow('metric invalida');
  });
  test('registra sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordGrowthEvent(UID, 'new_leads', 3, 'daily')).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordGrowthEvent(UID, 'new_leads')).rejects.toThrow('set error');
  });
});

describe('getGrowthPeriod', () => {
  test('lanza si uid undefined', async () => {
    await expect(getGrowthPeriod(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna metricas vacias si no hay datos', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getGrowthPeriod(UID, 'daily');
    expect(r.metrics).toEqual({});
  });
  test('retorna datos guardados', async () => {
    __setFirestoreForTests(makeMockDb({ existingData: { new_leads: 5, converted_leads: 2 } }));
    const r = await getGrowthPeriod(UID, 'daily');
    expect(r.metrics.new_leads).toBe(5);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getGrowthPeriod(UID, 'daily');
    expect(r.metrics).toEqual({});
  });
});

describe('calculateConversionRate', () => {
  test('lanza si newLeads invalido', () => {
    expect(() => calculateConversionRate(-1, 0)).toThrow('newLeads invalido');
  });
  test('retorna 0 si newLeads es 0', () => {
    expect(calculateConversionRate(0, 0)).toBe(0);
  });
  test('calcula tasa correctamente', () => {
    expect(calculateConversionRate(100, 25)).toBe(25);
  });
  test('max 100% conversion', () => {
    expect(calculateConversionRate(10, 10)).toBe(100);
  });
});

describe('calculateRetentionRate', () => {
  test('lanza si totalContacts <= 0', () => {
    expect(() => calculateRetentionRate(0, 5)).toThrow('totalContacts invalido');
  });
  test('calcula retencion correctamente', () => {
    expect(calculateRetentionRate(100, 40)).toBe(40);
  });
});

describe('buildGrowthSummary', () => {
  test('retorna ceros para datos vacios', () => {
    const r = buildGrowthSummary({});
    expect(r.conversionRate).toBe(0);
    expect(r.totalActivity).toBe(0);
  });
  test('calcula correctamente con datos reales', () => {
    const r = buildGrowthSummary({ new_leads: 100, converted_leads: 30, returning_contacts: 50, messages_total: 500 });
    expect(r.conversionRate).toBe(30);
    expect(r.retentionRate).toBe(50);
    expect(r.totalActivity).toBe(500);
  });
  test('retorna ceros para undefined', () => {
    const r = buildGrowthSummary(undefined);
    expect(r.conversionRate).toBe(0);
  });
});
