'use strict';

/**
 * R27 — core/referido_natural.js (Piso 5 P5.2)
 * Sistema de referidos naturales + tickets de soporte + modo asistente.
 * Schema Firestore:
 *   - owners/{uid}/referidos/{phone} -> origen del lead (quien lo refirio)
 *   - owners/{uid}/tickets/{id} -> tickets de soporte
 *   - owners/{uid}/asistente_mode -> on/off del modo asistente
 */

const TICKET_STATES = Object.freeze(['open', 'in_progress', 'pending', 'resolved', 'closed']);
const TICKET_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);
const TICKET_TTL_DAYS = 30;

const ASISTENTE_MODES = Object.freeze({ OFF: 'off', PROACTIVE: 'proactive', SILENT: 'silent' });

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

// ── Firestore refs ────────────────────────────────────────────────────────────
function _referidosCol(uid) {
  return db().collection('owners').doc(uid).collection('referidos');
}
function _ticketsCol(uid) {
  return db().collection('owners').doc(uid).collection('tickets');
}
function _asistenteDoc(uid) {
  return db().collection('owners').doc(uid).collection('asistente').doc('config');
}

// ── Referido natural ──────────────────────────────────────────────────────────
/**
 * Registra que un lead llego via referido de otro contacto.
 * @param {string} uid
 * @param {string} leadPhone
 * @param {string} referrerPhone
 * @param {{ referrerName }} opts
 */
async function registerNaturalReferral(uid, leadPhone, referrerPhone, opts) {
  if (!uid) throw new Error('uid_requerido');
  if (!leadPhone) throw new Error('leadPhone_requerido');
  if (!referrerPhone) throw new Error('referrerPhone_requerido');
  if (leadPhone === referrerPhone) throw new Error('mismo_phone_invalido');
  const o = opts || {};
  await _referidosCol(uid).doc(leadPhone).set({
    leadPhone,
    referrerPhone,
    referrerName: o.referrerName || null,
    rewardClaimed: false,
    createdAt: new Date().toISOString(),
  }, { merge: true });
  console.log('[REF-NAT] uid=' + uid.slice(0, 8) + ' lead=' + leadPhone.slice(-4) + ' from=' + referrerPhone.slice(-4));
  return { ok: true };
}

/**
 * Obtiene el referrer original de un lead (si existe).
 * @returns {{ referrerPhone, referrerName }|null}
 */
async function getReferrer(uid, leadPhone) {
  if (!uid || !leadPhone) return null;
  const snap = await _referidosCol(uid).doc(leadPhone).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return {
    referrerPhone: data.referrerPhone,
    referrerName: data.referrerName || null,
    rewardClaimed: !!data.rewardClaimed,
  };
}

/**
 * Marca el referido como premiado (para evitar doble premio).
 */
async function claimReferralReward(uid, leadPhone) {
  if (!uid || !leadPhone) throw new Error('parametros_requeridos');
  const ref = _referidosCol(uid).doc(leadPhone);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('referido_no_encontrado');
  const data = snap.data();
  if (data.rewardClaimed) throw new Error('reward_ya_reclamado');
  await ref.set({ rewardClaimed: true, claimedAt: new Date().toISOString() }, { merge: true });
  return { ok: true, referrerPhone: data.referrerPhone };
}

// ── Tickets ───────────────────────────────────────────────────────────────────
/**
 * Crea un ticket de soporte para el owner.
 * @param {string} uid
 * @param {{ title, description, priority, fromPhone }} payload
 */
async function createTicket(uid, payload) {
  if (!uid) throw new Error('uid_requerido');
  if (!payload || !payload.title) throw new Error('titulo_requerido');
  const priority = payload.priority && TICKET_PRIORITIES.includes(payload.priority) ? payload.priority : 'normal';
  const ticketId = 'tkt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const record = {
    ticketId,
    title: String(payload.title).slice(0, 200),
    description: payload.description ? String(payload.description).slice(0, 5000) : '',
    priority,
    state: 'open',
    fromPhone: payload.fromPhone || null,
    createdAt: new Date().toISOString(),
  };
  await _ticketsCol(uid).doc(ticketId).set(record);
  console.log('[TICKET] uid=' + uid.slice(0, 8) + ' id=' + ticketId + ' priority=' + priority);
  return { ok: true, ticketId, ...record };
}

/**
 * Actualiza el estado de un ticket.
 */
async function updateTicketState(uid, ticketId, state) {
  if (!uid || !ticketId) throw new Error('parametros_requeridos');
  if (!TICKET_STATES.includes(state)) throw new Error('state_invalido: ' + state);
  await _ticketsCol(uid).doc(ticketId).set({
    state,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  return { ok: true, state };
}

/**
 * Obtiene los tickets activos del owner (no closed/resolved).
 */
async function getActiveTickets(uid) {
  if (!uid) throw new Error('uid_requerido');
  const snap = await _ticketsCol(uid).get();
  const tickets = [];
  snap.forEach(function (doc) {
    const data = doc.data();
    if (data.state !== 'closed' && data.state !== 'resolved') {
      tickets.push(data);
    }
  });
  tickets.sort(function (a, b) {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  return tickets;
}

// ── Modo asistente ────────────────────────────────────────────────────────────
/**
 * Cambia el modo asistente del owner (off/proactive/silent).
 */
async function setAsistenteMode(uid, mode) {
  if (!uid) throw new Error('uid_requerido');
  if (!Object.values(ASISTENTE_MODES).includes(mode)) {
    throw new Error('mode_invalido: ' + mode);
  }
  await _asistenteDoc(uid).set({
    mode,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  console.log('[ASISTENTE] uid=' + uid.slice(0, 8) + ' mode=' + mode);
  return { ok: true, mode };
}

/**
 * Lee el modo asistente del owner (default off).
 */
async function getAsistenteMode(uid) {
  if (!uid) throw new Error('uid_requerido');
  const snap = await _asistenteDoc(uid).get();
  if (!snap.exists) return ASISTENTE_MODES.OFF;
  const data = snap.data();
  return data.mode || ASISTENTE_MODES.OFF;
}

/**
 * Determina si MIIA debe actuar proactivamente (true solo si mode=proactive).
 */
async function shouldAssistProactively(uid) {
  const mode = await getAsistenteMode(uid);
  return mode === ASISTENTE_MODES.PROACTIVE;
}

module.exports = {
  registerNaturalReferral,
  getReferrer,
  claimReferralReward,
  createTicket,
  updateTicketState,
  getActiveTickets,
  setAsistenteMode,
  getAsistenteMode,
  shouldAssistProactively,
  TICKET_STATES,
  TICKET_PRIORITIES,
  TICKET_TTL_DAYS,
  ASISTENTE_MODES,
  __setFirestoreForTests,
};
