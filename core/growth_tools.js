'use strict';

/**
 * MIIA - Growth Tools (T189)
 * Herramientas de crecimiento: referral program, loyalty points, campanas de reactivacion.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const GROWTH_CAMPAIGN_TYPES = Object.freeze(['referral', 'loyalty', 'reactivation', 'win_back', 'upsell']);
const REFERRAL_CODE_LENGTH = 8;
const DEFAULT_REFERRAL_REWARD = 10;
const DEFAULT_LOYALTY_POINTS_PER_PURCHASE = 5;
const MAX_LOYALTY_POINTS = 10000;
const REACTIVATION_DAYS_THRESHOLD = 30;


/**
 * Genera un codigo de referido unico para un contacto.
 * @param {string} uid
 * @param {string} phone
 * @returns {Promise<{code, referralUrl}>}
 */
async function generateReferralCode(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');

  const base = (uid.substring(0, 4) + phone.slice(-4)).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  const code = (base + random).substring(0, REFERRAL_CODE_LENGTH);

  const doc = {
    uid, phone, code,
    usedCount: 0,
    rewardPoints: DEFAULT_REFERRAL_REWARD,
    createdAt: new Date().toISOString(),
    active: true,
  };

  try {
    await db()
      .collection('referral_codes').doc(uid)
      .collection('codes').doc(code)
      .set(doc);
    return { code, referralUrl: 'https://miia.app/ref/' + code };
  } catch (e) {
    console.error('[GROWTH] Error generando codigo referido: ' + e.message);
    throw e;
  }
}

/**
 * Aplica un codigo de referido (cuando un nuevo lead lo usa).
 * @param {string} ownerUid - uid del owner que tiene el programa
 * @param {string} code - codigo de referido
 * @param {string} newLeadPhone - telefono del nuevo lead
 * @returns {Promise<{applied, reward, referrerPhone}>}
 */
async function applyReferralCode(ownerUid, code, newLeadPhone) {
  if (!ownerUid) throw new Error('ownerUid requerido');
  if (!code) throw new Error('code requerido');
  if (!newLeadPhone) throw new Error('newLeadPhone requerido');

  try {
    const snap = await db()
      .collection('referral_codes').doc(ownerUid)
      .collection('codes').doc(code)
      .get();

    if (!snap.exists) return { applied: false, reason: 'codigo no encontrado' };

    const data = snap.data();
    if (!data.active) return { applied: false, reason: 'codigo inactivo' };

    await db()
      .collection('referral_codes').doc(ownerUid)
      .collection('codes').doc(code)
      .set({ usedCount: (data.usedCount || 0) + 1, lastUsedAt: new Date().toISOString() }, { merge: true });

    console.log('[GROWTH] codigo referido aplicado code=' + code + ' lead=' + newLeadPhone.slice(-6));
    return { applied: true, reward: data.rewardPoints || DEFAULT_REFERRAL_REWARD, referrerPhone: data.phone };
  } catch (e) {
    console.error('[GROWTH] Error aplicando codigo: ' + e.message);
    return { applied: false, reason: 'error: ' + e.message };
  }
}

/**
 * Agrega puntos de loyalty a un contacto.
 * @param {string} uid
 * @param {string} phone
 * @param {number} points
 * @param {string} [reason]
 */
async function addLoyaltyPoints(uid, phone, points, reason) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (typeof points !== 'number' || points <= 0) throw new Error('points debe ser numero positivo');

  const pointsDoc = uid.substring(0, 8) + '_' + phone.replace('+', '');

  try {
    const snap = await db().collection('loyalty_points').doc(pointsDoc).get();
    const current = snap.exists ? (snap.data().points || 0) : 0;
    const newPoints = Math.min(current + points, MAX_LOYALTY_POINTS);

    await db().collection('loyalty_points').doc(pointsDoc).set({
      uid, phone, points: newPoints,
      lastAddedAt: new Date().toISOString(),
      lastAddedReason: reason || 'purchase',
    }, { merge: true });

    console.log('[GROWTH] puntos agregados uid=' + uid.substring(0, 8) + ' phone=' + phone.slice(-6) + ' points=' + points);
    return { newTotal: newPoints, added: points };
  } catch (e) {
    console.error('[GROWTH] Error agregando puntos: ' + e.message);
    throw e;
  }
}

/**
 * Lee los puntos de loyalty de un contacto.
 * @param {string} uid
 * @param {string} phone
 * @returns {Promise<number>}
 */
async function getLoyaltyPoints(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');

  const pointsDoc = uid.substring(0, 8) + '_' + phone.replace('+', '');
  try {
    const snap = await db().collection('loyalty_points').doc(pointsDoc).get();
    if (!snap.exists) return 0;
    return snap.data().points || 0;
  } catch (e) {
    console.error('[GROWTH] Error leyendo puntos: ' + e.message);
    return 0;
  }
}

/**
 * Identifica contactos inactivos para campana de reactivacion.
 * @param {string} uid
 * @param {object[]} contacts - [{phone, lastContactAt, ...}]
 * @param {number} [daysThreshold]
 * @returns {object[]} contactos inactivos
 */
function getInactiveContacts(contacts, daysThreshold, nowMs) {
  if (!Array.isArray(contacts)) throw new Error('contacts debe ser array');
  const threshold = typeof daysThreshold === 'number' && daysThreshold > 0
    ? daysThreshold
    : REACTIVATION_DAYS_THRESHOLD;
  const now = nowMs || Date.now();
  const thresholdMs = threshold * 24 * 60 * 60 * 1000;

  return contacts.filter(c => {
    if (!c.lastContactAt) return false;
    const lastMs = new Date(c.lastContactAt).getTime();
    return (now - lastMs) >= thresholdMs;
  });
}

module.exports = {
  generateReferralCode, applyReferralCode,
  addLoyaltyPoints, getLoyaltyPoints, getInactiveContacts,
  GROWTH_CAMPAIGN_TYPES, REFERRAL_CODE_LENGTH, DEFAULT_REFERRAL_REWARD,
  DEFAULT_LOYALTY_POINTS_PER_PURCHASE, MAX_LOYALTY_POINTS, REACTIVATION_DAYS_THRESHOLD,
  __setFirestoreForTests,
};
