'use strict';

/**
 * MIIA - Analytics Engine (T248)
 * P4.4 ROADMAP: motor de analiticas y metricas del negocio para el owner.
 * Genera reportes de conversaciones, leads, respuesta, conversion y actividad.
 */

const METRIC_TYPES = Object.freeze([
  'messages_total', 'leads_new', 'leads_converted', 'response_time_avg',
  'handoffs_total', 'broadcasts_sent', 'spam_blocked', 'active_contacts',
  'revenue_total', 'sessions_daily',
]);

const REPORT_PERIODS = Object.freeze(['daily', 'weekly', 'monthly', 'custom']);

const ANALYTICS_COLLECTION = 'analytics';
const MAX_DATAPOINTS = 90;
const CONVERSION_RATE_THRESHOLD = 0.05;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidMetric(metric) {
  return METRIC_TYPES.includes(metric);
}

function isValidPeriod(period) {
  return REPORT_PERIODS.includes(period);
}

function buildMetricRecord(uid, metric, value, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!isValidMetric(metric)) throw new Error('metric invalido: ' + metric);
  if (typeof value !== 'number') throw new Error('value debe ser numero');
  var date = (opts && opts.date) ? opts.date : new Date().toISOString().slice(0, 10);
  var recordId = uid.slice(0, 8) + '_' + metric + '_' + date;
  return {
    recordId,
    uid,
    metric,
    value,
    date,
    period: (opts && opts.period && isValidPeriod(opts.period)) ? opts.period : 'daily',
    metadata: (opts && opts.metadata) ? opts.metadata : {},
    createdAt: new Date().toISOString(),
  };
}

async function saveMetric(uid, record) {
  if (!uid) throw new Error('uid requerido');
  if (!record || !record.recordId) throw new Error('record invalido');
  await db().collection('tenants').doc(uid).collection(ANALYTICS_COLLECTION).doc(record.recordId).set(record, { merge: true });
  console.log('[ANALYTICS] Guardado uid=' + uid + ' metric=' + record.metric + ' value=' + record.value);
  return record.recordId;
}

async function incrementMetric(uid, metric, amount, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!isValidMetric(metric)) throw new Error('metric invalido: ' + metric);
  var inc = (typeof amount === 'number') ? amount : 1;
  var date = (opts && opts.date) ? opts.date : new Date().toISOString().slice(0, 10);
  var recordId = uid.slice(0, 8) + '_' + metric + '_' + date;
  try {
    var snap = await db().collection('tenants').doc(uid).collection(ANALYTICS_COLLECTION).doc(recordId).get();
    var current = (snap && snap.exists && snap.data()) ? (snap.data().value || 0) : 0;
    var record = buildMetricRecord(uid, metric, current + inc, opts);
    await saveMetric(uid, record);
    return record;
  } catch (e) {
    console.error('[ANALYTICS] Error incrementando: ' + e.message);
    return null;
  }
}

async function getMetrics(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection(ANALYTICS_COLLECTION).get();
    var records = [];
    snap.forEach(function(doc) { records.push(doc.data()); });
    if (opts && opts.metric) records = records.filter(function(r) { return r.metric === opts.metric; });
    if (opts && opts.period) records = records.filter(function(r) { return r.period === opts.period; });
    if (opts && opts.dateFrom) records = records.filter(function(r) { return r.date >= opts.dateFrom; });
    if (opts && opts.dateTo) records = records.filter(function(r) { return r.date <= opts.dateTo; });
    records.sort(function(a, b) { return a.date.localeCompare(b.date); });
    return records.slice(0, MAX_DATAPOINTS);
  } catch (e) {
    console.error('[ANALYTICS] Error leyendo metricas: ' + e.message);
    return [];
  }
}

function computeConversionRate(leadsNew, leadsConverted) {
  if (!leadsNew || leadsNew === 0) return 0;
  return Math.round((leadsConverted / leadsNew) * 100) / 100;
}

function computeResponseTimeAvg(responseTimes) {
  if (!Array.isArray(responseTimes) || responseTimes.length === 0) return 0;
  var valid = responseTimes.filter(function(t) { return typeof t === 'number' && t >= 0; });
  if (valid.length === 0) return 0;
  return Math.round(valid.reduce(function(s, t) { return s + t; }, 0) / valid.length);
}

function buildDailyReport(uid, metrics, date) {
  if (!uid) throw new Error('uid requerido');
  var byMetric = {};
  (metrics || []).forEach(function(r) {
    if (r.date === date) byMetric[r.metric] = r.value;
  });
  return {
    uid,
    date: date || new Date().toISOString().slice(0, 10),
    period: 'daily',
    metrics: byMetric,
    conversionRate: computeConversionRate(byMetric.leads_new || 0, byMetric.leads_converted || 0),
    generatedAt: new Date().toISOString(),
  };
}

function buildWeeklyReport(uid, metrics, weekStart) {
  if (!uid) throw new Error('uid requerido');
  var start = weekStart || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  var inRange = (metrics || []).filter(function(r) { return r.date >= start; });
  var totals = {};
  METRIC_TYPES.forEach(function(m) { totals[m] = 0; });
  inRange.forEach(function(r) {
    if (METRIC_TYPES.includes(r.metric)) totals[r.metric] += r.value;
  });
  return {
    uid,
    weekStart: start,
    period: 'weekly',
    totals,
    daysWithData: new Set(inRange.map(function(r) { return r.date; })).size,
    conversionRate: computeConversionRate(totals.leads_new, totals.leads_converted),
    generatedAt: new Date().toISOString(),
  };
}

function buildReportSummaryText(report) {
  if (!report) return '';
  var isWeekly = report.period === 'weekly';
  var data = isWeekly ? report.totals : report.metrics;
  if (!data) return '';
  var lines = [
    '📈 *Reporte ' + (isWeekly ? 'Semanal' : 'Diario') + '* — ' + (report.date || report.weekStart),
    'Mensajes: ' + (data.messages_total || 0),
    'Leads nuevos: ' + (data.leads_new || 0),
    'Leads convertidos: ' + (data.leads_converted || 0),
    'Tasa conversión: ' + (Math.round((report.conversionRate || 0) * 100)) + '%',
  ];
  if (data.handoffs_total) lines.push('Handoffs: ' + data.handoffs_total);
  if (data.broadcasts_sent) lines.push('Broadcasts: ' + data.broadcasts_sent);
  if (data.spam_blocked) lines.push('Spam bloqueado: ' + data.spam_blocked);
  return lines.join('\n');
}

function detectAnomalies(currentMetrics, historicalAvg, thresholds) {
  if (!currentMetrics || !historicalAvg) return [];
  var anomalies = [];
  var thresh = thresholds || {};
  Object.keys(currentMetrics).forEach(function(metric) {
    var current = currentMetrics[metric] || 0;
    var avg = historicalAvg[metric] || 0;
    if (avg === 0) return;
    var deviation = Math.abs(current - avg) / avg;
    var threshold = thresh[metric] || 2.0;
    if (deviation > threshold) {
      anomalies.push({
        metric,
        current,
        average: avg,
        deviation: Math.round(deviation * 100) / 100,
        direction: current > avg ? 'spike' : 'drop',
      });
    }
  });
  return anomalies;
}

module.exports = {
  buildMetricRecord,
  saveMetric,
  incrementMetric,
  getMetrics,
  computeConversionRate,
  computeResponseTimeAvg,
  buildDailyReport,
  buildWeeklyReport,
  buildReportSummaryText,
  detectAnomalies,
  isValidMetric,
  isValidPeriod,
  METRIC_TYPES,
  REPORT_PERIODS,
  MAX_DATAPOINTS,
  CONVERSION_RATE_THRESHOLD,
  __setFirestoreForTests,
};
