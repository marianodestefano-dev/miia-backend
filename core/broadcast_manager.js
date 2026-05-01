'use strict';

/**
 * MIIA — Broadcast Manager (T96)
 * scheduleBroadcast, processBroadcast, getBroadcastStatus.
 * Rate limit: max 5/min. No enviar a ignored/blocked.
 */

const admin = require('firebase-admin');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || admin.firestore(); }

const CONTACT_FILTERS = Object.freeze(['all_leads','all_clients','all_contacts']);
const MAX_PER_MINUTE = 5;
const BLOCKED_STATUSES = new Set(['ignored','blocked']);

/**
 * Schedula un broadcast. Guarda en Firestore broadcasts/{uid}/items/{broadcastId}.
 */
async function scheduleBroadcast(uid, { message, contactFilter, scheduledAt } = {}) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!message || typeof message !== 'string') throw new Error('message requerido');
  if (!contactFilter) throw new Error('contactFilter requerido');
  const validFilter = Array.isArray(contactFilter)
    ? contactFilter.every(p => typeof p === 'string')
    : CONTACT_FILTERS.includes(contactFilter);
  if (!validFilter) throw new Error(`contactFilter inválido: ${contactFilter}`);

  const broadcastId = `bc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    broadcastId,
    uid,
    message: message.slice(0, 4000),
    contactFilter,
    scheduledAt: scheduledAt || new Date().toISOString(),
    createdAt: new Date().toISOString(),
    status: 'pending',
    sentCount: 0,
    failedCount: 0,
    pendingCount: 0,
  };

  await db().collection('broadcasts').doc(uid).collection('items').doc(broadcastId).set(payload);
  console.log(`[BROADCAST] Scheduled uid=${uid.substring(0,8)} id=${broadcastId} filter=${JSON.stringify(contactFilter)}`);
  return payload;
}

/**
 * Procesa un broadcast enviando mensajes con rate limit 5/min.
 * @param {string} uid
 * @param {string} broadcastId
 * @param {Function} sendFn - (phone, message) => Promise<void>
 * @param {Object} [contacts] - mapa de phone -> { status }
 * @returns {Promise<{sentCount, failedCount, skippedCount}>}
 */
async function processBroadcast(uid, broadcastId, sendFn, contacts = {}) {
  if (!uid || !broadcastId) throw new Error('uid requerido');
  if (typeof sendFn !== 'function') throw new Error('sendFn requerido');

  const bcRef = db().collection('broadcasts').doc(uid).collection('items').doc(broadcastId);
  const snap = await bcRef.get();
  if (!snap.exists) throw new Error(`Broadcast ${broadcastId} no encontrado`);
  const bc = snap.data();

  const phones = getPhones(bc.contactFilter, contacts);
  let sentCount = 0, failedCount = 0, skippedCount = 0;
  let batch = 0;
  const MINUTE_MS = 60 * 1000;
  let batchStart = Date.now();

  for (const phone of phones) {
    const info = contacts[phone] || {};
    if (BLOCKED_STATUSES.has(info.status)) { skippedCount++; continue; }

    // Rate limit: max 5/min
    if (batch >= MAX_PER_MINUTE) {
      const elapsed = Date.now() - batchStart;
      if (elapsed < MINUTE_MS) await new Promise(r => setTimeout(r, MINUTE_MS - elapsed));
      batch = 0;
      batchStart = Date.now();
    }

    try {
      await sendFn(phone, bc.message);
      sentCount++;
    } catch (e) {
      console.warn(`[BROADCAST] Error enviando a ${phone}: ${e.message}`);
      failedCount++;
    }
    batch++;
  }

  try {
    await bcRef.set({
      status: 'completed', sentCount, failedCount, pendingCount: 0,
      completedAt: new Date().toISOString()
    }, { merge: true });
  } catch (e) {
    console.warn(`[BROADCAST] Error actualizando estado en Firestore: ${e.message}`);
  }

  console.log(`[BROADCAST] Completed ${broadcastId}: sent=${sentCount} failed=${failedCount} skipped=${skippedCount}`);
  return { sentCount, failedCount, skippedCount };
}

function getPhones(contactFilter, contacts) {
  if (Array.isArray(contactFilter)) return contactFilter;
  const entries = Object.entries(contacts);
  if (contactFilter === 'all_contacts') return entries.map(([p]) => p);
  if (contactFilter === 'all_leads') return entries.filter(([, v]) => v.status === 'lead').map(([p]) => p);
  if (contactFilter === 'all_clients') return entries.filter(([, v]) => v.status === 'client').map(([p]) => p);
  return [];
}

/**
 * Retorna el estado de un broadcast.
 * @returns {Promise<{broadcastId, status, sentCount, failedCount, pendingCount}>}
 */
async function getBroadcastStatus(uid, broadcastId) {
  if (!uid) throw new Error('uid requerido');
  if (!broadcastId) throw new Error('broadcastId requerido');
  try {
    const snap = await db().collection('broadcasts').doc(uid).collection('items').doc(broadcastId).get();
    if (!snap.exists) return { broadcastId, status: 'not_found' };
    const { status, sentCount, failedCount, pendingCount, scheduledAt, createdAt } = snap.data();
    return { broadcastId, status, sentCount, failedCount, pendingCount, scheduledAt, createdAt };
  } catch (e) {
    console.warn(`[BROADCAST] Error leyendo estado ${broadcastId}: ${e.message}`);
    return { broadcastId, status: 'error', error: e.message };
  }
}

module.exports = {
  scheduleBroadcast,
  processBroadcast,
  getBroadcastStatus,
  CONTACT_FILTERS,
  __setFirestoreForTests,
};
