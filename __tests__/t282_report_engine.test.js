'use strict';

const {
  buildReportRecord,
  buildSalesReport,
  buildAppointmentReport,
  buildCustomerReport,
  computeKpiSummary,
  applyReportData,
  markReportFailed,
  buildPeriodRange,
  isExpired,
  formatCurrency,
  buildReportText,
  saveReport,
  getReport,
  updateReport,
  listReports,
  REPORT_TYPES,
  REPORT_PERIODS,
  REPORT_STATUSES,
  PERIOD_MS,
  REPORT_EXPIRY_DAYS,
  MAX_REPORT_ROWS,
  __setFirestoreForTests,
} = require('../core/report_engine');

function makeMockDb() {
  const stored = {};
  return {
    stored,
    db: {
      collection: () => ({
        doc: (uid) => ({
          collection: (subCol) => ({
            doc: (id) => ({
              set: async (data) => {
                if (!stored[uid]) stored[uid] = {};
                stored[uid][id] = { ...data };
              },
              get: async () => {
                const rec = stored[uid] && stored[uid][id];
                return { exists: !!rec, data: () => rec };
              },
            }),
            where: (field, op, val) => {
              const chain = { filters: [[field, op, val]] };
              chain.where = (f2, op2, v2) => { chain.filters.push([f2, op2, v2]); return chain; };
              chain.get = async () => {
                const all = Object.values(stored[uid] || {});
                const filtered = all.filter(r => chain.filters.every(([f, o, v]) => {
                  if (o === '==') return r[f] === v;
                  return true;
                }));
                return {
                  empty: filtered.length === 0,
                  forEach: (fn) => filtered.forEach(d => fn({ data: () => d })),
                };
              };
              return chain;
            },
            get: async () => {
              const all = Object.values(stored[uid] || {});
              return {
                empty: all.length === 0,
                forEach: (fn) => all.forEach(d => fn({ data: () => d })),
              };
            },
          }),
        }),
      }),
    },
  };
}

const UID = 'usr_report_test_001';

describe('T282 — report_engine', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    __setFirestoreForTests(mock.db);
  });

  // ─── Constantes ───────────────────────────────────────────────────────────

  describe('Constantes exportadas', () => {
    test('REPORT_TYPES es frozen con todos los tipos', () => {
      expect(Object.isFrozen(REPORT_TYPES)).toBe(true);
      expect(REPORT_TYPES).toContain('sales');
      expect(REPORT_TYPES).toContain('appointments');
      expect(REPORT_TYPES).toContain('kpi_summary');
    });

    test('REPORT_PERIODS es frozen', () => {
      expect(Object.isFrozen(REPORT_PERIODS)).toBe(true);
      expect(REPORT_PERIODS).toContain('daily');
      expect(REPORT_PERIODS).toContain('monthly');
      expect(REPORT_PERIODS).toContain('annual');
    });

    test('REPORT_STATUSES es frozen', () => {
      expect(Object.isFrozen(REPORT_STATUSES)).toBe(true);
      expect(REPORT_STATUSES).toContain('pending');
      expect(REPORT_STATUSES).toContain('ready');
      expect(REPORT_STATUSES).toContain('failed');
    });

    test('PERIOD_MS es frozen con valores correctos', () => {
      expect(Object.isFrozen(PERIOD_MS)).toBe(true);
      expect(PERIOD_MS.daily).toBe(24 * 60 * 60 * 1000);
      expect(PERIOD_MS.monthly).toBe(30 * 24 * 60 * 60 * 1000);
    });

    test('REPORT_EXPIRY_DAYS es 90 y MAX_REPORT_ROWS es 1000', () => {
      expect(REPORT_EXPIRY_DAYS).toBe(90);
      expect(MAX_REPORT_ROWS).toBe(1000);
    });
  });

  // ─── buildPeriodRange ─────────────────────────────────────────────────────

  describe('buildPeriodRange', () => {
    test('daily cubre ultimas 24h', () => {
      const now = Date.now();
      const range = buildPeriodRange('daily', now);
      expect(range.to).toBe(now);
      expect(range.from).toBe(now - PERIOD_MS.daily);
    });

    test('monthly cubre ultimos 30 dias', () => {
      const now = Date.now();
      const range = buildPeriodRange('monthly', now);
      expect(range.to - range.from).toBe(PERIOD_MS.monthly);
    });

    test('period desconocido retorna from==to', () => {
      const now = Date.now();
      const range = buildPeriodRange('unknown_period', now);
      expect(range.from).toBe(now);
      expect(range.to).toBe(now);
    });
  });

  // ─── buildReportRecord ────────────────────────────────────────────────────

  describe('buildReportRecord', () => {
    test('construye reporte con campos requeridos', () => {
      const r = buildReportRecord(UID, { type: 'sales', period: 'monthly', currency: 'usd' });
      expect(r.uid).toBe(UID);
      expect(r.type).toBe('sales');
      expect(r.period).toBe('monthly');
      expect(r.currency).toBe('USD');
      expect(r.status).toBe('pending');
      expect(r.data).toBeNull();
      expect(r.rowCount).toBe(0);
      expect(r.from).toBeLessThan(r.to);
    });

    test('type invalido cae a custom', () => {
      const r = buildReportRecord(UID, { type: 'inventado' });
      expect(r.type).toBe('custom');
    });

    test('period invalido cae a monthly', () => {
      const r = buildReportRecord(UID, { period: 'fortnightly' });
      expect(r.period).toBe('monthly');
    });

    test('from/to explícitos se respetan', () => {
      const from = 1000;
      const to = 9999;
      const r = buildReportRecord(UID, { type: 'sales', period: 'custom', from, to });
      expect(r.from).toBe(from);
      expect(r.to).toBe(to);
    });

    test('reportId es unico por llamada', () => {
      const r1 = buildReportRecord(UID, {});
      const r2 = buildReportRecord(UID, {});
      expect(r1.reportId).not.toBe(r2.reportId);
    });

    test('expiresAt es 90 dias desde ahora', () => {
      const before = Date.now();
      const r = buildReportRecord(UID, {});
      const after = Date.now();
      const expiryMs = REPORT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
      expect(r.expiresAt).toBeGreaterThanOrEqual(before + expiryMs);
      expect(r.expiresAt).toBeLessThanOrEqual(after + expiryMs + 1000);
    });
  });

  // ─── buildSalesReport ─────────────────────────────────────────────────────

  describe('buildSalesReport', () => {
    test('calcula totalRevenue, totalTransactions y avgTicket', () => {
      const txs = [
        { amount: 1000, productName: 'Remera', quantity: 2, date: '2026-05-01' },
        { amount: 500, productName: 'Pantalon', quantity: 1, date: '2026-05-01' },
        { amount: 750, productName: 'Remera', quantity: 1, date: '2026-05-02' },
      ];
      const report = buildSalesReport(txs);
      expect(report.totalRevenue).toBeCloseTo(2250);
      expect(report.totalTransactions).toBe(3);
      expect(report.avgTicket).toBeCloseTo(750);
    });

    test('topProducts ordenados por cantidad', () => {
      const txs = [
        { amount: 100, productName: 'A', quantity: 3 },
        { amount: 200, productName: 'B', quantity: 5 },
        { amount: 50, productName: 'A', quantity: 2 },
      ];
      const report = buildSalesReport(txs);
      // B qty=5, A qty=3+2=5 — ambos presentes en top (empate en cantidad)
      const names = report.topProducts.map(p => p.name);
      expect(names).toContain('A');
      expect(names).toContain('B');
    });

    test('byDay agrupa correctamente', () => {
      const txs = [
        { amount: 100, date: '2026-05-01' },
        { amount: 200, date: '2026-05-01' },
        { amount: 300, date: '2026-05-02' },
      ];
      const report = buildSalesReport(txs);
      expect(report.byDay['2026-05-01'].revenue).toBeCloseTo(300);
      expect(report.byDay['2026-05-01'].count).toBe(2);
      expect(report.byDay['2026-05-02'].revenue).toBe(300);
    });

    test('sin transacciones retorna zeros', () => {
      const report = buildSalesReport([]);
      expect(report.totalRevenue).toBe(0);
      expect(report.totalTransactions).toBe(0);
      expect(report.avgTicket).toBe(0);
    });

    test('respeta MAX_REPORT_ROWS', () => {
      const txs = Array.from({ length: 1500 }, (_, i) => ({ amount: 1, date: '2026-01-01' }));
      const report = buildSalesReport(txs);
      expect(report.totalTransactions).toBe(MAX_REPORT_ROWS);
    });
  });

  // ─── buildAppointmentReport ───────────────────────────────────────────────

  describe('buildAppointmentReport', () => {
    test('calcula completion rate y conteos correctamente', () => {
      const apts = [
        { status: 'completed', service: 'Pilates' },
        { status: 'completed', service: 'Yoga' },
        { status: 'cancelled', service: 'Pilates' },
        { status: 'no_show', service: 'Yoga' },
        { status: 'completed', service: 'Pilates' },
      ];
      const report = buildAppointmentReport(apts);
      expect(report.total).toBe(5);
      expect(report.completed).toBe(3);
      expect(report.cancelled).toBe(1);
      expect(report.noShow).toBe(1);
      expect(report.completionRate).toBe(60);
    });

    test('byService agrupa por servicio', () => {
      const apts = [
        { status: 'completed', service: 'Pilates' },
        { status: 'cancelled', service: 'Pilates' },
        { status: 'completed', service: 'Yoga' },
      ];
      const report = buildAppointmentReport(apts);
      expect(report.byService['Pilates'].total).toBe(2);
      expect(report.byService['Pilates'].completed).toBe(1);
      expect(report.byService['Yoga'].total).toBe(1);
    });

    test('sin turnos retorna zeros', () => {
      const report = buildAppointmentReport([]);
      expect(report.total).toBe(0);
      expect(report.completionRate).toBe(0);
    });
  });

  // ─── buildCustomerReport ──────────────────────────────────────────────────

  describe('buildCustomerReport', () => {
    test('distingue nuevos de recurrentes', () => {
      const customers = [
        { name: 'Ana', purchaseCount: 1, totalSpent: 500 },
        { name: 'Luis', purchaseCount: 5, totalSpent: 2500 },
        { name: 'Marta', purchaseCount: 3, totalSpent: 1200 },
        { name: 'Pablo', purchaseCount: 1, totalSpent: 300 },
      ];
      const report = buildCustomerReport(customers);
      expect(report.total).toBe(4);
      expect(report.newCustomers).toBe(2);
      expect(report.returningCustomers).toBe(2);
    });

    test('topCustomers ordenados por totalSpent desc', () => {
      const customers = [
        { name: 'A', totalSpent: 100, purchaseCount: 1 },
        { name: 'B', totalSpent: 500, purchaseCount: 3 },
        { name: 'C', totalSpent: 250, purchaseCount: 2 },
      ];
      const report = buildCustomerReport(customers);
      expect(report.topCustomers[0].name).toBe('B');
      expect(report.topCustomers[1].name).toBe('C');
    });

    test('sin clientes retorna zeros', () => {
      const report = buildCustomerReport([]);
      expect(report.total).toBe(0);
      expect(report.avgPurchases).toBe(0);
    });
  });

  // ─── computeKpiSummary ────────────────────────────────────────────────────

  describe('computeKpiSummary', () => {
    test('calcula revenueGrowth correctamente', () => {
      const kpi = computeKpiSummary({ revenue: 15000, prevRevenue: 12000 });
      expect(kpi.revenueGrowth).toBe(25); // 25% growth
    });

    test('revenueGrowth negativo si baja', () => {
      const kpi = computeKpiSummary({ revenue: 8000, prevRevenue: 10000 });
      expect(kpi.revenueGrowth).toBe(-20);
    });

    test('revenueGrowth null si prevRevenue es 0', () => {
      const kpi = computeKpiSummary({ revenue: 5000, prevRevenue: 0 });
      expect(kpi.revenueGrowth).toBeNull();
    });

    test('conversionRate calculado correctamente', () => {
      const kpi = computeKpiSummary({ leads: 100, conversions: 23 });
      expect(kpi.conversionRate).toBe(23);
    });

    test('appointmentRate calculado correctamente', () => {
      const kpi = computeKpiSummary({ appointments: 50, completedAppointments: 42 });
      expect(kpi.appointmentRate).toBe(84);
    });

    test('sin datos retorna zeros', () => {
      const kpi = computeKpiSummary({});
      expect(kpi.revenue).toBe(0);
      expect(kpi.leads).toBe(0);
      expect(kpi.conversionRate).toBe(0);
    });
  });

  // ─── applyReportData / markReportFailed ───────────────────────────────────

  describe('applyReportData / markReportFailed', () => {
    test('applyReportData setea status ready y data', () => {
      const r = buildReportRecord(UID, { type: 'sales' });
      const salesData = buildSalesReport([{ amount: 100, date: '2026-05-01' }]);
      const ready = applyReportData(r, salesData, 1);
      expect(ready.status).toBe('ready');
      expect(ready.data).toBeDefined();
      expect(ready.rowCount).toBe(1);
      expect(ready.generatedAt).toBeGreaterThan(0);
    });

    test('markReportFailed setea status failed con error', () => {
      const r = buildReportRecord(UID, {});
      const failed = markReportFailed(r, 'Timeout al conectar con Firestore');
      expect(failed.status).toBe('failed');
      expect(failed.lastError).toContain('Timeout');
    });
  });

  // ─── isExpired ────────────────────────────────────────────────────────────

  describe('isExpired', () => {
    test('retorna true si expiresAt ya paso', () => {
      const r = { ...buildReportRecord(UID, {}), expiresAt: Date.now() - 1000 };
      expect(isExpired(r)).toBe(true);
    });

    test('retorna false si expiresAt es futuro', () => {
      const r = buildReportRecord(UID, {});
      expect(isExpired(r)).toBe(false);
    });
  });

  // ─── formatCurrency ───────────────────────────────────────────────────────

  describe('formatCurrency', () => {
    test('formatea con moneda', () => {
      const result = formatCurrency(1500, 'ARS');
      expect(result).toContain('ARS');
      expect(result).toContain('1');
    });

    test('usa ARS por defecto', () => {
      const result = formatCurrency(500);
      expect(result).toContain('ARS');
    });
  });

  // ─── buildReportText ──────────────────────────────────────────────────────

  describe('buildReportText', () => {
    test('genera texto para reporte sales ready', () => {
      const r = buildReportRecord(UID, { type: 'sales', period: 'monthly', title: 'Reporte Mayo' });
      const salesData = buildSalesReport([
        { amount: 3000, date: '2026-05-01' },
        { amount: 2000, date: '2026-05-02' },
      ]);
      const ready = applyReportData(r, salesData, 2);
      const text = buildReportText(ready);
      expect(text).toContain('Reporte Mayo');
      expect(text).toContain('monthly');
      expect(text).toContain('5'); // 5000 formateado como 5.000 en es-AR
      expect(text).toContain('Transacciones: 2');
    });

    test('genera texto para reporte kpi_summary', () => {
      const r = buildReportRecord(UID, { type: 'kpi_summary', period: 'weekly' });
      const kpiData = computeKpiSummary({ revenue: 20000, prevRevenue: 15000, leads: 80, conversions: 20 });
      const ready = applyReportData(r, kpiData, 0);
      const text = buildReportText(ready);
      expect(text).toContain('kpi_summary');
      expect(text).toContain('Crecimiento: +33%');
      expect(text).toContain('Conversion: 25%');
    });

    test('retorna mensaje si report es null', () => {
      expect(buildReportText(null)).toBe('Reporte no encontrado.');
    });
  });

  // ─── Firestore CRUD ───────────────────────────────────────────────────────

  describe('Operaciones Firestore', () => {
    test('saveReport + getReport funciona', async () => {
      const r = buildReportRecord(UID, { type: 'sales', period: 'daily' });
      await saveReport(UID, r);
      const retrieved = await getReport(UID, r.reportId);
      expect(retrieved).not.toBeNull();
      expect(retrieved.type).toBe('sales');
    });

    test('getReport retorna null si no existe', async () => {
      const result = await getReport(UID, 'rep_inexistente_999');
      expect(result).toBeNull();
    });

    test('updateReport hace merge', async () => {
      const r = buildReportRecord(UID, { type: 'appointments' });
      await saveReport(UID, r);
      await updateReport(UID, r.reportId, { status: 'ready', rowCount: 15 });
      const retrieved = await getReport(UID, r.reportId);
      expect(retrieved.status).toBe('ready');
      expect(retrieved.rowCount).toBe(15);
    });

    test('listReports retorna reportes guardados', async () => {
      const r1 = buildReportRecord(UID, { type: 'sales' });
      const r2 = buildReportRecord(UID, { type: 'appointments' });
      await saveReport(UID, r1);
      await saveReport(UID, r2);
      const all = await listReports(UID);
      expect(all.length).toBe(2);
    });

    test('listReports filtra por type', async () => {
      const r1 = buildReportRecord(UID, { type: 'sales' });
      const r2 = buildReportRecord(UID, { type: 'customers' });
      await saveReport(UID, r1);
      await saveReport(UID, r2);
      const sales = await listReports(UID, { type: 'sales' });
      expect(sales.every(r => r.type === 'sales')).toBe(true);
    });

    test('listReports retorna array vacio si no hay', async () => {
      const result = await listReports('uid_sin_reportes');
      expect(result).toEqual([]);
    });
  });
});
