'use strict';

/**
 * MIIA - Broadcast V2 (T168/T169)
 * Difusion masiva con segmentacion por tags y programacion de horario optimo.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const MAX_AUDIENCE_SIZE = 10000;
const MIN_SEND_INTERVAL_MS = 500;
const OPTIMAL_HOURS = Object.freeze({ start: 9, end: 20 });
const BROADCAST_STATES = Object.freeze(['draft', 'scheduled', 'sending', 'sent', 'cancelled']);

/**
 * Crea un broadcast con segmentacion por tags.
 * @param {string} uid
 * @param {object} campaign - { name, message, tags, scheduledAt? }
 * @returns {Promise<{id, name, tags, scheduledAt, state}>}
 */
async function createBroadcast(uid, campaign) {
  if (!uid) throw new Error('uid requerido');
  if (!campaign || typeof campaign !== 'object') throw new Error('campaign requerido');
  if (!campaign.name || typeof campaign.name !== 'string') throw new Error('name requerido');
  if (!campaign.message || typeof campaign.message !== 'string') throw new Error('message requerido');
  if (!Array.isArray(campaign.tags)) throw new Error('tags debe ser array');

  const id = uid.substring(0, 8) + '_bc_' + Date.now();
  const payload = {
    id, uid,
    name: campaign.name,
    message: campaign.message,
    tags: campaign.tags,
    scheduledAt: campaign.scheduledAt || null,
    state: campaign.scheduledAt ? 'scheduled' : 'draft',
    createdAt: new Date().toISOString(),
    sentCount: 0, failCount: 0,
  };

  try {
    await db().collection('broadcasts').doc(uid).collection('campaigns').doc(id).set(payload);
    console.log('[BROADCAST_V2] creado uid=' + uid.substring(0, 8) + ' name=' + campaign.name + ' tags=' + campaign.tags.join(','));
    return payload;
  } catch (e) {
    console.error('[BROADCAST_V2] Error creando broadcast: ' + e.message);
    throw e;
  }
}

/**
 * Segmenta la audiencia de contactos por tags.
 * @param {Array<object>} contacts - todos los contactos del owner
 * @param {Array<string>} tags - tags requeridos (AND logic)
 * @param {object} [opts] - { maxSize, excludeTags }
 * @returns {Array<object>} contactos que matchean
 */
function segmentAudience(contacts, tags) {
  if (!Array.isArray(contacts)) throw new Error('contacts debe ser array');
  if (!Array.isArray(tags)) throw new Error('tags debe ser array');

  if (tags.length === 0) return contacts.slice(0, MAX_AUDIENCE_SIZE);

  const result = contacts.filter(c => {
    const contactTags = c.tags || [];
    return tags.every(t => contactTags.includes(t));
  });

  return result.slice(0, MAX_AUDIENCE_SIZE);
}

/**
 * Calcula el horario optimo de envio dado un timestamp base.
 * Ajusta al proximo horario de alta actividad (09:00-20:00, en adelante).
 * @param {number} nowMs
 * @param {string} [timezone]
 * @returns {{ scheduledAt, isOptimal }}
 */
function calculateOptimalSendTime(nowMs, timezone) {
  const now = new Date(nowMs);
  const tz = timezone || 'UTC';
  const localStr = now.toLocaleString('en-US', { timeZone: tz });
  const local = new Date(localStr);
  const hour = local.getHours();
  const minute = local.getMinutes();

  if (hour >= OPTIMAL_HOURS.start && hour < OPTIMAL_HOURS.end) {
    return { scheduledAt: new Date(nowMs).toISOString(), isOptimal: true };
  }

  const nextOptimal = new Date(local);
  if (hour >= OPTIMAL_HOURS.end) {
    nextOptimal.setDate(nextOptimal.getDate() + 1);
  }
  nextOptimal.setHours(OPTIMAL_HOURS.start, 0, 0, 0);

  const diff = nextOptimal - local;
  const adjusted = new Date(nowMs + diff);

  return { scheduledAt: adjusted.toISOString(), isOptimal: false };
}

/**
 * Actualiza el estado de un broadcast.
 */
async function updateBroadcastState(uid, broadcastId, state, stats) {
  if (!uid) throw new Error('uid requerido');
  if (!broadcastId) throw new Error('broadcastId requerido');
  if (!BROADCAST_STATES.includes(state)) throw new Error('state invalido: ' + state);

  const update = { state, updatedAt: new Date().toISOString() };
  if (stats) {
    if (typeof stats.sentCount === 'number') update.sentCount = stats.sentCount;
    if (typeof stats.failCount === 'number') update.failCount = stats.failCount;
  }

  try {
    await db().collection('broadcasts').doc(uid).collection('campaigns').doc(broadcastId)
      .set(update, { merge: true });
    console.log('[BROADCAST_V2] estado actualizado id=' + broadcastId + ' state=' + state);
  } catch (e) {
    console.error('[BROADCAST_V2] Error actualizando estado: ' + e.message);
    throw e;
  }
}

/**
 * Obtiene broadcasts programados que deben ejecutarse ahora.
 * @param {string} uid
 * @param {number} [nowMs]
 */
async function getScheduledBroadcasts(uid, nowMs) {
  if (!uid) throw new Error('uid requerido');
  const now = nowMs ? new Date(nowMs).toISOString() : new Date().toISOString();
  try {
    const snap = await db().collection('broadcasts').doc(uid).collection('campaigns')
      .where('state', '==', 'scheduled').get();
    const due = [];
    snap.forEach(doc => {
      const data = doc.data();
      if (data.scheduledAt && data.scheduledAt <= now) {
        due.push({ id: doc.id, ...data });
      }
    });
    return due;
  } catch (e) {
    console.error('[BROADCAST_V2] Error leyendo scheduled: ' + e.message);
    return [];
  }
}

module.exports = {
  createBroadcast, segmentAudience, calculateOptimalSendTime,
  updateBroadcastState, getScheduledBroadcasts,
  MAX_AUDIENCE_SIZE, OPTIMAL_HOURS, BROADCAST_STATES,
  __setFirestoreForTests,
};
