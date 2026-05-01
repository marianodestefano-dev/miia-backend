'use strict';

/**
 * MIIA - Analytics Dashboard (T184)
 * Metricas del owner: conversaciones, leads, ventas, respuestas.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const METRIC_TYPES = Object.freeze([
  'messages_received', 'messages_sent', 'new_leads', 'appointments_booked',
  'catalog_views', 'price_inquiries', 'payments_received', 'response_time_ms',
]);

const PERIOD_TYPES = Object.freeze(['day', 'week', 'month', 'quarter']);
const DEFAULT_PERIOD = 'week';
const MAX_HISTORY_DAYS = 90;


/**
 * Registra un evento de metrica.
 * @param {string} uid
 * @param {string} metricType
 * @param {number} [value]
 * @param {object} [meta]
 */
async function recordMetric(uid, metricType, value, meta) {
  if (!uid) throw new Error('uid requerido');
  if (!metricType) throw new Error('metricType requerido');
  if (!METRIC_TYPES.includes(metricType)) throw new Error('metricType invalido: ' + metricType);

  const val = typeof value === 'number' ? value : 1;
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);

  const doc = {
    uid, metricType, value: val,
    meta: meta || {},
    recordedAt: now.toISOString(),
    dateKey,
  };

  try {
    const id = uid.substring(0, 8) + '_' + metricType + '_' + Date.now();
    await db()
      .collection('analytics').doc(uid)
      .collection('events').doc(id)
      .set(doc);
  } catch (e) {
    console.error('[ANALYTICS] Error registrando metrica uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  }
}

/**
 * Agrega metricas por periodo.
 * @param {string} uid
 * @param {string} metricType
 * @param {string} period - 'day'|'week'|'month'
 * @param {number} [nowMs]
 * @returns {Promise<{total, count, average, period, metricType}>}
 */
async function getMetricSummary(uid, metricType, period, nowMs) {
  if (!uid) throw new Error('uid requerido');
  if (!metricType) throw new Error('metricType requerido');
  if (!METRIC_TYPES.includes(metricType)) throw new Error('metricType invalido: ' + metricType);

  const prd = period && PERIOD_TYPES.includes(period) ? period : DEFAULT_PERIOD;
  const now = nowMs || Date.now();
  const periodMs = _periodToMs(prd);
  const fromMs = now - periodMs;
  const fromDate = new Date(fromMs).toISOString();

  try {
    const snap = await db()
      .collection('analytics').doc(uid)
      .collection('events')
      .where('metricType', '==', metricType)
      .where('recordedAt', '>=', fromDate)
      .get();

    let total = 0;
    let count = 0;
    snap.forEach(doc => {
      const d = doc.data();
      total += d.value || 0;
      count++;
    });

    return {
      total,
      count,
      average: count > 0 ? Math.round((total / count) * 100) / 100 : 0,
      period: prd,
      metricType,
    };
  } catch (e) {
    console.error('[ANALYTICS] Error obteniendo metrica uid=' + uid.substring(0, 8) + ': ' + e.message);
    return { total: 0, count: 0, average: 0, period: prd, metricType };
  }
}

function _periodToMs(period) {
  const DAY = 24 * 60 * 60 * 1000;
  if (period === 'day') return DAY;
  if (period === 'week') return 7 * DAY;
  if (period === 'month') return 30 * DAY;
  if (period === 'quarter') return 90 * DAY;
  return 7 * DAY;
}


/**
 * Genera el dashboard completo del owner para un periodo.
 * @param {string} uid
 * @param {string} [period]
 * @param {number} [nowMs]
 * @returns {Promise<object>} dashboard con todas las metricas
 */
async function getDashboard(uid, period, nowMs) {
  if (!uid) throw new Error('uid requerido');

  const prd = period && PERIOD_TYPES.includes(period) ? period : DEFAULT_PERIOD;
  const now = nowMs || Date.now();

  const results = {};
  for (const metric of METRIC_TYPES) {
    results[metric] = await getMetricSummary(uid, metric, prd, now);
  }

  const engagementRate = results.messages_received.count > 0
    ? Math.round((results.messages_sent.count / results.messages_received.count) * 100) / 100
    : 0;

  return {
    uid,
    period: prd,
    generatedAt: new Date(now).toISOString(),
    metrics: results,
    summary: {
      totalMessages: results.messages_received.total + results.messages_sent.total,
      newLeads: results.new_leads.total,
      appointmentsBooked: results.appointments_booked.total,
      totalRevenue: results.payments_received.total,
      avgResponseTimeMs: results.response_time_ms.average,
      engagementRate,
    },
  };
}

/**
 * Compara metricas entre dos periodos (periodo actual vs anterior).
 * @param {string} uid
 * @param {string} metricType
 * @param {string} [period]
 * @param {number} [nowMs]
 * @returns {Promise<{current, previous, change, changePercent}>}
 */
async function compareMetrics(uid, metricType, period, nowMs) {
  if (!uid) throw new Error('uid requerido');
  if (!metricType) throw new Error('metricType requerido');
  if (!METRIC_TYPES.includes(metricType)) throw new Error('metricType invalido: ' + metricType);

  const prd = period && PERIOD_TYPES.includes(period) ? period : DEFAULT_PERIOD;
  const now = nowMs || Date.now();
  const periodMs = _periodToMs(prd);

  const [current, previous] = await Promise.all([
    getMetricSummary(uid, metricType, prd, now),
    getMetricSummary(uid, metricType, prd, now - periodMs),
  ]);

  const change = current.total - previous.total;
  const changePercent = previous.total > 0
    ? Math.round((change / previous.total) * 100 * 10) / 10
    : current.total > 0 ? 100 : 0;

  return { current, previous, change, changePercent };
}

module.exports = {
  recordMetric, getMetricSummary, getDashboard, compareMetrics,
  METRIC_TYPES, PERIOD_TYPES, DEFAULT_PERIOD, MAX_HISTORY_DAYS,
  __setFirestoreForTests,
};
