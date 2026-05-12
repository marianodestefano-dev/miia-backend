'use strict';

/**
 * R21-A -- core/otp_service.js (Planta Baja PB.4)
 * OTP email para acciones nivel alto.
 * Schema: owners/{uid}/otp_state { count_1h, window_start, pending: {token: {otp, expiresAt}} }
 */

const crypto = require('crypto');

const OTP_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 3;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const OTP_DIGITS = 6;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _otpStateRef(uid) {
  return db().collection('owners').doc(uid).collection('otp_state').doc('current');
}

function _ownerRef(uid) {
  return db().collection('owners').doc(uid);
}

function _genOTPCode() {
  const n = parseInt(crypto.randomBytes(4).toString('hex'), 16) % Math.pow(10, OTP_DIGITS);
  return String(n).padStart(OTP_DIGITS, '0');
}

async function generateOTP(uid) {
  if (!uid) throw new Error('uid_requerido');
  const snap = await _otpStateRef(uid).get();
  const state = snap.exists ? snap.data() : {};
  const now = Date.now();
  const windowStart = state.window_start || 0;
  const count = (now - windowStart < RATE_WINDOW_MS) ? (state.count_1h || 0) : 0;
  if (count >= RATE_LIMIT_MAX) throw new Error('otp_rate_limit_excedido');
  const otp = _genOTPCode();
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(now + OTP_TTL_MS).toISOString();
  const pending = state.pending || {};
  pending[token] = { otp, expiresAt };
  await _otpStateRef(uid).set({
    count_1h: count + 1,
    window_start: (now - windowStart < RATE_WINDOW_MS) ? windowStart : now,
    pending,
  }, { merge: true });
  console.log('[OTP_SERVICE] OTP generado uid=' + uid.slice(0, 8));
  return { otp, token, expiresAt };
}

async function validateOTP(uid, token, otp) {
  if (!uid || !token || !otp) return false;
  const snap = await _otpStateRef(uid).get();
  if (!snap.exists) return false;
  const state = snap.data();
  const pending = state.pending || {};
  const entry = pending[token];
  if (!entry) return false;
  if (Date.now() > new Date(entry.expiresAt).getTime()) {
    delete pending[token];
    await _otpStateRef(uid).set({ pending }, { merge: true });
    return false;
  }
  if (entry.otp !== otp) return false;
  delete pending[token];
  await _otpStateRef(uid).set({ pending }, { merge: true });
  return true;
}

async function sendOTPEmail(uid, otp) {
  if (!uid) throw new Error('uid_requerido');
  const snap = await _ownerRef(uid).get();
  if (!snap.exists) throw new Error('owner_no_encontrado');
  const email = snap.data().email || null;
  console.log('[OTP_SERVICE] OTP email uid=' + uid.slice(0, 8) + ' email=' + (email || 'N/A') + ' otp=' + otp);
  return { ok: true, email };
}

module.exports = {
  generateOTP,
  validateOTP,
  sendOTPEmail,
  OTP_TTL_MS,
  RATE_LIMIT_MAX,
  RATE_WINDOW_MS,
  __setFirestoreForTests,
};
