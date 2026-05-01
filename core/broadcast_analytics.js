'use strict';

/**
 * MIIA - Broadcast Analytics (T205)
 * Estadisticas de broadcast: entregados, leidos, replies.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const EVENT_TYPES = Object.freeze(['delivered', 'read', 'replied', 'failed', 'opted_out']);

async function recordBroadcastEvent(uid, broadcastId, phone, eventType, meta) {
  if (!uid) throw new Error('uid requerido');
  if (!broadcastId) throw new Error('broadcastId requerido');
  if (!phone) throw new Error('phone requerido');
  if (!EVENT_TYPES.includes(eventType)) throw new Error('eventType invalido: ' + eventType);
  var docId = broadcastId + '_' + phone.replace('+', '') + '_' + eventType;
  var data = {
    uid, broadcastId, phone, eventType,
    meta: meta || {},
    recordedAt: new Date().toISOString(),
  };
  try {
    await db().collection('broadcast_events').doc(uid).collection('events').doc(docId).set(data, { merge: true });
  } catch (e) {
    console.error('[BROADCAST_ANALYTICS] Error guardando evento: ' + e.message);
    throw e;
  }
}

async function getBroadcastStats(uid, broadcastId) {
  if (!uid) throw new Error('uid requerido');
  if (!broadcastId) throw new Error('broadcastId requerido');
  try {
    var snap = await db().collection('broadcast_events').doc(uid).collection('events')
      .where('broadcastId', '==', broadcastId).get();
    var counts = {};
    EVENT_TYPES.forEach(function(t) { counts[t] = 0; });
    var phones = new Set();
    snap.forEach(function(doc) {
      var data = doc.data();
      counts[data.eventType] = (counts[data.eventType] || 0) + 1;
      phones.add(data.phone);
    });
    var delivered = counts.delivered || 0;
    var read = counts.read || 0;
    var replied = counts.replied || 0;
    return {
      broadcastId,
      counts,
      uniqueContacts: phones.size,
      deliveryRate: delivered > 0 ? Math.round((delivered / phones.size) * 100) : 0,
      readRate: delivered > 0 ? Math.round((read / delivered) * 100) : 0,
      replyRate: delivered > 0 ? Math.round((replied / delivered) * 100) : 0,
    };
  } catch (e) {
    console.error('[BROADCAST_ANALYTICS] Error leyendo stats: ' + e.message);
    var emptyCounts = {};
    EVENT_TYPES.forEach(function(t) { emptyCounts[t] = 0; });
    return { broadcastId, counts: emptyCounts, uniqueContacts: 0, deliveryRate: 0, readRate: 0, replyRate: 0 };
  }
}

async function getOwnerBroadcastSummary(uid, periodDays, nowMs) {
  if (!uid) throw new Error('uid requerido');
  var days = typeof periodDays === 'number' && periodDays > 0 ? periodDays : 30;
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  var fromDate = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    var snap = await db().collection('broadcast_events').doc(uid).collection('events')
      .where('recordedAt', '>=', fromDate).get();
    var totalEvents = 0;
    var broadcasts = new Set();
    var byType = {};
    EVENT_TYPES.forEach(function(t) { byType[t] = 0; });
    snap.forEach(function(doc) {
      var data = doc.data();
      totalEvents++;
      broadcasts.add(data.broadcastId);
      byType[data.eventType] = (byType[data.eventType] || 0) + 1;
    });
    return { totalEvents, broadcastCount: broadcasts.size, byType, periodDays: days };
  } catch (e) {
    console.error('[BROADCAST_ANALYTICS] Error leyendo summary: ' + e.message);
    var emptyByType = {};
    EVENT_TYPES.forEach(function(t) { emptyByType[t] = 0; });
    return { totalEvents: 0, broadcastCount: 0, byType: emptyByType, periodDays: days };
  }
}

module.exports = {
  recordBroadcastEvent,
  getBroadcastStats,
  getOwnerBroadcastSummary,
  EVENT_TYPES,
  __setFirestoreForTests,
};