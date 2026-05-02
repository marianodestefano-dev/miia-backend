'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const VOICE_CALL_STATUS = Object.freeze(['incoming', 'in_progress', 'completed', 'missed', 'outbound']);
const CALL_DIRECTION = Object.freeze(['inbound', 'outbound']);

async function receiveCall(uid, phone, callData) {
  const call = { id: randomUUID(), uid, phone, direction: 'inbound', status: 'incoming', durationSeconds: callData.durationSeconds || 0, rawTranscript: callData.rawTranscript || null, receivedAt: new Date().toISOString() };
  await getDb().collection('owners').doc(uid).collection('calls').doc(call.id).set(call);
  return call;
}

async function transcribeCall(uid, callId, transcript) {
  const ref = getDb().collection('owners').doc(uid).collection('calls').doc(callId);
  const summary = transcript.slice(0, 200);
  await ref.set({ transcript, summary, transcribedAt: new Date().toISOString() }, { merge: true });
  return { callId, summary, transcribed: true };
}

async function initiateOutboundCall(uid, phone, message) {
  const call = { id: randomUUID(), uid, phone, direction: 'outbound', status: 'outbound', message, initiatedAt: new Date().toISOString() };
  await getDb().collection('owners').doc(uid).collection('calls').doc(call.id).set(call);
  return call;
}

async function getCallHistory(uid, phone) {
  const snap = await getDb().collection('owners').doc(uid).collection('calls').where('phone', '==', phone).get();
  const calls = [];
  snap.forEach(doc => calls.push(doc.data()));
  return calls;
}

function detectUrgencyInTone(transcript) {
  const urgencyWords = ['urgente', 'emergencia', 'inmediato', 'ahora mismo', 'critico'];
  const lower = (transcript || '').toLowerCase();
  const detected = urgencyWords.filter(w => lower.includes(w));
  return { urgent: detected.length > 0, signals: detected };
}

module.exports = { __setFirestoreForTests, VOICE_CALL_STATUS, CALL_DIRECTION,
  receiveCall, transcribeCall, initiateOutboundCall, getCallHistory, detectUrgencyInTone };