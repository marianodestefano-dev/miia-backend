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
function db() { return _db || /* istanbul ignore next */ admin.firestore(); }

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


// ── Contact Consent (R22-A C.10) ─────────────────────────────────────────────

const crypto = require('crypto');

const CONSENT_VERSION = 'v1';
const CONSENT_TTL_MS = 30 * 60 * 1000;

function _contactConsentRef(uid, phone) {
  return db().collection('owners').doc(uid).collection('consents').doc(phone);
}

function _consentAuditRef(uid, phone) {
  return db().collection('owners').doc(uid).collection('consent_audit').doc(phone);
}

async function requestConsent(uid, phone, dataType) {
  if (!uid || !phone || !dataType) throw new Error('parametros_requeridos');
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + CONSENT_TTL_MS).toISOString();
  await _contactConsentRef(uid, phone).set({
    pending: { token, dataType, expiresAt, requestedAt: new Date().toISOString() },
  }, { merge: true });
  return { token, expiresAt };
}

async function recordConsent(uid, phone, token, accepted) {
  if (!uid || !phone || !token) throw new Error('parametros_requeridos');
  const snap = await _contactConsentRef(uid, phone).get();
  const data = snap.exists ? snap.data() : {};
  const pending = data.pending || {};
  if (!pending.token || pending.token !== token) throw new Error('token_invalido');
  if (Date.now() > new Date(pending.expiresAt).getTime()) throw new Error('token_expirado');
  const ts = new Date().toISOString();
  const record = { accepted: !!accepted, dataType: pending.dataType, ts, version: CONSENT_VERSION };
  await _contactConsentRef(uid, phone).set(
    { accepted: !!accepted, dataType: pending.dataType, ts, version: CONSENT_VERSION, pending: null },
    { merge: true }
  );
  await _consentAuditRef(uid, phone).set({ [ts]: record }, { merge: true });
  console.log('[CONSENT_MGR] ' + (accepted ? 'ACEPTADO' : 'RECHAZADO') + ' uid=' + uid.slice(0, 8) + ' phone=' + phone.slice(-4));
  return { ok: true };
}

async function hasConsent(uid, phone, dataType) {
  if (!uid || !phone) return false;
  const snap = await _contactConsentRef(uid, phone).get();
  if (!snap.exists) return false;
  const data = snap.data();
  if (!data.accepted) return false;
  if (dataType && data.dataType !== dataType) return false;
  return true;
}

async function revokeConsent(uid, phone) {
  if (!uid || !phone) throw new Error('parametros_requeridos');
  await _contactConsentRef(uid, phone).set({ accepted: false, revokedAt: new Date().toISOString() }, { merge: true });
  console.log('[CONSENT_MGR] revocado uid=' + uid.slice(0, 8) + ' phone=' + phone.slice(-4));
  return { ok: true };
}

module.exports = {
  getOwnerConsent,
  setOwnerConsent,
  hasOwnerConsented,
  requestConsent,
  recordConsent,
  hasConsent,
  revokeConsent,
  VALID_MODES,
  CONSENT_VERSION,
  CONSENT_TTL_MS,
  __setFirestoreForTests,
};
