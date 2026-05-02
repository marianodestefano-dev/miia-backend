'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const REPUTATION_LEVELS = Object.freeze(['blocked', 'flagged', 'new', 'verified', 'trusted']);
const CONSENT_TYPES = Object.freeze(['explicit', 'legitimate_interest', 'denied']);
const FRAUD_SIGNAL_TYPES = Object.freeze(['spam', 'fake_business', 'identity_theft', 'payment_fraud', 'harassment']);

async function searchCrossTenant(query, opts) {
  opts = opts || {};
  const limit = opts.limit || 10;
  const minRep = opts.minReputation || 'new';
  const repOrder = ['blocked', 'flagged', 'new', 'verified', 'trusted'];
  const minIdx = repOrder.indexOf(minRep);
  const snap = await getDb().collection('network_directory').get();
  const results = [];
  snap.forEach(doc => {
    const d = doc.data();
    const repIdx = repOrder.indexOf(d.reputation || 'new');
    if (repIdx < minIdx || d.status === 'inactive') return;
    const text = (d.name + ' ' + (d.description || '') + ' ' + (d.category || '')).toLowerCase();
    const words = (query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const score = words.length ? words.filter(w => text.includes(w)).length : 1;
    if (score > 0) results.push({ id: doc.id, ...d, _score: score, _repIdx: repIdx });
  });
  results.sort((a, b) => b._score - a._score || b._repIdx - a._repIdx);
  return results.slice(0, limit).map(({ _score, _repIdx, ...r }) => r);
}

async function deriveLead(fromUid, toUid, leadPhone, opts) {
  opts = opts || {};
  const consent = opts.consent || 'legitimate_interest';
  if (!CONSENT_TYPES.includes(consent)) throw new Error('Invalid consent type: ' + consent);
  const derivation = { id: randomUUID(), fromUid, toUid, leadPhone, consent, context: opts.context || null, sourceMessage: opts.sourceMessage ? opts.sourceMessage.slice(0, 200) : null, status: 'pending', derivedAt: new Date().toISOString() };
  await getDb().collection('lead_derivations').doc(derivation.id).set(derivation);
  return derivation;
}

async function acceptLeadDerivation(derivationId, toUid) {
  const ref = getDb().collection('lead_derivations').doc(derivationId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Derivation not found: ' + derivationId);
  if (doc.data().toUid !== toUid) throw new Error('Unauthorized');
  await ref.set({ status: 'accepted', acceptedAt: new Date().toISOString() }, { merge: true });
  return { derivationId, status: 'accepted' };
}

async function recordFraudSignal(uid, targetPhone, signalType) {
  if (!FRAUD_SIGNAL_TYPES.includes(signalType)) throw new Error('Invalid signal type: ' + signalType);
  const signal = { id: randomUUID(), reporterUid: uid, targetPhone, signalType, status: 'open', reportedAt: new Date().toISOString() };
  await getDb().collection('fraud_signals').doc(signal.id).set(signal);
  return signal;
}

async function getBusinessReputation(uid) {
  const fraudSnap = await getDb().collection('fraud_signals').where('reporterUid', '==', uid).get();
  const fraudCount = fraudSnap.size || 0;
  const ownerDoc = await getDb().collection('owners').doc(uid).get();
  const data = ownerDoc.exists ? ownerDoc.data() : {};
  const days = data.registeredAt ? Math.floor((Date.now() - new Date(data.registeredAt).getTime()) / 86400000) : 0;
  let level = fraudCount >= 5 ? 'blocked' : fraudCount >= 3 ? 'flagged' : days > 90 && fraudCount === 0 ? 'trusted' : days > 30 ? 'verified' : 'new';
  return { uid, reputationLevel: level, fraudSignals: fraudCount, registeredDays: days };
}

async function rankBusinesses(category, limit) {
  limit = limit || 10;
  const snap = await getDb().collection('network_directory').where('category', '==', category).get();
  const businesses = [];
  snap.forEach(doc => businesses.push({ id: doc.id, ...doc.data() }));
  const score = { trusted: 4, verified: 3, new: 2, flagged: 1, blocked: 0 };
  businesses.sort((a, b) => (score[b.reputation || 'new'] || 0) - (score[a.reputation || 'new'] || 0));
  return businesses.slice(0, limit);
}

module.exports = { __setFirestoreForTests, REPUTATION_LEVELS, CONSENT_TYPES, FRAUD_SIGNAL_TYPES,
  searchCrossTenant, deriveLead, acceptLeadDerivation, recordFraudSignal, getBusinessReputation, rankBusinesses };