'use strict';

/**
 * MIIA — Response Time Tracker (T191)
 * Registra y analiza el tiempo promedio de respuesta de MIIA por owner.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const RESPONSE_BUCKETS = Object.freeze(['instant', 'fast', 'normal', 'slow', 'very_slow']);
const BUCKET_THRESHOLDS_MS = Object.freeze({
  instant: 5000,
  fast: 30000,
  normal: 120000,
  slow: 300000,
});

const MIN_RESPONSE_MS = 0;
const MAX_RESPONSE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PERIOD_DAYS = 7;

function classifyResponseTime(ms) {
  if (ms <= BUCKET_THRESHOLDS_MS.instant) return 'instant';
  if (ms <= BUCKET_THRESHOLDS_MS.fast) return 'fast';
  if (ms <= BUCKET_THRESHOLDS_MS.normal) return 'normal';
  if (ms <= BUCKET_THRESHOLDS_MS.slow) return 'slow';
  return 'very_slow';
}

/**
 * Registra un evento de respuesta para un owner.
 * @param {string} uid
 * @param {string} phone
 * @param {number} responseTimeMs
 * @param {object} meta
 */
async function recordResponseTime(uid, phone, responseTimeMs) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (typeof responseTimeMs !== 'number' || isNaN(responseTimeMs)) throw new Error('responseTimeMs debe ser numero');
  if (responseTimeMs < MIN_RESPONSE_MS) throw new Error('responseTimeMs no puede ser negativo');
  if (responseTimeMs > MAX_RESPONSE_MS) throw new Error('responseTimeMs excede maximo de 24h');

  const bucket = classifyResponseTime(responseTimeMs);
  const docId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  const data = {
    uid, phone,
    responseTimeMs,
    bucket,
    recordedAt: new Date().toISOString(),
  };

  try {
    await db().collection('tenants').doc(uid).collection('response_times').doc(docId).set(data);
    console.log('[RESPONSE_TRACKER] uid=' + uid.substring(0, 8) + ' phone=' + phone + ' ms=' + responseTimeMs + ' bucket=' + bucket);
  } catch (e) {
    console.error('[RESPONSE_TRACKER] Error guardando tiempo uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  }
}

/**
 * Obtiene el resumen estadístico de tiempos de respuesta.
 * @param {string} uid
 * @param {number} periodDays
 * @param {number} nowMs
 */
async function getResponseTimeSummary(uid, periodDays, nowMs) {
  if (!uid) throw new Error('uid requerido');
  const days = (typeof periodDays === 'number' && periodDays > 0) ? periodDays : DEFAULT_PERIOD_DAYS;
  const now = (typeof nowMs === 'number') ? nowMs : Date.now();
  const fromDate = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    const snap = await db().collection('tenants').doc(uid).collection('response_times')
      .where('recordedAt', '>=', fromDate).get();

    const records = [];
    snap.forEach(doc => records.push(doc.data()));

    if (records.length === 0) {
      return { count: 0, averageMs: 0, medianMs: 0, minMs: 0, maxMs: 0, buckets: _emptyBuckets(), periodDays: days };
    }

    const times = records.map(r => r.responseTimeMs).sort((a, b) => a - b);
    const total = times.reduce((s, t) => s + t, 0);
    const averageMs = Math.round(total / times.length);
    const medianMs = times.length % 2 === 0
      ? Math.round((times[times.length / 2 - 1] + times[times.length / 2]) / 2)
      : times[Math.floor(times.length / 2)];

    const buckets = _emptyBuckets();
    records.forEach(r => { buckets[r.bucket] = (buckets[r.bucket] || 0) + 1; });

    return {
      count: records.length,
      averageMs,
      medianMs,
      minMs: times[0],
      maxMs: times[times.length - 1],
      buckets,
      periodDays: days,
    };
  } catch (e) {
    console.error('[RESPONSE_TRACKER] Error leyendo summary uid=' + uid.substring(0, 8) + ': ' + e.message);
    return { count: 0, averageMs: 0, medianMs: 0, minMs: 0, maxMs: 0, buckets: _emptyBuckets(), periodDays: days };
  }
}

function _emptyBuckets() {
  const b = {};
  RESPONSE_BUCKETS.forEach(k => { b[k] = 0; });
  return b;
}

/**
 * Calcula percentil P90 de tiempos de respuesta.
 */
async function getP90ResponseTime(uid, periodDays, nowMs) {
  if (!uid) throw new Error('uid requerido');
  const summary = await getResponseTimeSummary(uid, periodDays, nowMs);
  if (summary.count === 0) return { p90Ms: 0, count: 0 };

  const days = (typeof periodDays === 'number' && periodDays > 0) ? periodDays : DEFAULT_PERIOD_DAYS;
  const now = (typeof nowMs === 'number') ? nowMs : Date.now();
  const fromDate = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    const snap = await db().collection('tenants').doc(uid).collection('response_times')
      .where('recordedAt', '>=', fromDate).get();
    const times = [];
    snap.forEach(doc => times.push(doc.data().responseTimeMs));
    times.sort((a, b) => a - b);
    const idx = Math.min(Math.floor(times.length * 0.9), times.length - 1);
    return { p90Ms: times[Math.max(0, idx)], count: times.length };
  } catch (e) {
    console.error('[RESPONSE_TRACKER] Error calculando P90 uid=' + uid.substring(0, 8) + ': ' + e.message);
    return { p90Ms: 0, count: 0 };
  }
}

/**
 * Compara tiempos de respuesta entre dos períodos.
 */
async function compareResponseTimes(uid, periodDays, nowMs) {
  if (!uid) throw new Error('uid requerido');
  const now = (typeof nowMs === 'number') ? nowMs : Date.now();
  const days = (typeof periodDays === 'number' && periodDays > 0) ? periodDays : DEFAULT_PERIOD_DAYS;

  const current = await getResponseTimeSummary(uid, days, now);
  const previous = await getResponseTimeSummary(uid, days, now - days * 24 * 60 * 60 * 1000);

  let changePercent = 0;
  if (previous.averageMs > 0) {
    changePercent = Math.round(((current.averageMs - previous.averageMs) / previous.averageMs) * 100);
  }

  const trend = changePercent < -5 ? 'improving' : changePercent > 5 ? 'degrading' : 'stable';

  return { current, previous, changePercent, trend };
}

module.exports = {
  recordResponseTime,
  getResponseTimeSummary,
  getP90ResponseTime,
  compareResponseTimes,
  classifyResponseTime,
  RESPONSE_BUCKETS,
  BUCKET_THRESHOLDS_MS,
  MIN_RESPONSE_MS,
  MAX_RESPONSE_MS,
  DEFAULT_PERIOD_DAYS,
  __setFirestoreForTests,
};
