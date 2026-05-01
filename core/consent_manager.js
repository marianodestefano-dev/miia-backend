'use strict';

/**
 * MIIA — Consent Manager (T92 wire-in C-431)
 *
 * Lee y escribe onboarding_consent/v1 del owner en Firestore.
 * Expone hasOwnerConsented(uid) para uso en TMH antes de responder leads.
 */

const admin = require('firebase-admin');

const VALID_MODES = ['A', 'B', 'C'];

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return admin.firestore();
}

function consentRef(uid) {
  return db().collection('users').doc(uid).collection('onboarding_consent').doc('v1');
}

/**
 * Lee el estado de consent del owner.
 * @returns {Promise<{mode, updatedAt, ...}|null>} null si no existe
 */
async function getOwnerConsent(uid) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  const snap = await consentRef(uid).get();
  if (!snap.exists) return null;
  return snap.data();
}

/**
 * Guarda el modo de consent del owner.
 * @param {string} uid
 * @param {{ mode: string, acknowledgment?: string }} data
 */
async function setOwnerConsent(uid, data) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!data || !VALID_MODES.includes(data.mode)) {
    throw new Error(`mode invalido: debe ser uno de ${VALID_MODES.join(', ')}`);
  }
  const payload = {
    mode: data.mode,
    acknowledgment: typeof data.acknowledgment === 'string' ? data.acknowledgment.trim().slice(0, 1000) : null,
    updatedAt: new Date().toISOString(),
    updatedBy: uid,
  };
  await consentRef(uid).set(payload, { merge: true });
  console.log(`[CONSENT-MGR] setOwnerConsent uid=${uid.substring(0,8)} mode=${data.mode}`);
  return { success: true, ...payload };
}

/**
 * Verifica si el owner ya configuró su consent (modo A/B/C definido).
 * Falla cerrada: si Firestore falla, retorna true para no bloquear MIIA.
 * @returns {Promise<boolean>}
 */
async function hasOwnerConsented(uid) {
  if (!uid || typeof uid !== 'string') return false;
  try {
    const snap = await consentRef(uid).get();
    if (!snap.exists) return false;
    const data = snap.data();
    return VALID_MODES.includes(data && data.mode);
  } catch (e) {
    console.warn(`[CONSENT-MGR] hasOwnerConsented error uid=${uid.substring(0,8)}: ${e.message} — fallback true`);
    return true;
  }
}

module.exports = {
  getOwnerConsent,
  setOwnerConsent,
  hasOwnerConsented,
  VALID_MODES,
  __setFirestoreForTests,
};
