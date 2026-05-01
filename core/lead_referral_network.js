'use strict';

/**
 * MIIA - Lead Referral Network (T200)
 * MIIA puede referir leads a otro negocio MIIA de la red.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const REFERRAL_STATES = Object.freeze(['pending', 'accepted', 'rejected', 'converted', 'expired']);
const REFERRAL_TYPES = Object.freeze(['product_match', 'geographic', 'capacity', 'specialization', 'mutual_agreement']);
const DEFAULT_EXPIRY_DAYS = 14;
const MAX_REFERRALS_PER_DAY = 10;

function buildReferralMessage(fromBusinessName, toBusinessName, reason, language) {
  if (language === 'en') {
    return 'Hi! We think ' + toBusinessName + ' might be able to help you better with your needs. Would you like us to connect you?';
  }
  return 'Hola! Creemos que ' + toBusinessName + ' puede ayudarte mejor con lo que necesitas. Te ponemos en contacto?';
}

async function createReferral(fromUid, toUid, leadPhone, opts) {
  if (!fromUid) throw new Error('fromUid requerido');
  if (!toUid) throw new Error('toUid requerido');
  if (!leadPhone) throw new Error('leadPhone requerido');
  if (fromUid === toUid) throw new Error('fromUid y toUid no pueden ser iguales');
  opts = opts || {};
  var type = opts.type || 'product_match';
  if (!REFERRAL_TYPES.includes(type)) throw new Error('type invalido: ' + type);
  var referralId = fromUid.substring(0, 8) + '_' + toUid.substring(0, 8) + '_' + Date.now().toString(36);
  var expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  var data = {
    referralId, fromUid, toUid, leadPhone, type,
    state: 'pending',
    notes: opts.notes || null,
    createdAt: new Date().toISOString(),
    expiresAt,
    acceptedAt: null,
    convertedAt: null,
  };
  try {
    await db().collection('lead_referrals').doc(referralId).set(data);
    await db().collection('tenants').doc(fromUid).collection('sent_referrals').doc(referralId).set({ referralId, toUid, leadPhone, createdAt: data.createdAt, state: 'pending' });
    await db().collection('tenants').doc(toUid).collection('received_referrals').doc(referralId).set({ referralId, fromUid, leadPhone, createdAt: data.createdAt, state: 'pending' });
    console.log('[LEAD_REFERRAL] Creado referralId=' + referralId + ' from=' + fromUid.substring(0, 8) + ' to=' + toUid.substring(0, 8));
    return { referralId, state: 'pending', expiresAt };
  } catch (e) {
    console.error('[LEAD_REFERRAL] Error creando referido: ' + e.message);
    throw e;
  }
}

async function updateReferralState(referralId, state, fromUid, toUid) {
  if (!referralId) throw new Error('referralId requerido');
  if (!REFERRAL_STATES.includes(state)) throw new Error('state invalido: ' + state);
  var update = { state, updatedAt: new Date().toISOString() };
  if (state === 'accepted') update.acceptedAt = new Date().toISOString();
  if (state === 'converted') update.convertedAt = new Date().toISOString();
  try {
    await db().collection('lead_referrals').doc(referralId).set(update, { merge: true });
    console.log('[LEAD_REFERRAL] Estado actualizado referralId=' + referralId + ' state=' + state);
    return { referralId, state };
  } catch (e) {
    console.error('[LEAD_REFERRAL] Error actualizando: ' + e.message);
    throw e;
  }
}

async function getSentReferrals(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('sent_referrals').get();
    var results = [];
    snap.forEach(function(doc) { results.push(doc.data()); });
    return results.sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  } catch (e) {
    console.error('[LEAD_REFERRAL] Error leyendo enviados: ' + e.message);
    return [];
  }
}

async function getReceivedReferrals(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('received_referrals').get();
    var results = [];
    snap.forEach(function(doc) { results.push(doc.data()); });
    return results.sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  } catch (e) {
    console.error('[LEAD_REFERRAL] Error leyendo recibidos: ' + e.message);
    return [];
  }
}

async function getReferralStats(uid) {
  if (!uid) throw new Error('uid requerido');
  var sent = await getSentReferrals(uid);
  var received = await getReceivedReferrals(uid);
  var sentConverted = sent.filter(function(r) { return r.state === 'converted'; }).length;
  var receivedConverted = received.filter(function(r) { return r.state === 'converted'; }).length;
  return {
    sentTotal: sent.length,
    receivedTotal: received.length,
    sentConverted,
    receivedConverted,
    conversionRate: sent.length > 0 ? Math.round((sentConverted / sent.length) * 100) : 0,
  };
}

module.exports = {
  buildReferralMessage,
  createReferral,
  updateReferralState,
  getSentReferrals,
  getReceivedReferrals,
  getReferralStats,
  REFERRAL_STATES,
  REFERRAL_TYPES,
  DEFAULT_EXPIRY_DAYS,
  __setFirestoreForTests,
};