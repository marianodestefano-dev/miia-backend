'use strict';

/**
 * MIIA - Inter-MIIA Network (T188)
 * Red entre instancias MIIA: referidos, colaboracion, mensajeria interna.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const NETWORK_EVENT_TYPES = Object.freeze([
  'referral_sent', 'referral_received', 'collaboration_request',
  'lead_transfer', 'message_relay', 'partnership',
]);

const NETWORK_STATES = Object.freeze(['pending', 'accepted', 'declined', 'completed']);
const MAX_REFERRALS_PER_DAY = 20;
const REFERRAL_REWARD_POINTS = 10;


/**
 * Registra un referido de un owner a otro.
 * @param {string} fromUid - owner que refiere
 * @param {string} toUid - owner que recibe el referido
 * @param {string} leadPhone - telefono del lead referido
 * @param {object} [opts] - {message, context}
 * @returns {Promise<{referralId, state, points}>}
 */
async function sendReferral(fromUid, toUid, leadPhone, opts) {
  if (!fromUid) throw new Error('fromUid requerido');
  if (!toUid) throw new Error('toUid requerido');
  if (!leadPhone) throw new Error('leadPhone requerido');
  if (fromUid === toUid) throw new Error('fromUid y toUid no pueden ser iguales');

  const options = opts || {};
  const referralId = fromUid.substring(0, 8) + '_' + toUid.substring(0, 8) + '_' + Date.now();

  const doc = {
    referralId, fromUid, toUid, leadPhone,
    state: 'pending',
    message: options.message || '',
    context: options.context || {},
    sentAt: new Date().toISOString(),
    acceptedAt: null,
    rewardPoints: REFERRAL_REWARD_POINTS,
  };

  try {
    await db()
      .collection('inter_miia_referrals')
      .doc(referralId)
      .set(doc);
    console.log('[NETWORK] referido enviado from=' + fromUid.substring(0, 8) + ' to=' + toUid.substring(0, 8));
    return { referralId, state: 'pending', points: REFERRAL_REWARD_POINTS };
  } catch (e) {
    console.error('[NETWORK] Error enviando referido: ' + e.message);
    throw e;
  }
}

/**
 * Actualiza el estado de un referido.
 * @param {string} referralId
 * @param {string} state
 */
async function updateReferralState(referralId, state) {
  if (!referralId) throw new Error('referralId requerido');
  if (!state || !NETWORK_STATES.includes(state)) throw new Error('state invalido: ' + state);

  const updates = { state, updatedAt: new Date().toISOString() };
  if (state === 'accepted') updates.acceptedAt = new Date().toISOString();

  try {
    await db().collection('inter_miia_referrals').doc(referralId).set(updates, { merge: true });
    console.log('[NETWORK] referido actualizado id=' + referralId + ' state=' + state);
  } catch (e) {
    console.error('[NETWORK] Error actualizando referido: ' + e.message);
    throw e;
  }
}

/**
 * Obtiene los referidos enviados por un owner.
 * @param {string} uid
 * @returns {Promise<object[]>}
 */
async function getSentReferrals(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db()
      .collection('inter_miia_referrals')
      .where('fromUid', '==', uid)
      .get();
    const referrals = [];
    snap.forEach(doc => referrals.push({ id: doc.id, ...doc.data() }));
    return referrals;
  } catch (e) {
    console.error('[NETWORK] Error leyendo referidos enviados: ' + e.message);
    return [];
  }
}

/**
 * Obtiene los referidos recibidos por un owner.
 * @param {string} uid
 * @returns {Promise<object[]>}
 */
async function getReceivedReferrals(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db()
      .collection('inter_miia_referrals')
      .where('toUid', '==', uid)
      .get();
    const referrals = [];
    snap.forEach(doc => referrals.push({ id: doc.id, ...doc.data() }));
    return referrals;
  } catch (e) {
    console.error('[NETWORK] Error leyendo referidos recibidos: ' + e.message);
    return [];
  }
}

/**
 * Calcula los puntos de red acumulados por un owner.
 * @param {string} uid
 * @returns {Promise<{totalPoints, sentCount, acceptedCount}>}
 */
async function getNetworkPoints(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const sent = await getSentReferrals(uid);
    const accepted = sent.filter(r => r.state === 'accepted' || r.state === 'completed');
    const totalPoints = accepted.length * REFERRAL_REWARD_POINTS;
    return { totalPoints, sentCount: sent.length, acceptedCount: accepted.length };
  } catch (e) {
    console.error('[NETWORK] Error calculando puntos: ' + e.message);
    return { totalPoints: 0, sentCount: 0, acceptedCount: 0 };
  }
}

/**
 * Registra un evento de red entre owners.
 * @param {string} fromUid
 * @param {string} toUid
 * @param {string} eventType
 * @param {object} [data]
 */
async function recordNetworkEvent(fromUid, toUid, eventType, data) {
  if (!fromUid) throw new Error('fromUid requerido');
  if (!toUid) throw new Error('toUid requerido');
  if (!eventType || !NETWORK_EVENT_TYPES.includes(eventType)) throw new Error('eventType invalido: ' + eventType);

  const doc = {
    fromUid, toUid, eventType,
    data: data || {},
    recordedAt: new Date().toISOString(),
  };

  try {
    const id = fromUid.substring(0, 8) + '_' + eventType + '_' + Date.now();
    await db().collection('network_events').doc(id).set(doc);
  } catch (e) {
    console.error('[NETWORK] Error registrando evento: ' + e.message);
    throw e;
  }
}

module.exports = {
  sendReferral, updateReferralState, getSentReferrals, getReceivedReferrals,
  getNetworkPoints, recordNetworkEvent,
  NETWORK_EVENT_TYPES, NETWORK_STATES, REFERRAL_REWARD_POINTS, MAX_REFERRALS_PER_DAY,
  __setFirestoreForTests,
};
