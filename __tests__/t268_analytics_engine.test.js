'use strict';

// T268 analytics_engine — suite completa
const {
  buildMetricRecord,
  buildReportRecord,
  aggregateMetrics,
  computeKPIs,
  buildInsights,
  saveMetric,
  saveReport,
  getReport,
  listMetrics,
  buildReportText,
  METRIC_TYPES,
  REPORT_TYPES,
  AGGREGATION_PERIODS,
  MAX_DATA_POINTS,
  __setFirestoreForTests: setDb,
} = require('../core/analytics_engine');

const UID = 'analytics268Uid';
const DATE = '2026-06-01';

function makeMockDb({ stored = {}, metStored = {}, throwGet = false, throwSet = false } = {}) {
  const db_stored = { ...stored };
  const met_stored = { ...metStored };
  return {
    collection: () => ({
      doc: () => ({
        collection: (subCol) => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              const target = subCol === 'metrics' ? met_stored : db_stored;
              target[id] = opts && opts.merge ? { ...(target[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              const target = subCol === 'metrics' ? met_stored : db_stored;
              return { exists: !!target[id], data: () => target[id] };
            },
          }),
          where: (field, op, val) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const target = subCol === 'metrics' ? met_stored : db_stored;
              const entries = Object.values(target).filter(d => d && d[field] === val);
              return { empty: entries.length === 0, forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            const target = subCol === 'metrics' ? met_stored : db_stored;
            return { empty: Object.keys(target).length === 0, forEach: fn => Object.values(target).forEach(d => fn({ data: () => d })) };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => setDb(null));
afterEach(() => setDb(null));

// ─── CONSTANTES ──────────────────────────────────────────────────────────────
describe('analytics_engine — constantes', () => {
  test('METRIC_TYPES incluye tipos clave', () => {
    ['messages_received', 'leads_created', 'appointments_booked', 'payments_received', 'revenue_total'].forEach(t =>
      expect(METRIC_TYPES).toContain(t)
    );
  });
  test('REPORT_TYPES incluye daily, weekly, monthly', () => {
    ['daily', 'weekly', 'monthly', 'custom'].forEach(t => expect(REPORT_TYPES).toContain(t));
  });
  test('AGGREGATION_PERIODS incluye day y month', () => {
    ['hour', 'day', 'week', 'month'].forEach(p => expect(AGGREGATION_PERIODS).toContain(p));
  });
  test('MAX_DATA_POINTS es 1000', () => {
    expect(MAX_DATA_POINTS).toBe(1000);
  });
});

// ─── buildMetricRecord ────────────────────────────────────────────────────────
describe('buildMetricRecord', () => {
  test('construye metrica correctamente', () => {
    const m = buildMetricRecord(UID, 'messages_received', 42, { date: DATE });
    expect(m.uid).toBe(UID);
    expect(m.metricType).toBe('messages_received');
    expect(m.value).toBe(42);
    expect(m.date).toBe(DATE);
    expect(m.period).toBe('day');
    expect(m.tags).toEqual([]);
  });
  test('metricType invalido lanza error', () => {
    expect(() => buildMetricRecord(UID, 'fake_metric', 10)).toThrow('metricType invalido');
  });
  test('value no numerico lanza error', () => {
    expect(() => buildMetricRecord(UID, 'messages_received', 'diez')).toThrow('value debe ser numero');
  });
  test('value Infinity lanza error', () => {
    expect(() => buildMetricRecord(UID, 'messages_received', Infinity)).toThrow('value debe ser numero');
  });
  test('period invalido cae a day', () => {
    const m = buildMetricRecord(UID, 'leads_created', 5, { period: 'quarter' });
    expect(m.period).toBe('day');
  });
  test('tags se guardan y limitan a 10', () => {
    const manyTags = Array.from({ length: 15 }, (_, i) => 'tag' + i);
    const m = buildMetricRecord(UID, 'leads_created', 3, { tags: manyTags });
    expect(m.tags.length).toBe(10);
  });
  test('metricId se puede forzar', () => {
    const m = buildMetricRecord(UID, 'revenue_total', 1000, { metricId: 'metric_custom_001' });
    expect(m.metricId).toBe('metric_custom_001');
  });
});

// ─── buildReportRecord ────────────────────────────────────────────────────────
describe('buildReportRecord', () => {
  test('construye reporte correctamente', () => {
    const r = buildReportRecord(UID, 'daily', { date: DATE, title: 'Reporte Diario Junio' });
    expect(r.uid).toBe(UID);
    expect(r.reportType).toBe('daily');
    expect(r.date).toBe(DATE);
    expect(r.title).toBe('Reporte Diario Junio');
    expect(r.metrics).toEqual({});
    expect(r.insights).toEqual([]);
  });
  test('reportType invalido lanza error', () => {
    expect(() => buildReportRecord(UID, 'quarterly', { date: DATE })).toThrow('reportType invalido');
  });
  test('title se trunca a MAX=120', () => {
    const r = buildReportRecord(UID, 'monthly', { title: 'T'.repeat(200) });
    expect(r.title.length).toBe(120);
  });
  test('insights se limitan a 20', () => {
    const manyInsights = Array.from({ length: 25 }, (_, i) => ({ type: 'neutral', message: 'insight ' + i }));
    const r = buildReportRecord(UID, 'weekly', { insights: manyInsights });
    expect(r.insights.length).toBe(20);
  });
  test('fromDate y toDate se guardan', () => {
    const r = buildReportRecord(UID, 'custom', { fromDate: '2026-05-01', toDate: '2026-05-31' });
    expect(r.fromDate).toBe('2026-05-01');
    expect(r.toDate).toBe('2026-05-31');
  });
  test('reportId se puede forzar', () => {
    const r = buildReportRecord(UID, 'daily', { reportId: 'report_custom_001' });
    expect(r.reportId).toBe('report_custom_001');
  });
});

// ─── aggregateMetrics ─────────────────────────────────────────────────────────
describe('aggregateMetrics', () => {
  const metrics = [
    buildMetricRecord(UID, 'messages_received', 100, { date: '2026-06-01' }),
    buildMetricRecord(UID, 'messages_received', 80, { date: '2026-06-02' }),
    buildMetricRecord(UID, 'leads_created', 5, { date: '2026-06-01' }),
    buildMetricRecord(UID, 'leads_created', 3, { date: '2026-06-02' }),
  ];
  metrics.forEach((m, i) => { m.metricId = 'metric_' + i; });

  test('sin filtro suma todos los valores', () => {
    const r = aggregateMetrics(metrics);
    expect(r.count).toBe(4);
    expect(r.sum).toBe(188);
  });
  test('filtra por type', () => {
    const r = aggregateMetrics(metrics, { type: 'messages_received' });
    expect(r.count).toBe(2);
    expect(r.sum).toBe(180);
    expect(r.avg).toBe(90);
  });
  test('calcula min y max', () => {
    const r = aggregateMetrics(metrics, { type: 'messages_received' });
    expect(r.min).toBe(80);
    expect(r.max).toBe(100);
  });
  test('byType agrupa correctamente', () => {
    const r = aggregateMetrics(metrics);
    expect(r.byType['messages_received'].sum).toBe(180);
    expect(r.byType['leads_created'].sum).toBe(8);
    expect(r.byType['leads_created'].count).toBe(2);
  });
  test('array vacio retorna ceros', () => {
    const r = aggregateMetrics([]);
    expect(r.sum).toBe(0);
    expect(r.count).toBe(0);
  });
  test('null retorna ceros', () => {
    const r = aggregateMetrics(null);
    expect(r.sum).toBe(0);
  });
});

// ─── computeKPIs ─────────────────────────────────────────────────────────────
describe('computeKPIs', () => {
  test('calcula todos los KPIs correctamente', () => {
    const kpis = computeKPIs({ leads: 100, converted: 25, revenue: 50000, messages: 300, appointments: 40 });
    expect(kpis.conversionRate).toBe(25);
    expect(kpis.revenuePerLead).toBe(500);
    expect(kpis.revenuePerConversion).toBe(2000);
    expect(kpis.messagesPerLead).toBe(3);
    expect(kpis.appointmentsPerLead).toBe(0.4);
  });
  test('sin leads retorna ceros', () => {
    const kpis = computeKPIs({ leads: 0, revenue: 1000 });
    expect(kpis.conversionRate).toBe(0);
    expect(kpis.revenuePerLead).toBe(0);
  });
  test('datos vacios retorna ceros', () => {
    const kpis = computeKPIs({});
    expect(kpis.conversionRate).toBe(0);
    expect(kpis.leads).toBe(0);
  });
  test('conversion rate no supera 100', () => {
    const kpis = computeKPIs({ leads: 10, converted: 10, revenue: 0 });
    expect(kpis.conversionRate).toBe(100);
  });
  test('null data retorna ceros', () => {
    const kpis = computeKPIs(null);
    expect(kpis.leads).toBe(0);
  });
});

// ─── buildInsights ────────────────────────────────────────────────────────────
describe('buildInsights', () => {
  test('conversion alta genera insight positive', () => {
    const kpis = computeKPIs({ leads: 100, converted: 35, revenue: 50000 });
    const insights = buildInsights(kpis);
    expect(insights.some(i => i.type === 'positive' && i.message.includes('excelente'))).toBe(true);
  });
  test('conversion baja genera insight warning', () => {
    const kpis = computeKPIs({ leads: 100, converted: 3, revenue: 1000 });
    const insights = buildInsights(kpis);
    expect(insights.some(i => i.type === 'warning')).toBe(true);
  });
  test('revenue por lead bajo genera warning', () => {
    const kpis = computeKPIs({ leads: 100, converted: 20, revenue: 500 });
    const insights = buildInsights(kpis, { minRevenuePerLead: 100 });
    expect(insights.some(i => i.type === 'warning' && i.message.toLowerCase().includes('revenue'))).toBe(true);
  });
  test('muchos mensajes por lead genera warning', () => {
    const kpis = computeKPIs({ leads: 10, converted: 2, revenue: 1000, messages: 300 });
    const insights = buildInsights(kpis);
    expect(insights.some(i => i.message.includes('mensajes'))).toBe(true);
  });
  test('kpis perfectos solo genera positivos', () => {
    const kpis = computeKPIs({ leads: 100, converted: 50, revenue: 50000, messages: 500 });
    const insights = buildInsights(kpis, { minRevenuePerLead: 100 });
    expect(insights.every(i => i.type === 'positive' || i.type === 'neutral')).toBe(true);
  });
});

// ─── saveMetric + listMetrics ─────────────────────────────────────────────────
describe('saveMetric + listMetrics', () => {
  test('round-trip exitoso', async () => {
    const db = makeMockDb();
    setDb(db);
    const m = buildMetricRecord(UID, 'messages_received', 42, { date: DATE });
    const savedId = await saveMetric(UID, m);
    expect(savedId).toBe(m.metricId);
    const metrics = await listMetrics(UID);
    expect(metrics.length).toBe(1);
    expect(metrics[0].value).toBe(42);
  });
  test('filtra por metricType', async () => {
    const m1 = buildMetricRecord(UID, 'messages_received', 100, { date: '2026-06-01' });
    const m2 = buildMetricRecord(UID, 'leads_created', 5, { date: '2026-06-01' });
    m1.metricId = 'met_1'; m2.metricId = 'met_2';
    setDb(makeMockDb({ metStored: { [m1.metricId]: m1, [m2.metricId]: m2 } }));
    const msgs = await listMetrics(UID, { metricType: 'messages_received' });
    expect(msgs.every(m => m.metricType === 'messages_received')).toBe(true);
  });
  test('saveMetric con throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    const m = buildMetricRecord(UID, 'leads_created', 3, { date: DATE });
    await expect(saveMetric(UID, m)).rejects.toThrow('set error');
  });
  test('throwGet retorna array vacio', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const metrics = await listMetrics(UID);
    expect(metrics).toEqual([]);
  });
});

// ─── saveReport + getReport ───────────────────────────────────────────────────
describe('saveReport + getReport', () => {
  test('round-trip exitoso', async () => {
    const db = makeMockDb();
    setDb(db);
    const kpis = computeKPIs({ leads: 50, converted: 15, revenue: 30000 });
    const insights = buildInsights(kpis);
    const r = buildReportRecord(UID, 'daily', {
      date: DATE,
      title: 'Reporte 2026-06-01',
      summary: { leads: 50, converted: 15, revenue: 30000, conversionRate: kpis.conversionRate },
      insights,
    });
    const savedId = await saveReport(UID, r);
    expect(savedId).toBe(r.reportId);
    const loaded = await getReport(UID, r.reportId);
    expect(loaded.title).toBe('Reporte 2026-06-01');
    expect(loaded.summary.conversionRate).toBe(30);
    expect(loaded.insights.length).toBeGreaterThan(0);
  });
  test('getReport retorna null si no existe', async () => {
    setDb(makeMockDb());
    const loaded = await getReport(UID, 'report_no_existe');
    expect(loaded).toBeNull();
  });
  test('saveReport con throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    const r = buildReportRecord(UID, 'daily', { date: DATE });
    await expect(saveReport(UID, r)).rejects.toThrow('set error');
  });
  test('getReport con throwGet retorna null', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const loaded = await getReport(UID, 'report_001');
    expect(loaded).toBeNull();
  });
});

// ─── buildReportText ──────────────────────────────────────────────────────────
describe('buildReportText', () => {
  test('null retorna mensaje no encontrado', () => {
    expect(buildReportText(null)).toContain('no encontrado');
  });
  test('incluye titulo y fecha', () => {
    const r = buildReportRecord(UID, 'monthly', { date: DATE, title: 'Reporte Mayo' });
    const text = buildReportText(r);
    expect(text).toContain('Reporte Mayo');
    expect(text).toContain(DATE);
    expect(text).toContain('monthly');
  });
  test('incluye metricas del summary', () => {
    const r = buildReportRecord(UID, 'daily', {
      date: DATE,
      title: 'Test',
      summary: { leads: 30, converted: 10, revenue: 15000, conversionRate: 33, currency: 'ARS' },
    });
    const text = buildReportText(r);
    expect(text).toContain('30');
    expect(text).toContain('15000');
    expect(text).toContain('ARS');
  });
  test('incluye insights', () => {
    const kpis = computeKPIs({ leads: 100, converted: 35, revenue: 50000 });
    const insights = buildInsights(kpis);
    const r = buildReportRecord(UID, 'weekly', { date: DATE, title: 'Test', insights });
    const text = buildReportText(r);
    expect(text).toContain('Insights');
    expect(text.length).toBeGreaterThan(50);
  });
});
