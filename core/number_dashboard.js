'use strict';

/**
 * MIIA — Number Dashboard (T195)
 * Estadísticas y métricas por número para el dashboard del owner.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const METRIC_FIELDS = Object.freeze(['messages_in', 'messages_out', 'leads_contacted', 'appointments', 'payments', 'handoffs']);
const DEFAULT_PERIOD_DAYS = 30;

async function recordNumberActivity(uid, phone, activityType, meta) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!activityType) throw new Error('activityType requerido');
  if (!METRIC_FIELDS.includes(activityType)) throw new Error('activityType invalido: ' + activityType);
  const docId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  const data = {
    uid, phone, activityType,
    meta: meta || {},
    recordedAt: new Date().toISOString(),
  };
  try {
    await db().collection('tenants').doc(uid).collection('number_activity').doc(docId).set(data);
    console.log('[NUMBER_DASHBOARD] uid=' + uid.substring(0, 8) + ' phone=' + phone + ' type=' + activityType);
  } catch (e) {
    console.error('[NUMBER_DASHBOARD] Error guardando actividad: ' + e.message);
    throw e;
  }
}

async function getNumberStats(uid, phone, periodDays, nowMs) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  const days = (typeof periodDays === 'number' && periodDays > 0) ? periodDays : DEFAULT_PERIOD_DAYS;
  const now = (typeof nowMs === 'number') ? nowMs : Date.now();
  const fromDate = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const snap = await db().collection('tenants').doc(uid).collection('number_activity')
      .where('phone', '==', phone).where('recordedAt', '>=', fromDate).get();
    const counts = {};
    METRIC_FIELDS.forEach(f => { counts[f] = 0; });
    snap.forEach(doc => {
      const type = doc.data().activityType;
      if (counts[type] !== undefined) counts[type]++;
    });
    const total = Object.values(counts).reduce((s, v) => s + v, 0);
    return { phone, counts, total, periodDays: days };
  } catch (e) {
    console.error('[NUMBER_DASHBOARD] Error leyendo stats: ' + e.message);
    const counts = {};
    METRIC_FIELDS.forEach(f => { counts[f] = 0; });
    return { phone, counts, total: 0, periodDays: days };
  }
}

async function getAllNumbersStats(uid, phones, periodDays, nowMs) {
  if (!uid) throw new Error('uid requerido');
  if (!Array.isArray(phones)) throw new Error('phones debe ser array');
  if (phones.length === 0) return [];
  const results = await Promise.all(phones.map(p => getNumberStats(uid, p, periodDays, nowMs)));
  return results.sort((a, b) => b.total - a.total);
}

async function getTopPerformingNumber(uid, phones, periodDays, nowMs) {
  if (!uid) throw new Error('uid requerido');
  const stats = await getAllNumbersStats(uid, phones, periodDays, nowMs);
  if (stats.length === 0) return null;
  return stats[0];
}

async function getDashboardSummary(uid, phones, periodDays, nowMs) {
  if (!uid) throw new Error('uid requerido');
  const allStats = await getAllNumbersStats(uid, phones || [], periodDays, nowMs);
  const totals = {};
  METRIC_FIELDS.forEach(f => { totals[f] = 0; });
  allStats.forEach(s => {
    METRIC_FIELDS.forEach(f => { totals[f] += s.counts[f] || 0; });
  });
  const grandTotal = Object.values(totals).reduce((s, v) => s + v, 0);
  return {
    numbers: allStats,
    totals,
    grandTotal,
    periodDays: (typeof periodDays === 'number' && periodDays > 0) ? periodDays : DEFAULT_PERIOD_DAYS,
  };
}

module.exports = {
  recordNumberActivity,
  getNumberStats,
  getAllNumbersStats,
  getTopPerformingNumber,
  getDashboardSummary,
  METRIC_FIELDS,
  DEFAULT_PERIOD_DAYS,
  __setFirestoreForTests,
};
