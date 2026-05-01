'use strict';

/**
 * MIIA - Handoff Manager (T223)
 * Gestiona el traspaso de conversaciones entre MIIA y un agente humano.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const HANDOFF_STATUSES = Object.freeze(['pending', 'active', 'resolved', 'cancelled', 'timeout']);
const HANDOFF_REASONS = Object.freeze([
  'owner_request', 'lead_request', 'complex_query', 'complaint', 'payment', 'emergency', 'auto_escalation'
]);
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_HANDOFFS_PER_QUERY = 100;

function isValidStatus(status) {
  return HANDOFF_STATUSES.includes(status);
}

function isValidReason(reason) {
  return HANDOFF_REASONS.includes(reason);
}

function buildHandoffRecord(uid, phone, reason, opts) {
  var now = new Date().toISOString();
  var timeoutMs = (opts && opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  var expiresAt = new Date(Date.now() + timeoutMs).toISOString();
  return {
    uid,
    phone,
    reason,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    expiresAt,
    agentId: (opts && opts.agentId) ? opts.agentId : null,
    notes: (opts && opts.notes) ? String(opts.notes) : null,
    resolvedAt: null,
    resolutionNotes: null,
  };
}

async function requestHandoff(uid, phone, reason, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!reason) throw new Error('reason requerido');
  if (!isValidReason(reason)) throw new Error('reason invalido: ' + reason);
  var record = buildHandoffRecord(uid, phone, reason, opts);
  var handoffId = uid.slice(0, 4) + '_' + phone.replace(/\D/g, '').slice(-6) + '_' + Date.now().toString(36);
  await db().collection('tenants').doc(uid).collection('handoffs').doc(handoffId).set(record);
  console.log('[HANDOFF] Traspaso solicitado uid=' + uid + ' phone=' + phone + ' reason=' + reason + ' id=' + handoffId);
  return { handoffId, record };
}

async function updateHandoffStatus(uid, handoffId, status, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!handoffId) throw new Error('handoffId requerido');
  if (!isValidStatus(status)) throw new Error('status invalido: ' + status);
  var update = {
    status,
    updatedAt: new Date().toISOString(),
  };
  if (opts && opts.agentId) update.agentId = opts.agentId;
  if (opts && opts.notes) update.resolutionNotes = String(opts.notes);
  if (status === 'resolved' || status === 'cancelled') update.resolvedAt = new Date().toISOString();
  await db().collection('tenants').doc(uid).collection('handoffs').doc(handoffId).set(update, { merge: true });
  console.log('[HANDOFF] Status actualizado uid=' + uid + ' id=' + handoffId + ' status=' + status);
}

async function getActiveHandoffs(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('handoffs')
      .where('status', 'in', ['pending', 'active'])
      .get();
    var results = [];
    snap.forEach(function(doc) { results.push({ id: doc.id, ...doc.data() }); });
    return results;
  } catch (e) {
    console.error('[HANDOFF] Error leyendo handoffs activos: ' + e.message);
    return [];
  }
}

async function getHandoffsByPhone(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('handoffs')
      .where('phone', '==', phone)
      .get();
    var results = [];
    snap.forEach(function(doc) { results.push({ id: doc.id, ...doc.data() }); });
    results.sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    return results.slice(0, MAX_HANDOFFS_PER_QUERY);
  } catch (e) {
    console.error('[HANDOFF] Error leyendo handoffs por phone: ' + e.message);
    return [];
  }
}

function isHandoffExpired(record, nowMs) {
  if (!record || !record.expiresAt) return false;
  var now = nowMs !== undefined ? nowMs : Date.now();
  return new Date(record.expiresAt).getTime() <= now;
}

async function timeoutExpiredHandoffs(uid, nowMs) {
  if (!uid) throw new Error('uid requerido');
  var active = await getActiveHandoffs(uid);
  var expired = active.filter(function(h) { return isHandoffExpired(h, nowMs); });
  var count = 0;
  for (var h of expired) {
    try {
      await updateHandoffStatus(uid, h.id, 'timeout', { notes: 'Auto-timeout por inactividad' });
      count++;
    } catch (e) {
      console.error('[HANDOFF] Error marcando timeout id=' + h.id + ': ' + e.message);
    }
  }
  console.log('[HANDOFF] Timeouts procesados uid=' + uid + ' count=' + count);
  return { timedOut: count, total: expired.length };
}

function buildHandoffNotificationText(phone, reason) {
  var reasonLabels = {
    owner_request: 'solicitud del owner',
    lead_request: 'solicitud del lead',
    complex_query: 'consulta compleja',
    complaint: 'reclamo',
    payment: 'consulta de pago',
    emergency: 'emergencia',
    auto_escalation: 'escalado automático',
  };
  var label = reasonLabels[reason] || reason;
  return 'MIIA transfirió la conversación con ' + phone + ' por: ' + label + '. Por favor retomá la charla.';
}

module.exports = {
  requestHandoff,
  updateHandoffStatus,
  getActiveHandoffs,
  getHandoffsByPhone,
  isHandoffExpired,
  timeoutExpiredHandoffs,
  buildHandoffNotificationText,
  isValidStatus,
  isValidReason,
  HANDOFF_STATUSES,
  HANDOFF_REASONS,
  DEFAULT_TIMEOUT_MS,
  MAX_HANDOFFS_PER_QUERY,
  __setFirestoreForTests,
};
