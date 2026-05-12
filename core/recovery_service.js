'use strict';

/**
 * R21-B -- core/recovery_service.js (Planta Baja PB.4)
 * Trusted Contacts para recovery de cuenta owner.
 * Schema: owners/{uid}/trusted_contacts/{phone}
 *   { phone, nombre, nivel, addedAt }
 * owners/{uid}/recovery_state/{token}
 *   { recoveryPhone, otp, expiresAt, completed }
 */

const crypto = require('crypto');

const RECOVERY_TTL_MS = 15 * 60 * 1000;
const TEMP_ACCESS_TTL_MS = 60 * 60 * 1000;
const NIVELES = ['basic', 'advanced', 'emergency'];

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _trustedRef(uid, phone) {
  return db().collection('owners').doc(uid).collection('trusted_contacts').doc(phone);
}

function _recoveryRef(uid, token) {
  return db().collection('owners').doc(uid).collection('recovery_state').doc(token);
}

async function addTrustedContact(uid, phone, nombre, nivel) {
  if (!uid || !phone || !nombre) throw new Error('parametros_requeridos');
  const niv = NIVELES.includes(nivel) ? nivel : 'basic';
  await _trustedRef(uid, phone).set({ phone, nombre, nivel: niv, addedAt: new Date().toISOString() });
  console.log('[RECOVERY] trusted contact agregado uid=' + uid.slice(0, 8) + ' phone=' + phone.slice(-4));
  return { ok: true };
}

async function initiateRecovery(uid, recoveryPhone) {
  if (!uid || !recoveryPhone) throw new Error('parametros_requeridos');
  const snap = await _trustedRef(uid, recoveryPhone).get();
  if (!snap.exists) throw new Error('contacto_no_autorizado');
  const otp = String(Math.floor(Math.random() * 900000) + 100000);
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + RECOVERY_TTL_MS).toISOString();
  await _recoveryRef(uid, token).set({ recoveryPhone, otp, expiresAt, completed: false });
  console.log('[RECOVERY] iniciado uid=' + uid.slice(0, 8));
  return {
    token,
    instrucciones: 'Contacta a ' + snap.data().nombre + ' y pide el OTP. Expira en 15 minutos.',
  };
}

async function completeRecovery(uid, token, otp) {
  if (!uid || !token || !otp) throw new Error('parametros_requeridos');
  const snap = await _recoveryRef(uid, token).get();
  if (!snap.exists) throw new Error('recovery_no_encontrado');
  const data = snap.data();
  if (data.completed) throw new Error('recovery_ya_completado');
  if (Date.now() > new Date(data.expiresAt).getTime()) throw new Error('recovery_expirado');
  if (data.otp !== otp) throw new Error('otp_invalido');
  const temp_access = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TEMP_ACCESS_TTL_MS).toISOString();
  await _recoveryRef(uid, token).set({ completed: true, temp_access, completedAt: new Date().toISOString() }, { merge: true });
  console.log('[RECOVERY] completado uid=' + uid.slice(0, 8));
  return { temp_access, expiresAt };
}

module.exports = {
  addTrustedContact,
  initiateRecovery,
  completeRecovery,
  RECOVERY_TTL_MS,
  TEMP_ACCESS_TTL_MS,
  NIVELES,
  __setFirestoreForTests,
};
