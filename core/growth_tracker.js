'use strict';

/**
 * MIIA - Growth Tracker (T218)
 * Rastrea metricas de crecimiento del negocio: nuevos leads, conversiones, retencion.
 */

const GROWTH_METRICS = Object.freeze([
  'new_leads', 'converted_leads', 'lost_leads', 'returning_contacts',
  'broadcast_reach', 'referrals_sent', 'referrals_converted',
  'messages_total', 'active_contacts',
]);

const PERIOD_TYPES = Object.freeze(['daily', 'weekly', 'monthly']);
const DEFAULT_PERIOD = 'weekly';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function getPeriodKey(periodType, date) {
  var d = date ? new Date(date) : new Date();
  if (!PERIOD_TYPES.includes(periodType)) throw new Error('periodType invalido: ' + periodType);
  if (periodType === 'daily') return d.toISOString().slice(0, 10);
  if (periodType === 'monthly') return d.toISOString().slice(0, 7);
  // weekly: YYYY-WNN
  var year = d.getUTCFullYear();
  var start = new Date(Date.UTC(year, 0, 1));
  var weekNum = Math.ceil(((d - start) / 86400000 + start.getUTCDay() + 1) / 7);
  return year + '-W' + String(weekNum).padStart(2, '0');
}

function isValidMetric(metric) {
  return GROWTH_METRICS.includes(metric);
}

async function recordGrowthEvent(uid, metric, amount, periodType) {
  if (!uid) throw new Error('uid requerido');
  if (!metric) throw new Error('metric requerido');
  if (!isValidMetric(metric)) throw new Error('metric invalida: ' + metric);
  var n = (typeof amount === 'number' && amount > 0) ? amount : 1;
  var period = periodType || DEFAULT_PERIOD;
  if (!PERIOD_TYPES.includes(period)) throw new Error('periodType invalido');
  var periodKey = getPeriodKey(period);
  var docId = period + '_' + periodKey;
  var update = {};
  update[metric] = n;
  try {
    await db().collection('tenants').doc(uid).collection('growth_metrics').doc(docId).set(update, { merge: true });
    console.log('[GROWTH] ' + metric + ' +' + n + ' para ' + uid + ' en ' + periodKey);
  } catch (e) {
    console.error('[GROWTH] Error guardando metrica: ' + e.message);
    throw e;
  }
}

async function getGrowthPeriod(uid, periodType, periodKey) {
  if (!uid) throw new Error('uid requerido');
  var period = periodType || DEFAULT_PERIOD;
  var key = periodKey || getPeriodKey(period);
  var docId = period + '_' + key;
  try {
    var snap = await db().collection('tenants').doc(uid).collection('growth_metrics').doc(docId).get();
    if (!snap.exists) return { period: key, metrics: {} };
    return { period: key, metrics: snap.data() || {} };
  } catch (e) {
    console.error('[GROWTH] Error leyendo periodo: ' + e.message);
    return { period: key, metrics: {} };
  }
}

function calculateConversionRate(newLeads, convertedLeads) {
  if (typeof newLeads !== 'number' || newLeads < 0) throw new Error('newLeads invalido');
  if (typeof convertedLeads !== 'number' || convertedLeads < 0) throw new Error('convertedLeads invalido');
  if (newLeads === 0) return 0;
  return Math.round((convertedLeads / newLeads) * 100 * 10) / 10;
}

function calculateRetentionRate(totalContacts, returningContacts) {
  if (typeof totalContacts !== 'number' || totalContacts <= 0) throw new Error('totalContacts invalido');
  if (typeof returningContacts !== 'number' || returningContacts < 0) throw new Error('returningContacts invalido');
  return Math.round((returningContacts / totalContacts) * 100 * 10) / 10;
}

function buildGrowthSummary(metricsData) {
  if (!metricsData || typeof metricsData !== 'object') return { conversionRate: 0, retentionRate: 0, totalActivity: 0 };
  var newLeads = metricsData.new_leads || 0;
  var converted = metricsData.converted_leads || 0;
  var returning = metricsData.returning_contacts || 0;
  var total = metricsData.messages_total || 0;
  var convRate = newLeads > 0 ? calculateConversionRate(newLeads, converted) : 0;
  var retRate = newLeads > 0 ? calculateRetentionRate(newLeads, returning) : 0;
  return {
    conversionRate: convRate,
    retentionRate: retRate,
    totalActivity: total,
    newLeads,
    convertedLeads: converted,
  };
}

module.exports = {
  getPeriodKey,
  isValidMetric,
  recordGrowthEvent,
  getGrowthPeriod,
  calculateConversionRate,
  calculateRetentionRate,
  buildGrowthSummary,
  GROWTH_METRICS,
  PERIOD_TYPES,
  DEFAULT_PERIOD,
  __setFirestoreForTests,
};
