'use strict';

/**
 * MIIA - Referral Agreement (T201)
 * Acuerdo formal de referidos entre dos owners MIIA.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const AGREEMENT_STATES = Object.freeze(['proposed', 'active', 'paused', 'terminated']);
const COMMISSION_TYPES = Object.freeze(['percentage', 'fixed', 'points', 'reciprocal']);
const MAX_COMMISSION_PERCENT = 50;
const MIN_COMMISSION_PERCENT = 0;

function validateCommission(commissionType, commissionValue) {
  if (!COMMISSION_TYPES.includes(commissionType)) throw new Error('commissionType invalido: ' + commissionType);
  if (commissionType === 'percentage') {
    if (typeof commissionValue !== 'number') throw new Error('commissionValue debe ser numero');
    if (commissionValue < MIN_COMMISSION_PERCENT || commissionValue > MAX_COMMISSION_PERCENT) {
      throw new Error('commissionValue debe ser entre 0 y 50');
    }
  }
}

async function proposeAgreement(fromUid, toUid, opts) {
  if (!fromUid) throw new Error('fromUid requerido');
  if (!toUid) throw new Error('toUid requerido');
  if (fromUid === toUid) throw new Error('fromUid y toUid no pueden ser iguales');
  opts = opts || {};
  var commissionType = opts.commissionType || 'reciprocal';
  var commissionValue = opts.commissionValue !== undefined ? opts.commissionValue : 0;
  validateCommission(commissionType, commissionValue);
  var agreementId = [fromUid, toUid].sort().join('_').substring(0, 32);
  var data = {
    agreementId, fromUid, toUid,
    state: 'proposed',
    commissionType, commissionValue,
    notes: opts.notes || null,
    proposedAt: new Date().toISOString(),
    acceptedAt: null,
    terminatedAt: null,
  };
  try {
    await db().collection('referral_agreements').doc(agreementId).set(data);
    await db().collection('tenants').doc(fromUid).collection('my_agreements').doc(agreementId).set({ agreementId, toUid, state: 'proposed', role: 'proposer' });
    await db().collection('tenants').doc(toUid).collection('my_agreements').doc(agreementId).set({ agreementId, fromUid, state: 'proposed', role: 'receiver' });
    console.log('[REFERRAL_AGREEMENT] Propuesta agreementId=' + agreementId);
    return { agreementId, state: 'proposed' };
  } catch (e) {
    console.error('[REFERRAL_AGREEMENT] Error creando: ' + e.message);
    throw e;
  }
}

async function updateAgreementState(agreementId, state, uid) {
  if (!agreementId) throw new Error('agreementId requerido');
  if (!AGREEMENT_STATES.includes(state)) throw new Error('state invalido: ' + state);
  var update = { state, updatedAt: new Date().toISOString() };
  if (state === 'active') update.acceptedAt = new Date().toISOString();
  if (state === 'terminated') update.terminatedAt = new Date().toISOString();
  try {
    await db().collection('referral_agreements').doc(agreementId).set(update, { merge: true });
    return { agreementId, state };
  } catch (e) {
    console.error('[REFERRAL_AGREEMENT] Error actualizando: ' + e.message);
    throw e;
  }
}

async function getAgreement(agreementId) {
  if (!agreementId) throw new Error('agreementId requerido');
  try {
    var snap = await db().collection('referral_agreements').doc(agreementId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (e) {
    console.error('[REFERRAL_AGREEMENT] Error leyendo: ' + e.message);
    return null;
  }
}

async function getMyAgreements(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('my_agreements').get();
    var results = [];
    snap.forEach(function(doc) { results.push(doc.data()); });
    return results;
  } catch (e) {
    console.error('[REFERRAL_AGREEMENT] Error leyendo mis acuerdos: ' + e.message);
    return [];
  }
}

async function isAgreementActive(fromUid, toUid) {
  if (!fromUid) throw new Error('fromUid requerido');
  if (!toUid) throw new Error('toUid requerido');
  var agreementId = [fromUid, toUid].sort().join('_').substring(0, 32);
  try {
    var snap = await db().collection('referral_agreements').doc(agreementId).get();
    if (!snap.exists) return false;
    return snap.data().state === 'active';
  } catch (e) {
    console.error('[REFERRAL_AGREEMENT] Error verificando: ' + e.message);
    return false;
  }
}

module.exports = {
  validateCommission,
  proposeAgreement,
  updateAgreementState,
  getAgreement,
  getMyAgreements,
  isAgreementActive,
  AGREEMENT_STATES,
  COMMISSION_TYPES,
  MAX_COMMISSION_PERCENT,
  __setFirestoreForTests,
};