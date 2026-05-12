'use strict';

/**
 * R21-A -- core/action_guard.js (Planta Baja PB.4)
 * Aprobacion in-line en self-chat para acciones sensibles.
 * Schema Firestore: owners/{uid}/pending_confirmations/{token}
 *   { actionId, description, expiresAt, status, response }
 */

const crypto = require('crypto');

const DEFAULT_EXPIRES_MS = 5 * 60 * 1000;
const STATUS = Object.freeze({ PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' });

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _confirmRef(uid, token) {
  return db().collection('owners').doc(uid).collection('pending_confirmations').doc(token);
}

/**
 * Solicita confirmacion del owner via self-chat.
 * @param {string} uid
 * @param {string} actionId
 * @param {string} description
 * @param {number} [expiresIn]
 * @returns {string} token
 */
async function requestConfirmation(uid, actionId, description, expiresIn) {
  if (!uid || !actionId || !description) throw new Error('parametros_requeridos');
  const token = crypto.randomBytes(16).toString('hex');
  const ttl = (typeof expiresIn === 'number' && expiresIn > 0) ? expiresIn : DEFAULT_EXPIRES_MS;
  const expiresAt = new Date(Date.now() + ttl).toISOString();
  await _confirmRef(uid, token).set({
    actionId, description, expiresAt,
    status: STATUS.PENDING,
    createdAt: new Date().toISOString(),
  });
  console.log('[ACTION_GUARD] confirmacion solicitada uid=' + uid.slice(0, 8) + ' action=' + actionId);
  return token;
}

/**
 * Verifica la respuesta del owner a una confirmacion pendiente.
 * @param {string} uid
 * @param {string} token
 * @param {string} response -- 'SI', 'YES', 'NO' etc
 * @returns {{ approved: bool, expired: bool }}
 */
async function checkConfirmation(uid, token, response) {
  if (!uid || !token) throw new Error('uid_token_requeridos');
  const snap = await _confirmRef(uid, token).get();
  if (!snap.exists) return { approved: false, expired: false, notFound: true };
  const data = snap.data();
  if (Date.now() > new Date(data.expiresAt).getTime()) {
    await _confirmRef(uid, token).set({ status: 'expired' }, { merge: true });
    return { approved: false, expired: true };
  }
  const resp = (response || '').trim().toUpperCase();
  const approved = resp === 'SI' || resp === 'YES';
  await _confirmRef(uid, token).set({ status: approved ? STATUS.APPROVED : STATUS.REJECTED, response: resp }, { merge: true });
  return { approved, expired: false };
}

module.exports = {
  requestConfirmation,
  checkConfirmation,
  DEFAULT_EXPIRES_MS,
  STATUS,
  __setFirestoreForTests,
};
