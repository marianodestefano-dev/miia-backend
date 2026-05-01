'use strict';

/**
 * MIIA - Anomaly Detector (T215)
 * Deteccion de acceso anomalo y alerta al owner.
 */

const ANOMALY_TYPES = Object.freeze([
  'multiple_failed_logins', 'new_device', 'new_location', 'unusual_hour',
  'high_volume_export', 'rapid_config_changes', 'api_key_multiple_rotations',
]);

const SEVERITY = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' });
const DEFAULT_WINDOW_MINUTES = 60;
const MAX_FAILED_LOGINS = 5;
const MAX_EXPORTS_PER_HOUR = 3;
const UNUSUAL_HOUR_START = 0;  // midnight
const UNUSUAL_HOUR_END = 6;    // 6am

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isUnusualHour(timestampMs) {
  var h = new Date(timestampMs).getUTCHours();
  return h >= UNUSUAL_HOUR_START && h < UNUSUAL_HOUR_END;
}

function classifyAnomaly(type, context) {
  if (!ANOMALY_TYPES.includes(type)) throw new Error('type invalido: ' + type);
  var sev = SEVERITY.LOW;
  switch (type) {
    case 'multiple_failed_logins':
      sev = (context && context.count >= MAX_FAILED_LOGINS * 2) ? SEVERITY.CRITICAL : SEVERITY.HIGH;
      break;
    case 'api_key_multiple_rotations':
      sev = SEVERITY.CRITICAL;
      break;
    case 'high_volume_export':
      sev = SEVERITY.MEDIUM;
      break;
    case 'new_device':
    case 'new_location':
      sev = SEVERITY.MEDIUM;
      break;
    case 'unusual_hour':
      sev = SEVERITY.LOW;
      break;
    case 'rapid_config_changes':
      sev = SEVERITY.HIGH;
      break;
    default:
      sev = SEVERITY.LOW;
  }
  return { type, severity: sev, context: context || {} };
}

async function recordAnomaly(uid, type, context) {
  if (!uid) throw new Error('uid requerido');
  if (!type) throw new Error('type requerido');
  var anomaly = classifyAnomaly(type, context);
  anomaly.uid = uid;
  anomaly.timestamp = new Date().toISOString();
  anomaly.resolved = false;
  var docId = uid.substring(0, 8) + '_' + type + '_' + Date.now().toString(36);
  try {
    await db().collection('tenants').doc(uid).collection('anomalies').doc(docId).set(anomaly);
    console.log('[ANOMALY] ' + type + ' (' + anomaly.severity + ') para ' + uid);
    return { anomalyId: docId, severity: anomaly.severity, timestamp: anomaly.timestamp };
  } catch (e) {
    console.error('[ANOMALY] Error guardando anomalia: ' + e.message);
    throw e;
  }
}

async function getOpenAnomalies(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('anomalies').where('resolved', '==', false).get();
    var result = [];
    snap.forEach(function(doc) { result.push(Object.assign({ anomalyId: doc.id }, doc.data())); });
    result.sort(function(a, b) { return new Date(b.timestamp || 0) - new Date(a.timestamp || 0); });
    return result;
  } catch (e) {
    console.error('[ANOMALY] Error leyendo anomalias: ' + e.message);
    return [];
  }
}

async function resolveAnomaly(uid, anomalyId) {
  if (!uid) throw new Error('uid requerido');
  if (!anomalyId) throw new Error('anomalyId requerido');
  try {
    await db().collection('tenants').doc(uid).collection('anomalies').doc(anomalyId).set({ resolved: true, resolvedAt: new Date().toISOString() }, { merge: true });
  } catch (e) {
    console.error('[ANOMALY] Error resolviendo anomalia: ' + e.message);
    throw e;
  }
}

async function checkFailedLogins(uid, recentCount) {
  if (!uid) throw new Error('uid requerido');
  if (typeof recentCount !== 'number') throw new Error('recentCount debe ser numero');
  if (recentCount >= MAX_FAILED_LOGINS) {
    return recordAnomaly(uid, 'multiple_failed_logins', { count: recentCount });
  }
  return null;
}

module.exports = {
  isUnusualHour,
  classifyAnomaly,
  recordAnomaly,
  getOpenAnomalies,
  resolveAnomaly,
  checkFailedLogins,
  ANOMALY_TYPES,
  SEVERITY,
  MAX_FAILED_LOGINS,
  MAX_EXPORTS_PER_HOUR,
  UNUSUAL_HOUR_START,
  UNUSUAL_HOUR_END,
  __setFirestoreForTests,
};
