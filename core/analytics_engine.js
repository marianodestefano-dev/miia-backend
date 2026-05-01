'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const METRIC_TYPES = Object.freeze([
  'messages_received', 'messages_sent', 'leads_created', 'leads_converted',
  'appointments_booked', 'appointments_cancelled', 'payments_received',
  'coupons_redeemed', 'broadcasts_sent', 'follow_ups_sent',
  'response_time_avg', 'conversation_duration_avg', 'revenue_total',
]);

const REPORT_TYPES = Object.freeze(['daily', 'weekly', 'monthly', 'custom']);
const AGGREGATION_PERIODS = Object.freeze(['hour', 'day', 'week', 'month']);

const MAX_DATA_POINTS = 1000;
const MAX_REPORT_TITLE_LENGTH = 120;

function isValidMetric(m) { return METRIC_TYPES.includes(m); }
function isValidReportType(t) { return REPORT_TYPES.includes(t); }
function isValidPeriod(p) { return AGGREGATION_PERIODS.includes(p); }

function buildMetricId(uid, metricType, date) {
  const d = date || new Date().toISOString().slice(0, 10);
  return uid.slice(0, 8) + '_metric_' + metricType.replace(/_/g, '').slice(0, 10) + '_' + d.replace(/-/g, '');
}

function buildMetricRecord(uid, metricType, value, data) {
  data = data || {};
  if (!isValidMetric(metricType)) throw new Error('metricType invalido: ' + metricType);
  if (typeof value !== 'number' || !isFinite(value)) throw new Error('value debe ser numero');
  const date = data.date || new Date().toISOString().slice(0, 10);
  return {
    metricId: data.metricId || buildMetricId(uid, metricType, date),
    uid,
    metricType,
    value,
    date,
    period: isValidPeriod(data.period) ? data.period : 'day',
    tags: Array.isArray(data.tags) ? data.tags.filter(t => typeof t === 'string').slice(0, 10) : [],
    metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
    createdAt: data.createdAt || Date.now(),
  };
}

function buildReportId(uid, reportType, date) {
  const d = date || new Date().toISOString().slice(0, 10);
  return uid.slice(0, 8) + '_report_' + reportType + '_' + d.replace(/-/g, '');
}

function buildReportRecord(uid, reportType, data) {
  data = data || {};
  if (!isValidReportType(reportType)) throw new Error('reportType invalido: ' + reportType);
  const now = Date.now();
  const date = data.date || new Date().toISOString().slice(0, 10);
  return {
    reportId: data.reportId || buildReportId(uid, reportType, date),
    uid,
    reportType,
    title: typeof data.title === 'string' ? data.title.trim().slice(0, MAX_REPORT_TITLE_LENGTH) : 'Reporte ' + reportType,
    date,
    fromDate: data.fromDate || null,
    toDate: data.toDate || null,
    metrics: data.metrics && typeof data.metrics === 'object' ? data.metrics : {},
    summary: data.summary && typeof data.summary === 'object' ? data.summary : {},
    insights: Array.isArray(data.insights) ? data.insights.slice(0, 20) : [],
    generatedAt: now,
    createdAt: data.createdAt || now,
  };
}

function aggregateMetrics(metrics, opts) {
  opts = opts || {};
  if (!Array.isArray(metrics) || metrics.length === 0) {
    return { sum: 0, avg: 0, min: 0, max: 0, count: 0, byType: {} };
  }
  const filtered = opts.type ? metrics.filter(m => m.metricType === opts.type) : metrics;
  const values = filtered.map(m => m.value);
  const sum = values.reduce((a, b) => a + b, 0);
  const avg = values.length > 0 ? sum / values.length : 0;
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;
  const byType = {};
  metrics.forEach(m => {
    if (!byType[m.metricType]) byType[m.metricType] = { sum: 0, count: 0, avg: 0 };
    byType[m.metricType].sum += m.value;
    byType[m.metricType].count += 1;
  });
  Object.keys(byType).forEach(t => {
    byType[t].avg = byType[t].sum / byType[t].count;
  });
  return { sum, avg: Math.round(avg * 100) / 100, min, max, count: filtered.length, byType };
}

function computeKPIs(data) {
  data = data || {};
  const leads = data.leads || 0;
  const converted = data.converted || 0;
  const revenue = data.revenue || 0;
  const messages = data.messages || 0;
  const appointments = data.appointments || 0;
  const conversionRate = leads > 0 ? Math.round((converted / leads) * 100) : 0;
  const revenuePerLead = leads > 0 ? Math.round(revenue / leads) : 0;
  const revenuePerConversion = converted > 0 ? Math.round(revenue / converted) : 0;
  const messagesPerLead = leads > 0 ? Math.round(messages / leads) : 0;
  const appointmentsPerLead = leads > 0 ? Math.round((appointments / leads) * 100) / 100 : 0;
  return {
    leads, converted, revenue, messages, appointments,
    conversionRate, revenuePerLead, revenuePerConversion,
    messagesPerLead, appointmentsPerLead,
  };
}

function buildInsights(kpis, thresholds) {
  thresholds = thresholds || {};
  const insights = [];
  const minConvRate = thresholds.minConversionRate || 10;
  const minRevPerLead = thresholds.minRevenuePerLead || 100;
  if (kpis.conversionRate >= 30) {
    insights.push({ type: 'positive', message: 'Tasa de conversion excelente (' + kpis.conversionRate + '%)' });
  } else if (kpis.conversionRate >= minConvRate) {
    insights.push({ type: 'neutral', message: 'Tasa de conversion aceptable (' + kpis.conversionRate + '%)' });
  } else {
    insights.push({ type: 'warning', message: 'Tasa de conversion baja (' + kpis.conversionRate + '%) — meta: ' + minConvRate + '%' });
  }
  if (kpis.revenuePerLead >= minRevPerLead) {
    insights.push({ type: 'positive', message: 'Revenue por lead saludable: ' + kpis.revenuePerLead });
  } else if (kpis.revenuePerLead > 0) {
    insights.push({ type: 'warning', message: 'Revenue por lead bajo: ' + kpis.revenuePerLead + ' (meta: ' + minRevPerLead + ')' });
  }
  if (kpis.messagesPerLead > 20) {
    insights.push({ type: 'warning', message: 'Alto numero de mensajes por lead: ' + kpis.messagesPerLead + ' (puede indicar friccion en el proceso)' });
  }
  return insights;
}

async function saveMetric(uid, metric) {
  console.log('[ANALYTICS] Guardando metrica uid=' + uid + ' type=' + metric.metricType + ' value=' + metric.value);
  try {
    await db().collection('owners').doc(uid)
      .collection('metrics').doc(metric.metricId)
      .set(metric, { merge: false });
    return metric.metricId;
  } catch (err) {
    console.error('[ANALYTICS] Error guardando metrica:', err.message);
    throw err;
  }
}

async function saveReport(uid, report) {
  console.log('[ANALYTICS] Guardando reporte uid=' + uid + ' type=' + report.reportType + ' date=' + report.date);
  try {
    await db().collection('owners').doc(uid)
      .collection('reports').doc(report.reportId)
      .set(report, { merge: false });
    return report.reportId;
  } catch (err) {
    console.error('[ANALYTICS] Error guardando reporte:', err.message);
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
    console.error('[ANALYTICS] Error obteniendo reporte:', err.message);
    return null;
  }
}

async function listMetrics(uid, opts) {
  opts = opts || {};
  try {
    let q = db().collection('owners').doc(uid).collection('metrics');
    if (opts.metricType && isValidMetric(opts.metricType)) {
      q = q.where('metricType', '==', opts.metricType);
    }
    const snap = await q.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      if (opts.fromDate && rec.date < opts.fromDate) return;
      if (opts.toDate && rec.date > opts.toDate) return;
      results.push(rec);
    });
    results.sort((a, b) => (b.date > a.date ? 1 : -1));
    return results.slice(0, opts.limit || MAX_DATA_POINTS);
  } catch (err) {
    console.error('[ANALYTICS] Error listando metricas:', err.message);
    return [];
  }
}

function buildReportText(report) {
  if (!report) return 'Reporte no encontrado.';
  const parts = [];
  parts.push('\u{1F4C8} *' + report.title + '*');
  parts.push('Tipo: ' + report.reportType + ' | Fecha: ' + report.date);
  if (report.summary) {
    const s = report.summary;
    if (s.leads !== undefined) parts.push('Leads: ' + s.leads + ' | Convertidos: ' + (s.converted || 0));
    if (s.revenue !== undefined) parts.push('Revenue: ' + s.revenue + ' ' + (s.currency || 'ARS'));
    if (s.conversionRate !== undefined) parts.push('Conversion: ' + s.conversionRate + '%');
  }
  if (report.insights && report.insights.length > 0) {
    parts.push('');
    parts.push('\u{1F4A1} Insights:');
    report.insights.slice(0, 3).forEach(i => {
      const icon = i.type === 'positive' ? '\u{2705}' : i.type === 'warning' ? '\u{26A0}\uFE0F' : '\u{1F538}';
      parts.push(icon + ' ' + i.message);
    });
  }
  return parts.join('\n');
}

module.exports = {
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
  __setFirestoreForTests,
};
