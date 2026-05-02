'use strict';

/**
 * broadcast_analytics.js -- T170 (broadcast tasa apertura/respuesta).
 * recordSent(uid, broadcastId, phone) -> Promise<void>
 * recordEvent(uid, broadcastId, phone, event) -> Promise<void>  event in ['opened','replied']
 * getCampaignMetrics(uid, broadcastId) -> Promise<{sent, opened, replied, openRate, replyRate}>
 * getAllCampaignsSummary(uid, broadcastIds[]) -> Promise<array>
 */

const VALID_EVENTS = Object.freeze(['opened', 'replied']);

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

async function recordSent(uid, broadcastId, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!broadcastId) throw new Error('broadcastId requerido');
  if (!phone) throw new Error('phone requerido');
  await db().collection('owners').doc(uid).collection('broadcasts').doc(broadcastId).set({
    phone, opened: false, replied: false, sentAt: new Date().toISOString(),
  });
}

async function recordEvent(uid, broadcastId, phone, event) {
  if (!uid) throw new Error('uid requerido');
  if (!broadcastId) throw new Error('broadcastId requerido');
  if (!phone) throw new Error('phone requerido');
  if (!VALID_EVENTS.includes(event)) throw new Error('event invalido: ' + event);
  const update = { [event]: true, [event + 'At']: new Date().toISOString() };
  await db().collection('owners').doc(uid).collection('broadcasts').doc(broadcastId).set(update);
}

async function getCampaignMetrics(uid, broadcastId) {
  if (!uid) throw new Error('uid requerido');
  if (!broadcastId) throw new Error('broadcastId requerido');
  const empty = { sent: 0, opened: 0, replied: 0, openRate: 0, replyRate: 0, broadcastId };
  try {
    const snap = await db().collection('owners').doc(uid).collection('broadcasts').get();
    let sent = 0, opened = 0, replied = 0;
    snap.forEach(d => {
      const data = d.data ? d.data() : {};
      sent++;
      if (data.opened) opened++;
      if (data.replied) replied++;
    });
    return {
      sent,
      opened,
      replied,
      openRate: sent > 0 ? opened / sent : 0,
      replyRate: sent > 0 ? replied / sent : 0,
      broadcastId,
    };
  } catch (e) {
    return empty; // fail-open
  }
}

async function getAllCampaignsSummary(uid, broadcastIds) {
  if (!uid) throw new Error('uid requerido');
  if (!Array.isArray(broadcastIds)) throw new Error('broadcastIds debe ser array');
  const out = [];
  for (const id of broadcastIds) {
    const m = await getCampaignMetrics(uid, id);
    out.push(m);
  }
  return out;
}

module.exports = {
  recordSent,
  recordEvent,
  getCampaignMetrics,
  getAllCampaignsSummary,
  VALID_EVENTS,
  __setFirestoreForTests,
};
