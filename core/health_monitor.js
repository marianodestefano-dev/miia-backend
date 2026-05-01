'use strict';

/**
 * MIIA - Health Monitor (T225)
 * Monitorea la salud del sistema MIIA para el owner: WhatsApp, Firestore, engines, rate limits.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const HEALTH_COMPONENTS = Object.freeze([
  'whatsapp', 'firestore', 'gemini', 'scheduler', 'rate_limiter', 'handoff', 'broadcast'
]);

const HEALTH_STATUSES = Object.freeze(['healthy', 'degraded', 'down', 'unknown']);

const ALERT_LEVELS = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
});

const DISCONNECT_THRESHOLD_MS = 10 * 60 * 1000;
const HEALTH_HISTORY_LIMIT = 100;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

function isValidComponent(component) {
  return HEALTH_COMPONENTS.includes(component);
}

function isValidStatus(status) {
  return HEALTH_STATUSES.includes(status);
}

function buildHealthRecord(component, status, meta) {
  return {
    component,
    status,
    checkedAt: new Date().toISOString(),
    latencyMs: (meta && meta.latencyMs !== undefined) ? meta.latencyMs : null,
    message: (meta && meta.message) ? String(meta.message) : null,
    extra: (meta && meta.extra) ? meta.extra : null,
  };
}

async function recordHealthCheck(uid, component, status, meta) {
  if (!uid) throw new Error('uid requerido');
  if (!component) throw new Error('component requerido');
  if (!isValidComponent(component)) throw new Error('component invalido: ' + component);
  if (!isValidStatus(status)) throw new Error('status invalido: ' + status);
  var record = buildHealthRecord(component, status, meta);
  var docId = component + '_' + Date.now().toString(36);
  await db().collection('tenants').doc(uid).collection('health_checks').doc(docId).set(record);
  if (status === 'down' || status === 'degraded') {
    console.warn('[HEALTH_MONITOR] ' + component + ' es ' + status + ' uid=' + uid + ' msg=' + (record.message || ''));
  }
  return { docId, record };
}

async function getComponentHealth(uid, component) {
  if (!uid) throw new Error('uid requerido');
  if (!isValidComponent(component)) throw new Error('component invalido: ' + component);
  try {
    var snap = await db().collection('tenants').doc(uid).collection('health_checks')
      .where('component', '==', component)
      .get();
    var records = [];
    snap.forEach(function(doc) { records.push(doc.data()); });
    if (records.length === 0) return { component, status: 'unknown', lastCheck: null };
    records.sort(function(a, b) { return new Date(b.checkedAt) - new Date(a.checkedAt); });
    var latest = records[0];
    return { component, status: latest.status, lastCheck: latest.checkedAt, message: latest.message };
  } catch (e) {
    console.error('[HEALTH_MONITOR] Error leyendo health de ' + component + ': ' + e.message);
    return { component, status: 'unknown', lastCheck: null };
  }
}

async function getSystemHealthSummary(uid) {
  if (!uid) throw new Error('uid requerido');
  var results = {};
  var overallStatus = 'healthy';
  for (var comp of HEALTH_COMPONENTS) {
    var h = await getComponentHealth(uid, comp);
    results[comp] = h;
    if (h.status === 'down') overallStatus = 'down';
    else if (h.status === 'degraded' && overallStatus !== 'down') overallStatus = 'degraded';
    else if (h.status === 'unknown' && overallStatus === 'healthy') overallStatus = 'degraded';
  }
  return {
    uid,
    overallStatus,
    components: results,
    generatedAt: new Date().toISOString(),
  };
}

function assessWhatsAppHealth(lastSeenMs, nowMs) {
  var now = nowMs !== undefined ? nowMs : Date.now();
  if (!lastSeenMs) return { status: 'unknown', message: 'Sin datos de conexion' };
  var elapsed = now - lastSeenMs;
  if (elapsed > DISCONNECT_THRESHOLD_MS) {
    return {
      status: 'down',
      message: 'WhatsApp desconectado hace ' + Math.round(elapsed / 60000) + ' minutos',
      elapsedMs: elapsed,
    };
  }
  if (elapsed > DISCONNECT_THRESHOLD_MS / 2) {
    return {
      status: 'degraded',
      message: 'WhatsApp sin actividad reciente',
      elapsedMs: elapsed,
    };
  }
  return { status: 'healthy', elapsedMs: elapsed };
}

function generateHealthAlert(component, status, message) {
  var level;
  if (status === 'down') level = ALERT_LEVELS.CRITICAL;
  else if (status === 'degraded') level = ALERT_LEVELS.WARNING;
  else level = ALERT_LEVELS.INFO;
  return {
    level,
    component,
    status,
    message: message || (component + ' esta ' + status),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  recordHealthCheck,
  getComponentHealth,
  getSystemHealthSummary,
  assessWhatsAppHealth,
  generateHealthAlert,
  isValidComponent,
  isValidStatus,
  HEALTH_COMPONENTS,
  HEALTH_STATUSES,
  ALERT_LEVELS,
  DISCONNECT_THRESHOLD_MS,
  HEALTH_HISTORY_LIMIT,
  CHECK_INTERVAL_MS,
  __setFirestoreForTests,
};
