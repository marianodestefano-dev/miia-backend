'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const REPORT_TYPES = Object.freeze([
  'sales', 'appointments', 'customers', 'products',
  'inventory', 'payments', 'loyalty', 'kpi_summary', 'custom',
]);
const REPORT_PERIODS = Object.freeze(['daily', 'weekly', 'monthly', 'quarterly', 'annual', 'custom']);
const REPORT_STATUSES = Object.freeze(['pending', 'generating', 'ready', 'failed', 'expired']);
const REPORT_FORMATS = Object.freeze(['json', 'text', 'csv']);

const PERIOD_MS = Object.freeze({
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  quarterly: 90 * 24 * 60 * 60 * 1000,
  annual: 365 * 24 * 60 * 60 * 1000,
});
const REPORT_EXPIRY_DAYS = 90;
const MAX_REPORT_ROWS = 1000;

function isValidType(t) { return REPORT_TYPES.includes(t); }
function isValidPeriod(p) { return REPORT_PERIODS.includes(p); }

function buildPeriodRange(period, referenceTs) {
  const now = referenceTs || Date.now();
  const ms = PERIOD_MS[period];
  if (!ms) return { from: now, to: now };
  return { from: now - ms, to: now };
}

function buildReportRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const period = isValidPeriod(data.period) ? data.period : 'monthly';
  const range = data.from && data.to
    ? { from: data.from, to: data.to }
    : buildPeriodRange(period, now);
  const reportId = uid.slice(0, 8) + '_rep_' + (isValidType(data.type) ? data.type.slice(0, 4) : 'cust') + '_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 4);
  return {
    reportId,
    uid,
    type: isValidType(data.type) ? data.type : 'custom',
    period,
    from: range.from,
    to: range.to,
    status: 'pending',
    format: REPORT_FORMATS.includes(data.format) ? data.format : 'json',
    title: typeof data.title === 'string' ? data.title.trim().slice(0, 100) : '',
    currency: typeof data.currency === 'string' ? data.currency.toUpperCase().slice(0, 3) : 'ARS',
    filters: data.filters && typeof data.filters === 'object' ? { ...data.filters } : {},
    data: null,
    rowCount: 0,
    generatedAt: null,
    expiresAt: now + REPORT_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: now,
    updatedAt: now,
  };
}

function buildSalesReport(transactions) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return { totalRevenue: 0, totalTransactions: 0, avgTicket: 0, topProducts: [], byDay: {} };
  }
  const rows = transactions.slice(0, MAX_REPORT_ROWS);
  const totalRevenue = rows.reduce((acc, t) => acc + (typeof t.amount === 'number' ? t.amount : 0), 0);
  const totalTransactions = rows.length;
  const avgTicket = totalTransactions > 0 ? Math.round(totalRevenue / totalTransactions * 100) / 100 : 0;

  // Productos mas vendidos
  const productCounts = {};
  rows.forEach(t => {
    if (t.productName) {
      productCounts[t.productName] = (productCounts[t.productName] || 0) + (t.quantity || 1);
    }
  });
  const topProducts = Object.entries(productCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  // Agrupacion por dia (YYYY-MM-DD)
  const byDay = {};
  rows.forEach(t => {
    const day = t.date ? String(t.date).slice(0, 10) : 'unknown';
    if (!byDay[day]) byDay[day] = { revenue: 0, count: 0 };
    byDay[day].revenue = Math.round((byDay[day].revenue + (t.amount || 0)) * 100) / 100;
    byDay[day].count += 1;
  });

  return {
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalTransactions,
    avgTicket,
    topProducts,
    byDay,
  };
}

function buildAppointmentReport(appointments) {
  if (!Array.isArray(appointments) || appointments.length === 0) {
    return { total: 0, completed: 0, cancelled: 0, noShow: 0, completionRate: 0, byService: {} };
  }
  const rows = appointments.slice(0, MAX_REPORT_ROWS);
  const total = rows.length;
  const completed = rows.filter(a => a.status === 'completed').length;
  const cancelled = rows.filter(a => a.status === 'cancelled').length;
  const noShow = rows.filter(a => a.status === 'no_show').length;
  const completionRate = total > 0 ? Math.round(completed / total * 100) : 0;

  const byService = {};
  rows.forEach(a => {
    const svc = a.service || 'unknown';
    if (!byService[svc]) byService[svc] = { total: 0, completed: 0 };
    byService[svc].total += 1;
    if (a.status === 'completed') byService[svc].completed += 1;
  });

  return { total, completed, cancelled, noShow, completionRate, byService };
}

function buildCustomerReport(customers) {
  if (!Array.isArray(customers) || customers.length === 0) {
    return { total: 0, newCustomers: 0, returningCustomers: 0, avgPurchases: 0, topCustomers: [] };
  }
  const rows = customers.slice(0, MAX_REPORT_ROWS);
  const total = rows.length;
  const newCustomers = rows.filter(c => (c.purchaseCount || 0) === 1).length;
  const returningCustomers = rows.filter(c => (c.purchaseCount || 0) > 1).length;
  const totalPurchases = rows.reduce((acc, c) => acc + (c.purchaseCount || 0), 0);
  const avgPurchases = total > 0 ? Math.round(totalPurchases / total * 100) / 100 : 0;
  const topCustomers = rows
    .sort((a, b) => (b.totalSpent || 0) - (a.totalSpent || 0))
    .slice(0, 5)
    .map(c => ({ name: c.name || 'N/A', totalSpent: c.totalSpent || 0, purchaseCount: c.purchaseCount || 0 }));
  return { total, newCustomers, returningCustomers, avgPurchases, topCustomers };
}

function computeKpiSummary(data) {
  data = data || {};
  const revenue = typeof data.revenue === 'number' ? data.revenue : 0;
  const prevRevenue = typeof data.prevRevenue === 'number' ? data.prevRevenue : 0;
  const revenueGrowth = prevRevenue > 0 ? Math.round((revenue - prevRevenue) / prevRevenue * 100) : null;
  const leads = typeof data.leads === 'number' ? data.leads : 0;
  const conversions = typeof data.conversions === 'number' ? data.conversions : 0;
  const conversionRate = leads > 0 ? Math.round(conversions / leads * 100) : 0;
  const appointments = typeof data.appointments === 'number' ? data.appointments : 0;
  const completedAppointments = typeof data.completedAppointments === 'number' ? data.completedAppointments : 0;
  const appointmentRate = appointments > 0 ? Math.round(completedAppointments / appointments * 100) : 0;
  return {
    revenue,
    prevRevenue,
    revenueGrowth,
    leads,
    conversions,
    conversionRate,
    appointments,
    completedAppointments,
    appointmentRate,
    activeSubscriptions: typeof data.activeSubscriptions === 'number' ? data.activeSubscriptions : 0,
    newCustomers: typeof data.newCustomers === 'number' ? data.newCustomers : 0,
    churnedCustomers: typeof data.churnedCustomers === 'number' ? data.churnedCustomers : 0,
  };
}

function applyReportData(report, data, rowCount) {
  const now = Date.now();
  return {
    ...report,
    status: 'ready',
    data,
    rowCount: typeof rowCount === 'number' ? rowCount : 0,
    generatedAt: now,
    updatedAt: now,
  };
}

function markReportFailed(report, error) {
  const now = Date.now();
  return {
    ...report,
    status: 'failed',
    lastError: typeof error === 'string' ? error.slice(0, 200) : 'unknown',
    updatedAt: now,
  };
}

function isExpired(report) {
  return report.expiresAt < Date.now();
}

function formatCurrency(amount, currency) {
  currency = currency || 'ARS';
  return currency + ' ' + (Math.round(amount * 100) / 100).toLocaleString('es-AR');
}

function buildReportText(report) {
  if (!report) return 'Reporte no encontrado.';
  const lines = [];
  const icons = {
    sales: '\u{1F4B0}', appointments: '\u{1F4C5}', customers: '\u{1F465}',
    products: '\u{1F4E6}', payments: '\u{1F4B3}', loyalty: '\u{2B50}',
    kpi_summary: '\u{1F4CA}', custom: '\u{1F4CB}',
  };
  const icon = icons[report.type] || '\u{1F4CB}';
  lines.push(icon + ' *Reporte: ' + (report.title || report.type) + '*');
  lines.push('Periodo: ' + report.period + ' | Estado: ' + report.status);
  lines.push('Desde: ' + new Date(report.from).toISOString().slice(0, 10) + ' Hasta: ' + new Date(report.to).toISOString().slice(0, 10));
  if (report.status === 'ready' && report.data) {
    const d = report.data;
    if (report.type === 'sales') {
      lines.push('Ingresos: ' + formatCurrency(d.totalRevenue || 0, report.currency));
      lines.push('Transacciones: ' + (d.totalTransactions || 0));
      lines.push('Ticket promedio: ' + formatCurrency(d.avgTicket || 0, report.currency));
    } else if (report.type === 'appointments') {
      lines.push('Total turnos: ' + (d.total || 0));
      lines.push('Completados: ' + (d.completed || 0) + ' (' + (d.completionRate || 0) + '%)');
      lines.push('Cancelados: ' + (d.cancelled || 0));
    } else if (report.type === 'kpi_summary') {
      lines.push('Revenue: ' + formatCurrency(d.revenue || 0, report.currency));
      if (d.revenueGrowth !== null && d.revenueGrowth !== undefined) {
        lines.push('Crecimiento: ' + (d.revenueGrowth >= 0 ? '+' : '') + d.revenueGrowth + '%');
      }
      lines.push('Leads: ' + (d.leads || 0) + ' | Conversion: ' + (d.conversionRate || 0) + '%');
    }
    lines.push('Filas: ' + report.rowCount);
  }
  if (report.generatedAt) {
    lines.push('Generado: ' + new Date(report.generatedAt).toISOString().slice(0, 16));
  }
  return lines.join('\n');
}

async function saveReport(uid, report) {
  console.log('[REPORT] Guardando uid=' + uid + ' id=' + report.reportId + ' type=' + report.type + ' status=' + report.status);
  try {
    await db().collection('owners').doc(uid)
      .collection('reports').doc(report.reportId)
      .set(report, { merge: false });
    return report.reportId;
  } catch (err) {
    console.error('[REPORT] Error guardando reporte:', err.message);
    throw err;
  }
}

async function getReport(uid, reportId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('reports').doc(reportId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[REPORT] Error obteniendo reporte:', err.message);
    return null;
  }
}

async function updateReport(uid, reportId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  try {
    await db().collection('owners').doc(uid)
      .collection('reports').doc(reportId)
      .set(update, { merge: true });
    return reportId;
  } catch (err) {
    console.error('[REPORT] Error actualizando reporte:', err.message);
    throw err;
  }
}

async function listReports(uid, opts) {
  opts = opts || {};
  try {
    let q = db().collection('owners').doc(uid).collection('reports');
    if (opts.type && isValidType(opts.type)) {
      q = q.where('type', '==', opts.type);
    }
    if (opts.status) {
      q = q.where('status', '==', opts.status);
    }
    const snap = await q.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      if (opts.period && rec.period !== opts.period) return;
      results.push(rec);
    });
    results.sort((a, b) => b.createdAt - a.createdAt);
    return results.slice(0, opts.limit || 50);
  } catch (err) {
    console.error('[REPORT] Error listando reportes:', err.message);
    return [];
  }
}

module.exports = {
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
  REPORT_FORMATS,
  PERIOD_MS,
  REPORT_EXPIRY_DAYS,
  MAX_REPORT_ROWS,
  __setFirestoreForTests,
};
