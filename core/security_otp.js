'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_LENGTH = 6;

const CRITICAL_ACTIONS = new Set([
  'bulk_kb_change',
  'delete_kb',
  'change_personality',
  'add_agent',
  'change_email',
  'connect_integration',
  'anomaly_detected',
]);

const _store = new Map();

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || /* istanbul ignore next */ admin.firestore(); }

function generateCode() {
  return crypto.randomInt(100000, 999999).toString();
}

function generateOTP(uid, action) {
  if (!uid) throw new Error('uid requerido');
  const safeAction = action || 'unknown';
  const code = generateCode();
  const expiresAt = Date.now() + OTP_TTL_MS;
  _store.set(uid, { code, expiresAt, action: safeAction, createdAt: Date.now() });
  console.log('[SECURITY-OTP] OTP generado para uid=' + uid + ' action=' + safeAction);
  return { code, expiresAt, action: safeAction };
}

function verifyOTP(uid, inputCode) {
  if (!uid || !inputCode) return { valid: false, reason: 'uid_o_codigo_faltante' };
  const entry = _store.get(uid);
  if (!entry) return { valid: false, reason: 'no_otp_found' };
  if (Date.now() > entry.expiresAt) {
    _store.delete(uid);
    return { valid: false, reason: 'expired' };
  }
  const match = entry.code === String(inputCode).trim();
  if (match) {
    _store.delete(uid);
    console.log('[SECURITY-OTP] OTP verificado OK uid=' + uid);
    return { valid: true, action: entry.action };
  }
  return { valid: false, reason: 'wrong_code' };
}

function invalidateOTP(uid) {
  if (!uid) return false;
  const deleted = _store.delete(uid);
  if (deleted) console.log('[SECURITY-OTP] OTP invalidado uid=' + uid);
  return deleted;
}

function isOTPPending(uid) {
  if (!uid) return false;
  const entry = _store.get(uid);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    _store.delete(uid);
    return false;
  }
  return true;
}

function isCriticalAction(action) {
  if (!action) return false;
  return CRITICAL_ACTIONS.has(action);
}

function clearAllForTests() {
  _store.clear();
}

async function getTrustedContacts(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const db = getDb();
    const snap = await db.doc('owners/' + uid + '/security/trusted_contacts').get();
    if (!snap.exists) return [];
    return snap.data().contacts || [];
  } catch (err) {
    console.error('[SECURITY-OTP] Error cargando trusted contacts:', err.message);
    return [];
  }
}

async function setTrustedContacts(uid, contacts) {
  if (!uid) throw new Error('uid requerido');
  if (!Array.isArray(contacts)) throw new Error('contacts debe ser array');
  if (contacts.length > 3) throw new Error('maximo 3 trusted contacts');
  try {
    const db = getDb();
    await db.doc('owners/' + uid + '/security/trusted_contacts').set({
      contacts,
      updatedAt: new Date().toISOString(),
    });
    console.log('[SECURITY-OTP] Trusted contacts actualizados uid=' + uid + ' count=' + contacts.length);
    return { success: true, count: contacts.length };
  } catch (err) {
    console.error('[SECURITY-OTP] Error guardando trusted contacts:', err.message);
    throw err;
  }
}

module.exports = {
  generateOTP,
  verifyOTP,
  invalidateOTP,
  isOTPPending,
  isCriticalAction,
  getTrustedContacts,
  setTrustedContacts,
  clearAllForTests,
  __setFirestoreForTests,
  OTP_TTL_MS,
  OTP_LENGTH,
  CRITICAL_ACTIONS,
};
