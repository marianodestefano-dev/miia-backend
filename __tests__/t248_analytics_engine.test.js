'use strict';

const {
  buildMetricRecord, saveMetric, incrementMetric, getMetrics,
  computeConversionRate, computeResponseTimeAvg,
  buildDailyReport, buildWeeklyReport, buildReportSummaryText, detectAnomalies,
  isValidMetric, isValidPeriod,
  METRIC_TYPES, REPORT_PERIODS, MAX_DATAPOINTS, CONVERSION_RATE_THRESHOLD,
  __setFirestoreForTests,
} = require('../core/analytics_engine');

const UID = 'testUid1234567890';
const TODAY = new Date().toISOString().slice(0, 10);

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
          get: async () => {
            if (throwGet) throw new Error('get error');
            return {
              forEach: fn => Object.entries(db_stored).forEach(([id, data]) => fn({ data: () => data })),
            };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

describe('Constantes', () => {
  test('METRIC_TYPES tiene 10', () => { expect(METRIC_TYPES.length).toBe(10); });
  test('frozen METRIC_TYPES', () => { expect(() => { METRIC_TYPES.push('x'); }).toThrow(); });
  test('REPORT_PERIODS tiene 4', () => { expect(REPORT_PERIODS.length).toBe(4); });
  test('frozen REPORT_PERIODS', () => { expect(() => { REPORT_PERIODS.push('x'); }).toThrow(); });
  test('MAX_DATAPOINTS es 90', () => { expect(MAX_DATAPOINTS).toBe(90); });
  test('CONVERSION_RATE_THRESHOLD es 0.05', () => { expect(CONVERSION_RATE_THRESHOLD).toBe(0.05); });
});

describe('isValidMetric / isValidPeriod', () => {
  test('messages_total es metrica valida', () => { expect(isValidMetric('messages_total')).toBe(true); });
  test('revenue_total es metrica valida', () => { expect(isValidMetric('revenue_total')).toBe(true); });
  test('page_views no es valida', () => { expect(isValidMetric('page_views')).toBe(false); });
  test('daily es period valido', () => { expect(isValidPeriod('daily')).toBe(true); });
  test('yearly no es valido', () => { expect(isValidPeriod('yearly')).toBe(false); });
});

describe('buildMetricRecord', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildMetricRecord(undefined, 'leads_new', 5)).toThrow('uid requerido');
  });
  test('lanza si metric invalido', () => {
    expect(() => buildMetricRecord(UID, 'invalid', 5)).toThrow('metric invalido');
  });
  test('lanza si value no es numero', () => {
    expect(() => buildMetricRecord(UID, 'leads_new', 'cinco')).toThrow('value debe ser numero');
  });
  test('construye record correctamente', () => {
    const r = buildMetricRecord(UID, 'leads_new', 10, { date: '2026-05-01' });
    expect(r.recordId).toContain('leads_new');
    expect(r.recordId).toContain('2026-05-01');
    expect(r.uid).toBe(UID);
    expect(r.metric).toBe('leads_new');
    expect(r.value).toBe(10);
    expect(r.period).toBe('daily');
  });
  test('period invalido cae a daily', () => {
    const r = buildMetricRecord(UID, 'leads_new', 5, { period: 'hourly' });
    expect(r.period).toBe('daily');
  });
  test('acepta value = 0', () => {
    const r = buildMetricRecord(UID, 'spam_blocked', 0);
    expect(r.value).toBe(0);
  });
});

describe('saveMetric', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveMetric(undefined, { recordId: 'x' })).rejects.toThrow('uid requerido');
  });
  test('lanza si record invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveMetric(UID, null)).rejects.toThrow('record invalido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = buildMetricRecord(UID, 'messages_total', 150);
    const id = await saveMetric(UID, r);
    expect(id).toBe(r.recordId);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const r = buildMetricRecord(UID, 'leads_new', 5);
    await expect(saveMetric(UID, r)).rejects.toThrow('set error');
  });
});

describe('incrementMetric', () => {
  test('lanza si uid undefined', async () => {
    await expect(incrementMetric(undefined, 'leads_new')).rejects.toThrow('uid requerido');
  });
  test('lanza si metric invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(incrementMetric(UID, 'bad_metric')).rejects.toThrow('metric invalido');
  });
  test('incrementa desde 0 por defecto', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await incrementMetric(UID, 'leads_new', 3);
    expect(r.value).toBe(3);
  });
  test('fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await incrementMetric(UID, 'leads_new', 1);
    expect(r).toBeNull();
  });
});

describe('getMetrics', () => {
  test('lanza si uid undefined', async () => {
    await expect(getMetrics(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna vacio si no hay metricas', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getMetrics(UID)).toEqual([]);
  });
  test('filtra por metric', async () => {
    const stored = {
      'r1': buildMetricRecord(UID, 'leads_new', 5, { date: '2026-05-01' }),
      'r2': buildMetricRecord(UID, 'messages_total', 100, { date: '2026-05-01' }),
    };
    __setFirestoreForTests(makeMockDb({ stored }));
    const r = await getMetrics(UID, { metric: 'leads_new' });
    expect(r.length).toBe(1);
    expect(r[0].metric).toBe('leads_new');
  });
  test('filtra por dateFrom y dateTo', async () => {
    const stored = {
      'r1': buildMetricRecord(UID, 'leads_new', 5, { date: '2026-04-01' }),
      'r2': buildMetricRecord(UID, 'leads_new', 8, { date: '2026-05-01' }),
      'r3': buildMetricRecord(UID, 'leads_new', 3, { date: '2026-06-01' }),
    };
    __setFirestoreForTests(makeMockDb({ stored }));
    const r = await getMetrics(UID, { dateFrom: '2026-04-15', dateTo: '2026-05-31' });
    expect(r.length).toBe(1);
    expect(r[0].value).toBe(8);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getMetrics(UID)).toEqual([]);
  });
});

describe('computeConversionRate', () => {
  test('0 leads retorna 0', () => { expect(computeConversionRate(0, 0)).toBe(0); });
  test('calcula correctamente', () => { expect(computeConversionRate(100, 10)).toBe(0.1); });
  test('redondea a 2 decimales', () => { expect(computeConversionRate(3, 1)).toBe(0.33); });
  test('100% conversion', () => { expect(computeConversionRate(5, 5)).toBe(1); });
});

describe('computeResponseTimeAvg', () => {
  test('array vacio retorna 0', () => { expect(computeResponseTimeAvg([])).toBe(0); });
  test('null retorna 0', () => { expect(computeResponseTimeAvg(null)).toBe(0); });
  test('calcula promedio', () => { expect(computeResponseTimeAvg([60, 120, 90])).toBe(90); });
  test('ignora valores negativos', () => { expect(computeResponseTimeAvg([60, -10, 90])).toBe(75); });
  test('array de un elemento', () => { expect(computeResponseTimeAvg([45])).toBe(45); });
});

describe('buildDailyReport', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildDailyReport(undefined, [], '2026-05-01')).toThrow('uid requerido');
  });
  test('construye reporte vacio', () => {
    const r = buildDailyReport(UID, [], '2026-05-01');
    expect(r.uid).toBe(UID);
    expect(r.date).toBe('2026-05-01');
    expect(r.period).toBe('daily');
    expect(r.conversionRate).toBe(0);
  });
  test('incluye metricas del dia correcto', () => {
    const metrics = [
      buildMetricRecord(UID, 'leads_new', 10, { date: '2026-05-01' }),
      buildMetricRecord(UID, 'messages_total', 200, { date: '2026-05-01' }),
      buildMetricRecord(UID, 'leads_new', 5, { date: '2026-05-02' }),
    ];
    const r = buildDailyReport(UID, metrics, '2026-05-01');
    expect(r.metrics.leads_new).toBe(10);
    expect(r.metrics.messages_total).toBe(200);
    expect(r.metrics.leads_new).not.toBe(5);
  });
  test('calcula conversion rate', () => {
    const metrics = [
      buildMetricRecord(UID, 'leads_new', 20, { date: '2026-05-01' }),
      buildMetricRecord(UID, 'leads_converted', 4, { date: '2026-05-01' }),
    ];
    const r = buildDailyReport(UID, metrics, '2026-05-01');
    expect(r.conversionRate).toBe(0.2);
  });
});

describe('buildWeeklyReport', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildWeeklyReport(undefined, [])).toThrow('uid requerido');
  });
  test('construye reporte semanal', () => {
    const metrics = [
      buildMetricRecord(UID, 'leads_new', 10, { date: '2026-05-01' }),
      buildMetricRecord(UID, 'leads_new', 8, { date: '2026-05-02' }),
    ];
    const r = buildWeeklyReport(UID, metrics, '2026-04-30');
    expect(r.period).toBe('weekly');
    expect(r.totals.leads_new).toBe(18);
    expect(r.daysWithData).toBe(2);
  });
});

describe('buildReportSummaryText', () => {
  test('retorna vacio si null', () => { expect(buildReportSummaryText(null)).toBe(''); });
  test('reporte diario incluye metricas clave', () => {
    const metrics = [
      buildMetricRecord(UID, 'leads_new', 15, { date: '2026-05-01' }),
      buildMetricRecord(UID, 'messages_total', 300, { date: '2026-05-01' }),
    ];
    const report = buildDailyReport(UID, metrics, '2026-05-01');
    const text = buildReportSummaryText(report);
    expect(text).toContain('15');
    expect(text).toContain('300');
    expect(text).toContain('Diario');
  });
  test('reporte semanal menciona totals', () => {
    const metrics = [buildMetricRecord(UID, 'broadcasts_sent', 5, { date: '2026-05-01' })];
    const report = buildWeeklyReport(UID, metrics, '2026-04-30');
    const text = buildReportSummaryText(report);
    expect(text).toContain('Semanal');
    expect(text).toContain('5');
  });
});

describe('detectAnomalies', () => {
  test('retorna vacio si datos null', () => {
    expect(detectAnomalies(null, {})).toEqual([]);
  });
  test('no detecta si avg es 0', () => {
    const r = detectAnomalies({ leads_new: 10 }, { leads_new: 0 });
    expect(r.length).toBe(0);
  });
  test('detecta spike (valor mucho mayor al avg)', () => {
    const r = detectAnomalies({ leads_new: 100 }, { leads_new: 10 }, { leads_new: 1.5 });
    expect(r.length).toBe(1);
    expect(r[0].metric).toBe('leads_new');
    expect(r[0].direction).toBe('spike');
  });
  test('detecta drop (valor mucho menor al avg)', () => {
    const r = detectAnomalies({ messages_total: 10 }, { messages_total: 200 }, { messages_total: 0.5 });
    expect(r.length).toBe(1);
    expect(r[0].direction).toBe('drop');
  });
  test('no detecta anomalia dentro del threshold', () => {
    const r = detectAnomalies({ leads_new: 12 }, { leads_new: 10 }, { leads_new: 2.0 });
    expect(r.length).toBe(0);
  });
});
