'use strict';

/**
 * MIIA â€” Analytics Aggregator (T149)
 * Agrega metricas de uso por tenant desde Firestore.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

const METRIC_TYPES = Object.freeze([
  'messages_received', 'messages_sent', 'contacts_new',
  'appointments_created', 'broadcasts_sent', 'followups_sent',
  'ai_calls', 'errors',
]);

const PERIOD_TYPES = Object.freeze(['day', 'week', 'month']);

/**
 * Incrementa un contador de metrica para un tenant.
 * @param {string} uid
 * @param {string} metric
 * @param {number} [value=1]
 * @param {Date|number} [nowMs]
 */
async function incrementMetric(uid, metric, value, nowMs) {
  if (!uid) throw new Error('uid requerido');
  if (!METRIC_TYPES.includes(metric)) throw new Error('metrica invalida: ' + metric);
  if (value === undefined) value = 1;
  if (typeof value !== 'number' || value <= 0) throw new Error('value debe ser numero positivo');

  const now = nowMs ? new Date(nowMs) : new Date();
  const dayKey = _dayKey(now);
  const docPath = 'analytics/' + uid + '/daily/' + dayKey;

  try {
    const admin = require('firebase-admin');
    await db().collection('analytics').doc(uid).collection('daily').doc(dayKey).set(
      { [metric]: admin.firestore.FieldValue.increment(value), updatedAt: now.toISOString() },
      { merge: true }
    );
    console.log('[ANALYTICS] uid=' + uid.substring(0,8) + ' metric=' + metric + ' +' + value + ' day=' + dayKey);
  } catch (e) {
    console.error('[ANALYTICS] Error incrementando ' + metric + ' uid=' + uid.substring(0,8) + ': ' + e.message);
    throw e;
  }
}

/**
 * Obtiene metricas de un periodo para un tenant.
 * @param {string} uid
 * @param {string} period - 'day'|'week'|'month'
 * @param {Date|number} [nowMs]
 * @returns {Promise<object>} { period, startDate, endDate, metrics: {metric: total} }
 */
async function getMetrics(uid, period, nowMs) {
  if (!uid) throw new Error('uid requerido');
  if (!PERIOD_TYPES.includes(period)) throw new Error('period invalido: ' + period);

  const now = nowMs ? new Date(nowMs) : new Date();
  const { start, end, days } = _getPeriodRange(period, now);

  const totals = {};
  for (const m of METRIC_TYPES) totals[m] = 0;

  try {
    const snap = await db().collection('analytics').doc(uid).collection('daily')
      .where('__name__', '>=', _dayKey(start))
      .where('__name__', '<=', _dayKey(end))
      .get();

    snap.forEach(doc => {
      const data = doc.data();
      for (const m of METRIC_TYPES) {
        if (typeof data[m] === 'number') totals[m] += data[m];
      }
    });
  } catch (e) {
    console.error('[ANALYTICS] Error leyendo metricas uid=' + uid.substring(0,8) + ': ' + e.message);
  }

  return {
    uid, period,
    startDate: _dayKey(start),
    endDate: _dayKey(end),
    days,
    metrics: totals,
    generatedAt: now.toISOString(),
  };
}

/**
 * Retorna un resumen de metricas diarias de los ultimos N dias.
 * @param {string} uid
 * @param {number} [nDays=7]
 * @param {Date|number} [nowMs]
 * @returns {Promise<Array<{date, metrics}>>}
 */
async function getDailyBreakdown(uid, nDays, nowMs) {
  if (!uid) throw new Error('uid requerido');
  if (nDays === undefined) nDays = 7;
  if (typeof nDays !== 'number' || nDays < 1 || nDays > 365) throw new Error('nDays debe ser entre 1 y 365');

  const now = nowMs ? new Date(nowMs) : new Date();
  const end = new Date(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - (nDays - 1));

  try {
    const snap = await db().collection('analytics').doc(uid).collection('daily')
      .where('__name__', '>=', _dayKey(start))
      .where('__name__', '<=', _dayKey(end))
      .get();

    const byDay = {};
    snap.forEach(doc => {
      byDay[doc.id] = doc.data();
    });

    const result = [];
    for (let i = 0; i < nDays; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      const key = _dayKey(d);
      const data = byDay[key] || {};
      const metrics = {};
      for (const m of METRIC_TYPES) metrics[m] = data[m] || 0;
      result.push({ date: key, metrics });
    }
    return result;
  } catch (e) {
    console.error('[ANALYTICS] Error en breakdown uid=' + uid.substring(0,8) + ': ' + e.message);
    return [];
  }
}

function _dayKey(date) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function _getPeriodRange(period, now) {
  const end = new Date(now);
  const start = new Date(now);

  if (period === 'day') {
    return { start: end, end, days: 1 };
  }
  if (period === 'week') {
    start.setUTCDate(start.getUTCDate() - 6);
    return { start, end, days: 7 };
  }
  if (period === 'month') {
    start.setUTCDate(start.getUTCDate() - 29);
    return { start, end, days: 30 };
  }
  return { start: end, end, days: 1 };
}

module.exports = {
  incrementMetric, getMetrics, getDailyBreakdown,
  METRIC_TYPES, PERIOD_TYPES,
  __setFirestoreForTests,
  _dayKey, _getPeriodRange,
};
