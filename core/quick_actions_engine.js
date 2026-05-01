'use strict';

/**
 * MIIA - Quick Actions Engine (T224)
 * Motor de acciones rapidas ejecutables desde el dashboard del owner.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const ACTION_TYPES = Object.freeze([
  'pause_miia', 'resume_miia', 'set_ooo', 'clear_ooo',
  'block_contact', 'unblock_contact', 'archive_conversation',
  'send_template', 'trigger_broadcast', 'reset_context',
  'export_contacts', 'clear_pending_alerts',
]);

const ACTION_STATUSES = Object.freeze(['queued', 'executing', 'done', 'failed', 'cancelled']);
const MAX_QUEUE_SIZE = 50;
const ACTION_TTL_MS = 24 * 60 * 60 * 1000;

function isValidAction(type) {
  return ACTION_TYPES.includes(type);
}

function buildActionRecord(uid, type, params, opts) {
  var now = new Date().toISOString();
  return {
    uid,
    type,
    params: params || {},
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    executedAt: null,
    result: null,
    error: null,
    triggeredBy: (opts && opts.triggeredBy) ? opts.triggeredBy : 'owner_dashboard',
  };
}

async function enqueueAction(uid, type, params, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!type) throw new Error('type requerido');
  if (!isValidAction(type)) throw new Error('action type invalido: ' + type);
  var record = buildActionRecord(uid, type, params, opts);
  var actionId = 'qa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  await db().collection('tenants').doc(uid).collection('quick_actions').doc(actionId).set(record);
  console.log('[QUICK_ACTIONS] Encolado uid=' + uid + ' type=' + type + ' id=' + actionId);
  return { actionId, record };
}

async function updateActionStatus(uid, actionId, status, result, errorMsg) {
  if (!uid) throw new Error('uid requerido');
  if (!actionId) throw new Error('actionId requerido');
  if (!ACTION_STATUSES.includes(status)) throw new Error('status invalido: ' + status);
  var update = {
    status,
    updatedAt: new Date().toISOString(),
    result: result !== undefined ? result : null,
    error: errorMsg || null,
  };
  if (status === 'executing' || status === 'done' || status === 'failed') {
    update.executedAt = new Date().toISOString();
  }
  await db().collection('tenants').doc(uid).collection('quick_actions').doc(actionId).set(update, { merge: true });
  console.log('[QUICK_ACTIONS] Status actualizado uid=' + uid + ' id=' + actionId + ' status=' + status);
}

async function getQueuedActions(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('quick_actions')
      .where('status', '==', 'queued')
      .get();
    var results = [];
    snap.forEach(function(doc) { results.push({ id: doc.id, ...doc.data() }); });
    results.sort(function(a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });
    return results.slice(0, MAX_QUEUE_SIZE);
  } catch (e) {
    console.error('[QUICK_ACTIONS] Error leyendo cola: ' + e.message);
    return [];
  }
}

async function getRecentActions(uid, limitCount) {
  if (!uid) throw new Error('uid requerido');
  var limit = limitCount || 20;
  try {
    var snap = await db().collection('tenants').doc(uid).collection('quick_actions').get();
    var results = [];
    snap.forEach(function(doc) { results.push({ id: doc.id, ...doc.data() }); });
    results.sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    return results.slice(0, limit);
  } catch (e) {
    console.error('[QUICK_ACTIONS] Error leyendo historial: ' + e.message);
    return [];
  }
}

async function cancelAction(uid, actionId) {
  if (!uid) throw new Error('uid requerido');
  if (!actionId) throw new Error('actionId requerido');
  await updateActionStatus(uid, actionId, 'cancelled', null, 'Cancelado por owner');
}

function isActionExpired(record, nowMs) {
  if (!record || !record.createdAt) return false;
  var now = nowMs !== undefined ? nowMs : Date.now();
  return now - new Date(record.createdAt).getTime() > ACTION_TTL_MS;
}

function summarizeQueue(actions) {
  var byType = {};
  var byStatus = {};
  actions.forEach(function(a) {
    byType[a.type] = (byType[a.type] || 0) + 1;
    byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  });
  return {
    total: actions.length,
    byType,
    byStatus,
    hasPendingActions: actions.some(function(a) { return a.status === 'queued'; }),
  };
}

module.exports = {
  enqueueAction,
  updateActionStatus,
  getQueuedActions,
  getRecentActions,
  cancelAction,
  isActionExpired,
  summarizeQueue,
  isValidAction,
  ACTION_TYPES,
  ACTION_STATUSES,
  MAX_QUEUE_SIZE,
  ACTION_TTL_MS,
  __setFirestoreForTests,
};
