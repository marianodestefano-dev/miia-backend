/**
 * C-444 §B — ForgetMe helper (privacy delete con flag pendiente).
 *
 * Origen: CARTA_C-444 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27].
 *
 * NO ejecuta delete inmediato. Marca flag forgetme_pending con
 * timestamp + token. Cron diario 3 AM (post-C-445) procesa flagged
 * y borra real → da 24h ventana cancelación.
 *
 * Categorías borradas (segun C-442 schema):
 *   - profile (excepto auditLog del consent withdrawal).
 *   - conversations (raw + summaries).
 *   - contacts classifications.
 *   - calendar events generados por MIIA.
 *   - quotes.
 *   - config flags.
 *
 * auditLog del forgetme se PRESERVA (anonymizado pero entry queda).
 */

'use strict';

const crypto = require('crypto');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h ventana cancelación
const TOKEN_LENGTH = 6; // OTP digits

let _firestore = null;
function __setFirestoreForTests(fs) {
  _firestore = fs;
}
function _getFirestore() {
  if (_firestore) return _firestore;
  return require('firebase-admin').firestore();
}

function _generateOtp() {
  const buf = crypto.randomBytes(4);
  const num = buf.readUInt32BE(0) % 1_000_000;
  return String(num).padStart(TOKEN_LENGTH, '0');
}

/**
 * Solicita forgetme: genera OTP token, marca flag pending, devuelve
 * token (caller envía por mail al owner email).
 *
 * @param {string} ownerUid
 * @returns {Promise<{token: string, expiresAt: number}>}
 */
async function requestForgetMe(ownerUid) {
  if (typeof ownerUid !== 'string' || ownerUid.length < 20 || ownerUid.length > 128) {
    throw new Error('ownerUid invalid');
  }
  const fs = _getFirestore();
  const ref = fs.collection('users').doc(ownerUid);
  const snap = await ref.get();
  const existing = snap.exists ? (snap.data() || {}) : {};
  if (existing.forgetme_pending && existing.forgetme_request_at) {
    const age = Date.now() - existing.forgetme_request_at;
    if (age < TOKEN_TTL_MS) {
      throw new Error('forgetme already pending — wait for confirm or expiry');
    }
  }
  const token = _generateOtp();
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  await ref.set({
    forgetme_pending: true,
    forgetme_token_hash: tokenHash,
    forgetme_request_at: Date.now(),
    forgetme_expires_at: expiresAt,
    forgetme_confirmed: false,
  }, { merge: true });
  return { token, expiresAt };
}

/**
 * Confirma forgetme: valida token + marca confirmed=true. NO borra
 * inmediato (cron diario hace el delete real, da 24h cancelación
 * extra implícita por flujo cron).
 *
 * @param {string} ownerUid
 * @param {string} token
 * @returns {Promise<{confirmed: true}>}
 */
async function confirmForgetMe(ownerUid, token) {
  if (typeof ownerUid !== 'string' || ownerUid.length < 20) {
    throw new Error('ownerUid invalid');
  }
  if (typeof token !== 'string' || token.length !== TOKEN_LENGTH) {
    throw new Error('token invalid');
  }
  const fs = _getFirestore();
  const ref = fs.collection('users').doc(ownerUid);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('owner not found');
  const data = snap.data() || {};
  if (!data.forgetme_pending) throw new Error('no forgetme pending');
  if (Date.now() > (data.forgetme_expires_at || 0)) {
    throw new Error('token expired');
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  if (tokenHash !== data.forgetme_token_hash) {
    throw new Error('token mismatch');
  }
  await ref.set({
    forgetme_confirmed: true,
    forgetme_confirmed_at: Date.now(),
  }, { merge: true });
  return { confirmed: true };
}

/**
 * Cancela forgetme pending (owner cambió de opinión antes que cron
 * ejecute delete real).
 *
 * @param {string} ownerUid
 * @returns {Promise<{cancelled: true}>}
 */
async function cancelForgetMe(ownerUid) {
  if (typeof ownerUid !== 'string' || ownerUid.length < 20) {
    throw new Error('ownerUid invalid');
  }
  const fs = _getFirestore();
  const ref = fs.collection('users').doc(ownerUid);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('owner not found');
  const data = snap.data() || {};
  if (!data.forgetme_pending) throw new Error('no forgetme pending');
  await ref.set({
    forgetme_pending: false,
    forgetme_token_hash: null,
    forgetme_confirmed: false,
    forgetme_cancelled_at: Date.now(),
  }, { merge: true });
  return { cancelled: true };
}

/**
 * Ejecuta delete real para flagged confirmed (llamado por cron daily).
 * Preserva audit log entry anonymizado.
 *
 * @param {string} ownerUid
 * @returns {Promise<{deleted: string[], preservedAudit: number}>}
 */
async function executeForgetMe(ownerUid) {
  if (typeof ownerUid !== 'string' || ownerUid.length < 20) {
    throw new Error('ownerUid invalid');
  }
  const fs = _getFirestore();
  const ref = fs.collection('users').doc(ownerUid);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('owner not found');
  const data = snap.data() || {};
  if (!data.forgetme_confirmed) {
    throw new Error('forgetme not confirmed');
  }

  const subcolsToDelete = [
    'miia_memory',
    'contactTypes',
    'calendar_events',
    'quotes',
    'miia_state',
  ];
  const deleted = [];
  for (const sub of subcolsToDelete) {
    try {
      const subSnap = await ref.collection(sub).get();
      for (const doc of subSnap.docs) {
        await ref.collection(sub).doc(doc.id).delete();
      }
      deleted.push(sub);
    } catch (_) {
      // continúa con las demás
    }
  }

  // Marcar profile como anonymized (preserva uid + audit pero borra PII)
  await ref.set({
    email: null,
    name: null,
    whatsapp_number: null,
    aiDisclosureEnabled: null,
    weekendModeEnabled: null,
    forgetme_pending: false,
    forgetme_executed_at: Date.now(),
    forgetme_anonymized: true,
    forgetme_token_hash: null,
  }, { merge: true });

  // Audit log preserved (anonymized entry)
  await fs.collection('audit_logs').add({
    type: 'forgetme_executed',
    ownerUid_hash: crypto.createHash('sha256').update(ownerUid).digest('hex').slice(0, 16),
    timestamp: Date.now(),
    deleted_subcollections: deleted,
  }).catch(() => {});

  return { deleted, preservedAudit: 1 };
}

module.exports = {
  requestForgetMe,
  confirmForgetMe,
  cancelForgetMe,
  executeForgetMe,
  __setFirestoreForTests,
  TOKEN_TTL_MS,
  TOKEN_LENGTH,
};
