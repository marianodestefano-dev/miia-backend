'use strict';

/**
 * inter_miia_network.js -- T188 + T200-T202 (red inter-MIIA + referidos + comisiones).
 */

const { randomUUID } = require('crypto');

const NETWORK_EVENT_TYPES = Object.freeze(['referral_sent', 'referral_accepted', 'referral_rejected', 'lead_transfer', 'commission_paid']);
const NETWORK_STATES = Object.freeze(['pending', 'accepted', 'rejected', 'expired']);
const REFERRAL_REWARD_POINTS = 10;

const COL_REFERRALS = 'inter_miia_referrals';
const COL_EVENTS = 'inter_miia_events';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

async function sendReferral(fromUid, toUid, leadPhone, opts) {
  if (!fromUid) throw new Error('fromUid requerido');
  if (!toUid) throw new Error('toUid requerido');
  if (!leadPhone) throw new Error('leadPhone requerido');
  if (fromUid === toUid) throw new Error('fromUid y toUid no pueden ser iguales');
  const referralId = (opts && opts.referralId) || randomUUID();
  const data = {
    referralId, fromUid, toUid, leadPhone,
    state: 'pending', points: REFERRAL_REWARD_POINTS,
    note: (opts && opts.note) || null,
    createdAt: new Date().toISOString(),
  };
  await db().collection(COL_REFERRALS).doc(referralId).set(data);
  return { referralId, state: 'pending', points: REFERRAL_REWARD_POINTS };
}

async function updateReferralState(referralId, newState) {
  if (!referralId) throw new Error('referralId requerido');
  if (!NETWORK_STATES.includes(newState)) throw new Error('state invalido: ' + newState);
  await db().collection(COL_REFERRALS).doc(referralId).set({
    state: newState, updatedAt: new Date().toISOString(),
  }, { merge: true });
}

async function getSentReferrals(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection(COL_REFERRALS).where('fromUid', '==', uid).get();
    const out = [];
    snap.forEach(d => out.push(d.data ? d.data() : {}));
    return out;
  } catch (e) {
    return [];
  }
}

async function getReceivedReferrals(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection(COL_REFERRALS).where('toUid', '==', uid).get();
    const out = [];
    snap.forEach(d => out.push(d.data ? d.data() : {}));
    return out;
  } catch (e) {
    return [];
  }
}

async function getNetworkPoints(uid) {
  if (!uid) throw new Error('uid requerido');
  const sent = await getSentReferrals(uid);
  const accepted = sent.filter(r => r.state === 'accepted');
  return {
    uid,
    sentCount: sent.length,
    acceptedCount: accepted.length,
    pendingCount: sent.filter(r => r.state === 'pending').length,
    totalPoints: accepted.length * REFERRAL_REWARD_POINTS,
  };
}

async function recordNetworkEvent(fromUid, toUid, eventType, payload) {
  if (!fromUid) throw new Error('fromUid requerido');
  if (!toUid) throw new Error('toUid requerido');
  if (!NETWORK_EVENT_TYPES.includes(eventType)) throw new Error('eventType invalido: ' + eventType);
  await db().collection(COL_EVENTS).doc().set({
    fromUid, toUid, eventType, payload: payload || null,
    timestamp: new Date().toISOString(),
  });
}

module.exports = {
  sendReferral,
  updateReferralState,
  getSentReferrals,
  getReceivedReferrals,
  getNetworkPoints,
  recordNetworkEvent,
  NETWORK_EVENT_TYPES,
  NETWORK_STATES,
  REFERRAL_REWARD_POINTS,
  __setFirestoreForTests,
};
