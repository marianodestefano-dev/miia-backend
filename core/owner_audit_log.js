'use strict';

/**
 * MIIA - Owner Audit Log (T214)
 * Registro inmutable de acciones del owner en el dashboard.
 */

const ACTION_TYPES = Object.freeze([
  'login', 'logout', 'config_change', 'contact_edit', 'contact_delete',
  'broadcast_send', 'persona_update', 'export_data', 'integration_connect',
  'integration_disconnect', 'api_key_rotate', 'handoff_assign', 'handoff_close',
]);

const SEVERITY_LEVELS = Object.freeze(['info', 'warning', 'critical']);
const DEFAULT_SEVERITY = 'info';
const MAX_LOG_ENTRIES_PER_QUERY = 100;
const LOG_RETENTION_DAYS = 365;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidAction(action) {
  return ACTION_TYPES.includes(action);
}

function isValidSeverity(severity) {
  return SEVERITY_LEVELS.includes(severity);
}

async function logAction(uid, action, meta) {
  if (!uid) throw new Error('uid requerido');
  if (!action) throw new Error('action requerido');
  if (!isValidAction(action)) throw new Error('action invalido: ' + action);
  var severity = (meta && meta.severity && isValidSeverity(meta.severity)) ? meta.severity : DEFAULT_SEVERITY;
  var entry = {
    uid,
    action,
    severity,
    timestamp: new Date().toISOString(),
    ip: (meta && meta.ip) || null,
    userAgent: (meta && meta.userAgent) || null,
    details: (meta && meta.details) || null,
    sessionId: (meta && meta.sessionId) || null,
  };
  var entryId = uid.substring(0, 8) + '_' + action + '_' + Date.now().toString(36);
  try {
    await db().collection('tenants').doc(uid).collection('audit_log').doc(entryId).set(entry);
    console.log('[AUDIT_LOG] ' + action + ' (' + severity + ') para ' + uid);
    return { entryId, timestamp: entry.timestamp };
  } catch (e) {
    console.error('[AUDIT_LOG] Error guardando entrada: ' + e.message);
    throw e;
  }
}

async function getAuditLog(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  var limit = (opts && opts.limit && opts.limit > 0) ? Math.min(opts.limit, MAX_LOG_ENTRIES_PER_QUERY) : MAX_LOG_ENTRIES_PER_QUERY;
  try {
    var coll = db().collection('tenants').doc(uid).collection('audit_log');
    var snap = await coll.limit(limit).get();
    var entries = [];
    snap.forEach(function(doc) { entries.push(Object.assign({ entryId: doc.id }, doc.data())); });
    entries.sort(function(a, b) { return new Date(b.timestamp || 0) - new Date(a.timestamp || 0); });
    return entries;
  } catch (e) {
    console.error('[AUDIT_LOG] Error leyendo log: ' + e.message);
    return [];
  }
}

async function getActionsByType(uid, action) {
  if (!uid) throw new Error('uid requerido');
  if (!action) throw new Error('action requerido');
  if (!isValidAction(action)) throw new Error('action invalido: ' + action);
  try {
    var coll = db().collection('tenants').doc(uid).collection('audit_log');
    var snap = await coll.where('action', '==', action).get();
    var entries = [];
    snap.forEach(function(doc) { entries.push(Object.assign({ entryId: doc.id }, doc.data())); });
    return entries;
  } catch (e) {
    console.error('[AUDIT_LOG] Error leyendo por tipo: ' + e.message);
    return [];
  }
}

async function getCriticalActions(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var coll = db().collection('tenants').doc(uid).collection('audit_log');
    var snap = await coll.where('severity', '==', 'critical').get();
    var entries = [];
    snap.forEach(function(doc) { entries.push(Object.assign({ entryId: doc.id }, doc.data())); });
    return entries;
  } catch (e) {
    console.error('[AUDIT_LOG] Error leyendo criticos: ' + e.message);
    return [];
  }
}

module.exports = {
  isValidAction,
  isValidSeverity,
  logAction,
  getAuditLog,
  getActionsByType,
  getCriticalActions,
  ACTION_TYPES,
  SEVERITY_LEVELS,
  DEFAULT_SEVERITY,
  MAX_LOG_ENTRIES_PER_QUERY,
  LOG_RETENTION_DAYS,
  __setFirestoreForTests,
};
