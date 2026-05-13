'use strict';

/**
 * core/signup_on_payment.js -- A.1 firma Mariano 2026-05-02 ~16:00 COT
 *
 * Helper para flow Modelo B: webhook MP/PayPal recibe email del pago,
 * crea cuenta Firebase si no existe, retorna uid + dispara magic link.
 *
 * API:
 *   ensureUserFromEmail(email) -> { uid, created: bool, email }
 *   isLikelyEmail(s)           -> bool
 *
 * INYECCION testeable:
 *   __setAdminAuthForTests(authImpl)
 */

const admin = require('firebase-admin');

let _authOverride = null;

function __setAdminAuthForTests(a) { _authOverride = a; }

function _auth() {
  /* istanbul ignore next */
  return _authOverride || admin.auth();
}

function isLikelyEmail(s) {
  if (!s || typeof s !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

async function ensureUserFromEmail(email) {
  if (!isLikelyEmail(email)) { throw new Error('invalid_email'); }
  const auth = _auth();
  try {
    const existing = await auth.getUserByEmail(email);
    if (existing && existing.uid) {
      return { uid: existing.uid, created: false, email };
    }
  } catch (e) {
    if (!e || e.code !== 'auth/user-not-found') {
      throw e;
    }
  }
  // No existe: crear cuenta
  const created = await auth.createUser({
    email,
    emailVerified: false,
    disabled: false,
  });
  return { uid: created.uid, created: true, email };
}

module.exports = {
  ensureUserFromEmail,
  isLikelyEmail,
  __setAdminAuthForTests,
};
