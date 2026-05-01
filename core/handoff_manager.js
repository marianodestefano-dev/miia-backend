'use strict';

/**
 * MIIA - Handoff Manager (T187)
 * Traspaso de conversacion de MIIA al owner humano y vice versa.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const HANDOFF_MODES = Object.freeze(['auto', 'manual', 'escalation']);
const HANDOFF_REASONS = Object.freeze([
  'high_value_lead', 'complaint', 'complex_query', 'owner_request',
  'lead_request', 'appointment_confirmed', 'payment_issue',
]);
const HANDOFF_STATES = Object.freeze(['pending', 'active', 'resolved', 'timeout']);
const DEFAULT_HANDOFF_TIMEOUT_MINS = 30;
const MAX_ACTIVE_HANDOFFS = 10;


/**
 * Inicia un traspaso de MIIA al owner.
 * @param {string} uid
 * @param {string} phone - teléfono del lead
 * @param {object} opts - {reason, mode, context, timeoutMins}
 * @returns {Promise<{handoffId, state, reason, createdAt, expiresAt}>}
 */
async function initiateHandoff(uid, phone, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');

  const options = opts || {};
  const reason = options.reason && HANDOFF_REASONS.includes(options.reason) ? options.reason : 'complex_query';
  const mode = options.mode && HANDOFF_MODES.includes(options.mode) ? options.mode : 'manual';
  const timeoutMins = typeof options.timeoutMins === 'number' && options.timeoutMins > 0
    ? options.timeoutMins
    : DEFAULT_HANDOFF_TIMEOUT_MINS;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + timeoutMins * 60 * 1000).toISOString();
  const handoffId = uid.substring(0, 8) + '_' + phone.slice(-8) + '_' + Date.now();

  const doc = {
    uid, phone, handoffId, reason, mode,
    state: 'pending',
    context: options.context || {},
    createdAt: now.toISOString(),
    expiresAt,
    resolvedAt: null,
    timeoutMins,
  };

  try {
    await db()
      .collection('handoffs').doc(uid)
      .collection('active').doc(handoffId)
      .set(doc);
    console.log('[HANDOFF] iniciado uid=' + uid.substring(0, 8) + ' phone=' + phone.slice(-6) + ' reason=' + reason);
    return { handoffId, state: 'pending', reason, createdAt: doc.createdAt, expiresAt };
  } catch (e) {
    console.error('[HANDOFF] Error iniciando traspaso: ' + e.message);
    throw e;
  }
}

/**
 * Actualiza el estado de un handoff.
 * @param {string} uid
 * @param {string} handoffId
 * @param {string} state
 */
async function updateHandoffState(uid, handoffId, state) {
  if (!uid) throw new Error('uid requerido');
  if (!handoffId) throw new Error('handoffId requerido');
  if (!state || !HANDOFF_STATES.includes(state)) throw new Error('state invalido: ' + state);

  const updates = { state, updatedAt: new Date().toISOString() };
  if (state === 'resolved' || state === 'timeout') {
    updates.resolvedAt = new Date().toISOString();
  }

  try {
    await db()
      .collection('handoffs').doc(uid)
      .collection('active').doc(handoffId)
      .set(updates, { merge: true });
    console.log('[HANDOFF] estado actualizado uid=' + uid.substring(0, 8) + ' id=' + handoffId + ' state=' + state);
  } catch (e) {
    console.error('[HANDOFF] Error actualizando estado: ' + e.message);
    throw e;
  }
}

/**
 * Verifica si hay un handoff activo para un lead.
 * @param {string} uid
 * @param {string} phone
 * @returns {Promise<boolean>}
 */
async function isHandoffActive(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');

  try {
    const snap = await db()
      .collection('handoffs').doc(uid)
      .collection('active')
      .where('phone', '==', phone)
      .where('state', '==', 'active')
      .get();

    let hasActive = false;
    snap.forEach(doc => {
      const d = doc.data();
      if (d.expiresAt && new Date(d.expiresAt).getTime() > Date.now()) {
        hasActive = true;
      }
    });
    return hasActive;
  } catch (e) {
    console.error('[HANDOFF] Error verificando handoff activo: ' + e.message);
    return false;
  }
}

/**
 * Obtiene los handoffs pendientes del owner.
 * @param {string} uid
 * @returns {Promise<object[]>}
 */
async function getPendingHandoffs(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db()
      .collection('handoffs').doc(uid)
      .collection('active')
      .where('state', '==', 'pending')
      .get();

    const handoffs = [];
    snap.forEach(doc => handoffs.push({ id: doc.id, ...doc.data() }));
    return handoffs;
  } catch (e) {
    console.error('[HANDOFF] Error leyendo pendientes: ' + e.message);
    return [];
  }
}

/**
 * Verifica si MIIA debe responder o ceder al owner.
 * @param {string} uid
 * @param {string} phone
 * @returns {Promise<boolean>} true = MIIA puede responder
 */
async function shouldMiiaRespond(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  const active = await isHandoffActive(uid, phone);
  return !active;
}

module.exports = {
  initiateHandoff, updateHandoffState, isHandoffActive,
  getPendingHandoffs, shouldMiiaRespond,
  HANDOFF_MODES, HANDOFF_REASONS, HANDOFF_STATES,
  DEFAULT_HANDOFF_TIMEOUT_MINS, MAX_ACTIVE_HANDOFFS,
  __setFirestoreForTests,
};
