'use strict';

/**
 * MIIA - Security OTP Manager (T229)
 * PB.4 ROADMAP: OTP para acciones criticas + trusted contacts recovery.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const OTP_LENGTH = 6;
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 3;
const OTP_COOLDOWN_MS = 60 * 1000;

const CRITICAL_ACTIONS = Object.freeze([
  'delete_account', 'export_all_data', 'api_key_rotate', 'change_phone',
  'transfer_ownership', 'reset_config', 'disconnect_whatsapp',
]);

const OTP_STATUSES = Object.freeze(['pending', 'used', 'expired', 'revoked']);

function generateOTPCode() {
  var code = '';
  for (var i = 0; i < OTP_LENGTH; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
}

function isValidCriticalAction(action) {
  return CRITICAL_ACTIONS.includes(action);
}

function isOTPExpired(record, nowMs) {
  if (!record || !record.expiresAt) return true;
  var now = nowMs !== undefined ? nowMs : Date.now();
  return new Date(record.expiresAt).getTime() <= now;
}

async function createOTP(uid, action, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!action) throw new Error('action requerido');
  if (!isValidCriticalAction(action)) throw new Error('action invalida: ' + action);
  var code = (opts && opts._forceCode) ? opts._forceCode : generateOTPCode();
  var now = Date.now();
  var record = {
    uid,
    action,
    code,
    status: 'pending',
    attempts: 0,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + OTP_TTL_MS).toISOString(),
    usedAt: null,
    channel: (opts && opts.channel) ? opts.channel : 'self_chat',
  };
  var otpId = 'otp_' + uid.slice(0, 4) + '_' + now.toString(36);
  await db().collection('tenants').doc(uid).collection('otp_requests').doc(otpId).set(record);
  console.log('[OTP] Creado uid=' + uid + ' action=' + action + ' id=' + otpId);
  return { otpId, code, expiresAt: record.expiresAt };
}

async function verifyOTP(uid, otpId, inputCode) {
  if (!uid) throw new Error('uid requerido');
  if (!otpId) throw new Error('otpId requerido');
  if (!inputCode) throw new Error('inputCode requerido');
  var snap = await db().collection('tenants').doc(uid).collection('otp_requests').doc(otpId).get();
  if (!snap || !snap.exists) throw new Error('OTP no encontrado: ' + otpId);
  var record = snap.data();
  if (record.status !== 'pending') {
    return { valid: false, reason: 'OTP no esta pendiente: ' + record.status };
  }
  if (isOTPExpired(record)) {
    await db().collection('tenants').doc(uid).collection('otp_requests').doc(otpId)
      .set({ status: 'expired', updatedAt: new Date().toISOString() }, { merge: true });
    return { valid: false, reason: 'OTP expirado' };
  }
  var attempts = (record.attempts || 0) + 1;
  if (attempts > MAX_OTP_ATTEMPTS) {
    await db().collection('tenants').doc(uid).collection('otp_requests').doc(otpId)
      .set({ status: 'revoked', attempts, updatedAt: new Date().toISOString() }, { merge: true });
    return { valid: false, reason: 'OTP revocado por exceso de intentos' };
  }
  if (String(inputCode).trim() !== String(record.code).trim()) {
    await db().collection('tenants').doc(uid).collection('otp_requests').doc(otpId)
      .set({ attempts, updatedAt: new Date().toISOString() }, { merge: true });
    return { valid: false, reason: 'Codigo incorrecto. Intentos: ' + attempts + '/' + MAX_OTP_ATTEMPTS };
  }
  await db().collection('tenants').doc(uid).collection('otp_requests').doc(otpId)
    .set({ status: 'used', usedAt: new Date().toISOString(), attempts, updatedAt: new Date().toISOString() }, { merge: true });
  console.log('[OTP] Verificado uid=' + uid + ' otpId=' + otpId + ' action=' + record.action);
  return { valid: true, action: record.action };
}

async function revokeOTP(uid, otpId) {
  if (!uid) throw new Error('uid requerido');
  if (!otpId) throw new Error('otpId requerido');
  await db().collection('tenants').doc(uid).collection('otp_requests').doc(otpId)
    .set({ status: 'revoked', updatedAt: new Date().toISOString() }, { merge: true });
  console.log('[OTP] Revocado uid=' + uid + ' otpId=' + otpId);
}

function buildOTPMessage(code, action, expiresAt) {
  var mins = Math.round(OTP_TTL_MS / 60000);
  return 'Tu codigo de seguridad para [' + action + '] es: ' + code + '. Valido por ' + mins + ' minutos. NO compartir.';
}

module.exports = {
  createOTP,
  verifyOTP,
  revokeOTP,
  buildOTPMessage,
  generateOTPCode,
  isOTPExpired,
  isValidCriticalAction,
  CRITICAL_ACTIONS,
  OTP_STATUSES,
  OTP_LENGTH,
  OTP_TTL_MS,
  MAX_OTP_ATTEMPTS,
  OTP_COOLDOWN_MS,
  __setFirestoreForTests,
};
