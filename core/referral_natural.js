'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const LEAD_STATUS = Object.freeze(['queued', 'outreach_pending', 'contacted', 'converted', 'expired']);
const INTEREST_SIGNALS = Object.freeze(['me interesa', 'donde puedo', 'cuanto cuesta', 'como funciona', 'quiero saber', 'me gustaria', 'tienen']);
const MAX_DAILY_OUTREACH = 3;

// Firestore schema doc (not used at runtime, serves as living spec)
const FIRESTORE_SCHEMA = Object.freeze({
  'miia_leads_queue/{id}': { fromPhone: 'string', toUid: 'string', context: 'string|null', sourceConversation: 'string|null', status: 'LEAD_STATUS', queuedAt: 'ISO8601', contactedAt: 'ISO8601|null', convertedAt: 'ISO8601|null' },
  'miia_outreach_capacity/{uid}_{date}': { uid: 'string', date: 'YYYY-MM-DD', count: 'number', limit: 'number=3', lastUpdated: 'ISO8601' },
});

function detectInterestSignal(message) {
  const lower = (message || '').toLowerCase();
  const detected = INTEREST_SIGNALS.filter(sig => lower.includes(sig));
  return { interested: detected.length > 0, confidence: Math.min(1, detected.length * 0.4), signals: detected };
}

async function queueLead(fromPhone, toUid, opts) {
  opts = opts || {};
  const lead = { id: randomUUID(), fromPhone, toUid, context: opts.context || null, sourceConversation: opts.sourceMessage ? opts.sourceMessage.slice(0, 300) : null, status: 'queued', queuedAt: new Date().toISOString(), contactedAt: null, convertedAt: null };
  await getDb().collection('miia_leads_queue').doc(lead.id).set(lead);
  return lead;
}

async function getOutreachCapacity(uid, date) {
  const dateStr = date || new Date().toISOString().slice(0, 10);
  const doc = await getDb().collection('miia_outreach_capacity').doc(uid + '_' + dateStr).get();
  const count = doc.exists ? (doc.data().count || 0) : 0;
  return { uid, date: dateStr, count, limit: MAX_DAILY_OUTREACH, available: MAX_DAILY_OUTREACH - count };
}

async function canDoOutreach(uid, date) {
  const cap = await getOutreachCapacity(uid, date);
  return cap.available > 0;
}

async function incrementOutreachCount(uid, date) {
  const dateStr = date || new Date().toISOString().slice(0, 10);
  const ref = getDb().collection('miia_outreach_capacity').doc(uid + '_' + dateStr);
  const doc = await ref.get();
  const current = doc.exists ? (doc.data().count || 0) : 0;
  await ref.set({ uid, date: dateStr, count: current + 1, limit: MAX_DAILY_OUTREACH, lastUpdated: new Date().toISOString() }, { merge: true });
  return { uid, date: dateStr, count: current + 1, limit: MAX_DAILY_OUTREACH };
}

async function processNextLead(uid) {
  const ok = await canDoOutreach(uid, null);
  if (!ok) return { uid, leadToContact: null, reason: 'daily_limit_reached' };
  const snap = await getDb().collection('miia_leads_queue').where('toUid', '==', uid).get();
  let nextLead = null;
  snap.forEach(doc => { const d = doc.data(); if (!nextLead && d.status === 'queued') nextLead = { id: doc.id, ...d }; });
  if (!nextLead) return { uid, leadToContact: null, reason: 'queue_empty' };
  await getDb().collection('miia_leads_queue').doc(nextLead.id).set({ status: 'outreach_pending', contactedAt: new Date().toISOString() }, { merge: true });
  return { uid, leadToContact: nextLead, reason: 'ok' };
}

async function markLeadConverted(leadId) {
  await getDb().collection('miia_leads_queue').doc(leadId).set({ status: 'converted', convertedAt: new Date().toISOString() }, { merge: true });
  return { leadId, status: 'converted' };
}

module.exports = { __setFirestoreForTests, LEAD_STATUS, INTEREST_SIGNALS, MAX_DAILY_OUTREACH, FIRESTORE_SCHEMA,
  detectInterestSignal, queueLead, getOutreachCapacity, canDoOutreach, incrementOutreachCount, processNextLead, markLeadConverted };