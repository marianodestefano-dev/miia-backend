'use strict';

/**
 * R15-B — Anti-spam alertas contactos desconocidos (IDEA #027)
 * Cooldown 24h por contacto en owners/{uid}/unknown_alerts/{phoneHash}
 */

const crypto = require('crypto');
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _phoneHash(phone) {
  return crypto.createHash('sha256').update(String(phone || /* istanbul ignore next */ '')).digest('hex').slice(0, 16);
}

function _alertRef(uid, phoneHash) {
  return db().collection('owners').doc(uid).collection('unknown_alerts').doc(phoneHash);
}

/**
 * Devuelve true si se puede enviar la alerta (fuera del cooldown).
 * Fail-open: si Firestore falla, permite alertar (mejor notificar que silenciar).
 */
async function shouldSendAlert(uid, phone) {
  if (!uid || !phone) return false;
  const hash = _phoneHash(phone);
  try {
    const snap = await _alertRef(uid, hash).get();
    if (!snap.exists) return true;
    const last = snap.data().fecha_ultima_alerta || 0;
    return (Date.now() - last) > COOLDOWN_MS;
  } catch (e) {
    console.error('[ALERT-COOLDOWN] shouldSendAlert error uid=' + uid.slice(0, 8) + ':', e.message);
    return true;
  }
}

/**
 * Registra que se envió una alerta para este contacto.
 */
async function markAlertSent(uid, phone) {
  if (!uid || !phone) return;
  const hash = _phoneHash(phone);
  try {
    await _alertRef(uid, hash).set({
      fecha_ultima_alerta: Date.now(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    console.log('[ALERT-COOLDOWN] marcado uid=' + uid.slice(0, 8) + ' hash=' + hash);
  } catch (e) {
    console.error('[ALERT-COOLDOWN] markAlertSent error uid=' + uid.slice(0, 8) + ':', e.message);
  }
}

module.exports = { shouldSendAlert, markAlertSent, __setFirestoreForTests, COOLDOWN_MS };
