'use strict';

/**
 * MIIA - Broadcast Analytics (T170)
 * Tasa de apertura y respuesta por campana de difusion.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

/**
 * Registra el envio de un mensaje de broadcast a un contacto.
 */
async function recordSent(uid, broadcastId, phone, nowMs) {
  if (!uid) throw new Error('uid requerido');
  if (!broadcastId) throw new Error('broadcastId requerido');
  if (!phone) throw new Error('phone requerido');
  const ts = new Date(nowMs || Date.now()).toISOString();
  try {
    await db().collection('broadcast_analytics').doc(uid).collection(broadcastId)
      .doc(phone).set({ phone, sentAt: ts, opened: false, replied: false, openedAt: null, repliedAt: null }, { merge: true });
  } catch (e) {
    console.error('[BC_ANALYTICS] Error recordSent: ' + e.message);
    throw e;
  }
}

/**
 * Registra que un contacto abrio / respondio al broadcast.
 */
async function recordEvent(uid, broadcastId, phone, event, nowMs) {
  if (!uid) throw new Error('uid requerido');
  if (!broadcastId) throw new Error('broadcastId requerido');
  if (!phone) throw new Error('phone requerido');
  if (!['opened', 'replied'].includes(event)) throw new Error('event invalido: ' + event);
  const ts = new Date(nowMs || Date.now()).toISOString();
  const update = { [event]: true, [event + 'At']: ts };
  try {
    await db().collection('broadcast_analytics').doc(uid).collection(broadcastId)
      .doc(phone).set(update, { merge: true });
    console.log('[BC_ANALYTICS] event=' + event + ' bc=' + broadcastId + ' phone=***' + phone.slice(-4));
  } catch (e) {
    console.error('[BC_ANALYTICS] Error recordEvent: ' + e.message);
    throw e;
  }
}

/**
 * Calcula metricas de una campana.
 * @param {string} uid
 * @param {string} broadcastId
 * @returns {Promise<{sent, opened, replied, openRate, replyRate}>}
 */
async function getCampaignMetrics(uid, broadcastId) {
  if (!uid) throw new Error('uid requerido');
  if (!broadcastId) throw new Error('broadcastId requerido');
  try {
    const snap = await db().collection('broadcast_analytics').doc(uid).collection(broadcastId).get();
    let sent = 0, opened = 0, replied = 0;
    snap.forEach(doc => {
      const d = doc.data();
      sent++;
      if (d.opened) opened++;
      if (d.replied) replied++;
    });
    const openRate = sent > 0 ? Math.round((opened / sent) * 100) / 100 : 0;
    const replyRate = sent > 0 ? Math.round((replied / sent) * 100) / 100 : 0;
    return { sent, opened, replied, openRate, replyRate };
  } catch (e) {
    console.error('[BC_ANALYTICS] Error getCampaignMetrics: ' + e.message);
    return { sent: 0, opened: 0, replied: 0, openRate: 0, replyRate: 0 };
  }
}

/**
 * Retorna resumen de todas las campanas de un owner.
 */
async function getAllCampaignsSummary(uid, broadcastIds) {
  if (!uid) throw new Error('uid requerido');
  if (!Array.isArray(broadcastIds)) throw new Error('broadcastIds debe ser array');
  const results = [];
  for (const bcId of broadcastIds) {
    const metrics = await getCampaignMetrics(uid, bcId);
    results.push({ broadcastId: bcId, ...metrics });
  }
  return results;
}

module.exports = {
  recordSent, recordEvent, getCampaignMetrics, getAllCampaignsSummary,
  __setFirestoreForTests,
};
