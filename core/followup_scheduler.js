'use strict';

/**
 * MIIA — Follow-up Scheduler (T134)
 * Programa seguimientos automaticos a leads.
 * Regla 6.27: NO outbound automatico a US.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

const FOLLOWUP_TYPES = Object.freeze(['first_contact', 'reminder_3d', 'reminder_7d', 'cold_15d', 'final_30d']);
const FOLLOWUP_DELAYS_MS = Object.freeze({
  first_contact: 0,
  reminder_3d: 3 * 24 * 60 * 60 * 1000,
  reminder_7d: 7 * 24 * 60 * 60 * 1000,
  cold_15d: 15 * 24 * 60 * 60 * 1000,
  final_30d: 30 * 24 * 60 * 60 * 1000,
});

const BLOCKED_COUNTRIES = Object.freeze(['US']); // Regla 6.27

/**
 * Verifica si un numero de telefono es de un pais bloqueado.
 */
function isBlockedCountry(phone) {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, '');
  // US: empieza con 1 y tiene 11 digitos (sin prefijo 54/57/52/55)
  if (digits.startsWith('1') && digits.length === 11 &&
      !digits.startsWith('52') && !digits.startsWith('55')) {
    return true;
  }
  return false;
}

/**
 * Crea un follow-up programado para un lead.
 * @param {string} uid
 * @param {string} phone
 * @param {string} type - debe ser uno de FOLLOWUP_TYPES
 * @param {object} [opts]
 * @returns {Promise<{ followupId, scheduledAt, type }>}
 */
async function scheduleFollowup(uid, phone, type, opts = {}) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!phone || typeof phone !== 'string') throw new Error('phone requerido');
  if (!FOLLOWUP_TYPES.includes(type)) throw new Error(`type invalido: ${type}`);

  if (isBlockedCountry(phone)) {
    console.warn(`[FOLLOWUP] BLOCKED: no outbound a US phone=${phone.slice(-4)}`);
    return { followupId: null, scheduledAt: null, type, blocked: true, reason: 'US_POLICY' };
  }

  const nowMs = opts._nowMs || Date.now();
  const delayMs = FOLLOWUP_DELAYS_MS[type];
  const scheduledAt = new Date(nowMs + delayMs).toISOString();
  const followupId = `fu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const payload = {
    followupId,
    uid,
    phone,
    type,
    scheduledAt,
    createdAt: new Date(nowMs).toISOString(),
    status: 'pending',
    message: opts.message || null,
  };

  try {
    await db().collection('followups').doc(uid).collection('items').doc(followupId).set(payload);
    console.log(`[FOLLOWUP] Scheduled uid=${uid.substring(0,8)} phone=${phone.slice(-4)} type=${type} at=${scheduledAt}`);
  } catch (e) {
    console.error(`[FOLLOWUP] CRITICAL: no se pudo guardar followup: ${e.message}`);
    throw e;
  }

  return { followupId, scheduledAt, type };
}

/**
 * Cancela un follow-up pendiente.
 */
async function cancelFollowup(uid, followupId) {
  if (!uid) throw new Error('uid requerido');
  if (!followupId) throw new Error('followupId requerido');
  try {
    await db().collection('followups').doc(uid).collection('items').doc(followupId).set(
      { status: 'cancelled', cancelledAt: new Date().toISOString() },
      { merge: true }
    );
    console.log(`[FOLLOWUP] Cancelled uid=${uid.substring(0,8)} id=${followupId}`);
    return { cancelled: true };
  } catch (e) {
    console.error(`[FOLLOWUP] Error cancelling ${followupId}: ${e.message}`);
    return { cancelled: false, error: e.message };
  }
}

/**
 * Obtiene los follow-ups pendientes de un uid.
 */
async function getPendingFollowups(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('followups').doc(uid).collection('items').get();
    return snap.docs
      .map(d => d.data())
      .filter(d => d.status === 'pending');
  } catch (e) {
    console.error(`[FOLLOWUP] Error leyendo pending uid=${uid.substring(0,8)}: ${e.message}`);
    return [];
  }
}

module.exports = {
  scheduleFollowup,
  cancelFollowup,
  getPendingFollowups,
  isBlockedCountry,
  FOLLOWUP_TYPES,
  FOLLOWUP_DELAYS_MS,
  __setFirestoreForTests,
};
