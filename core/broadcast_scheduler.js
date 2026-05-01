'use strict';

/**
 * MIIA - Broadcast Scheduler (T203)
 * Cron de envio automatico de broadcasts programados.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const BROADCAST_STATES = Object.freeze(['draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed']);
const MAX_RECIPIENTS_PER_BROADCAST = 1000;
const MAX_BROADCASTS_PER_DAY = 5;
const MIN_SCHEDULE_AHEAD_MINS = 5;

async function scheduleBroadcast(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!opts || !opts.message) throw new Error('message requerido');
  if (!Array.isArray(opts.recipients) || opts.recipients.length === 0) throw new Error('recipients debe ser array no vacio');
  if (opts.recipients.length > MAX_RECIPIENTS_PER_BROADCAST) throw new Error('recipients supera el maximo de ' + MAX_RECIPIENTS_PER_BROADCAST);
  var sendAt = opts.sendAt || new Date().toISOString();
  var minTime = new Date(Date.now() + MIN_SCHEDULE_AHEAD_MINS * 60 * 1000);
  if (new Date(sendAt) < minTime && !opts._allowImmediate) throw new Error('sendAt debe ser al menos ' + MIN_SCHEDULE_AHEAD_MINS + ' minutos en el futuro');
  var broadcastId = uid.substring(0, 8) + '_bc_' + Date.now().toString(36);
  var data = {
    uid, broadcastId,
    message: opts.message,
    recipients: opts.recipients,
    recipientCount: opts.recipients.length,
    sendAt,
    state: 'scheduled',
    createdAt: new Date().toISOString(),
    sentAt: null,
    tags: opts.tags || [],
    mediaUrl: opts.mediaUrl || null,
  };
  try {
    await db().collection('broadcast_queue').doc(uid).collection('broadcasts').doc(broadcastId).set(data);
    console.log('[BROADCAST_SCHEDULER] Programado uid=' + uid.substring(0, 8) + ' broadcastId=' + broadcastId + ' recipients=' + opts.recipients.length);
    return { broadcastId, sendAt, recipientCount: opts.recipients.length, state: 'scheduled' };
  } catch (e) {
    console.error('[BROADCAST_SCHEDULER] Error guardando: ' + e.message);
    throw e;
  }
}

async function getDueBroadcasts(uid, nowMs) {
  if (!uid) throw new Error('uid requerido');
  var now = typeof nowMs === 'number' ? new Date(nowMs).toISOString() : new Date().toISOString();
  try {
    var snap = await db().collection('broadcast_queue').doc(uid).collection('broadcasts')
      .where('state', '==', 'scheduled').where('sendAt', '<=', now).get();
    var results = [];
    snap.forEach(function(doc) { results.push(doc.data()); });
    return results.sort(function(a, b) { return new Date(a.sendAt) - new Date(b.sendAt); });
  } catch (e) {
    console.error('[BROADCAST_SCHEDULER] Error leyendo due: ' + e.message);
    return [];
  }
}

async function markBroadcastSent(uid, broadcastId, result) {
  if (!uid) throw new Error('uid requerido');
  if (!broadcastId) throw new Error('broadcastId requerido');
  try {
    await db().collection('broadcast_queue').doc(uid).collection('broadcasts').doc(broadcastId).set(
      { state: 'sent', sentAt: new Date().toISOString(), result: result || null },
      { merge: true }
    );
  } catch (e) {
    console.error('[BROADCAST_SCHEDULER] Error marcando enviado: ' + e.message);
    throw e;
  }
}

async function cancelBroadcast(uid, broadcastId) {
  if (!uid) throw new Error('uid requerido');
  if (!broadcastId) throw new Error('broadcastId requerido');
  try {
    await db().collection('broadcast_queue').doc(uid).collection('broadcasts').doc(broadcastId).set(
      { state: 'cancelled', cancelledAt: new Date().toISOString() },
      { merge: true }
    );
    return { cancelled: true };
  } catch (e) {
    console.error('[BROADCAST_SCHEDULER] Error cancelando: ' + e.message);
    throw e;
  }
}

async function getBroadcastHistory(uid, limit) {
  if (!uid) throw new Error('uid requerido');
  var maxItems = typeof limit === 'number' ? Math.min(limit, 100) : 20;
  try {
    var snap = await db().collection('broadcast_queue').doc(uid).collection('broadcasts').get();
    var results = [];
    snap.forEach(function(doc) { results.push(doc.data()); });
    return results
      .sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); })
      .slice(0, maxItems);
  } catch (e) {
    console.error('[BROADCAST_SCHEDULER] Error leyendo historial: ' + e.message);
    return [];
  }
}

module.exports = {
  scheduleBroadcast,
  getDueBroadcasts,
  markBroadcastSent,
  cancelBroadcast,
  getBroadcastHistory,
  BROADCAST_STATES,
  MAX_RECIPIENTS_PER_BROADCAST,
  MAX_BROADCASTS_PER_DAY,
  MIN_SCHEDULE_AHEAD_MINS,
  __setFirestoreForTests,
};