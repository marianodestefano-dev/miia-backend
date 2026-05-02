'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const COACHING_INSIGHT_TYPES = Object.freeze(['response_speed', 'conversion_rate', 'message_length', 'follow_up_timing', 'objection_handling']);
const SUCCESS_SIGNALS = Object.freeze(['me interesa', 'cuando podemos', 'cuanto cuesta', 'reservar', 'pagar', 'confirmo', 'de acuerdo', 'perfecto']);

function analyzeConversation(messages) {
  if (!messages || messages.length === 0) return { score: 0, insights: [], flags: [] };
  const flags = [];
  const insights = [];
  const avgLen = messages.reduce((s, m) => s + (m.text || '').length, 0) / messages.length;
  if (avgLen < 20) flags.push('RESPONSES_TOO_SHORT');
  const hasSuccess = messages.some(m => SUCCESS_SIGNALS.some(s => (m.text || '').toLowerCase().includes(s)));
  if (hasSuccess) insights.push({ type: 'conversion_rate', note: 'success_signal_detected' });
  const score = Math.min(100, 50 + (hasSuccess ? 30 : 0) + (avgLen > 50 ? 20 : 0));
  return { score, insights, flags };
}

async function detectSuccessPatterns(uid, opts) {
  const snap = await getDb().collection('owners').doc(uid).collection('coaching_snapshots').get();
  const patterns = [];
  snap.forEach(doc => { const d = doc.data(); if (d.hasConversion) patterns.push({ phone: d.phone, signals: d.signals || [] }); });
  return { uid, patterns, totalAnalyzed: patterns.length };
}

async function saveCoachingSnapshot(uid, phone, analysis) {
  const snap = { id: randomUUID(), uid, phone, score: analysis.score, flags: analysis.flags, insights: analysis.insights, hasConversion: analysis.score >= 70, signals: analysis.insights.map(i => i.type), recordedAt: new Date().toISOString() };
  await getDb().collection('owners').doc(uid).collection('coaching_snapshots').doc(snap.id).set(snap);
  return snap;
}

function buildSalesScript(uid, opts) {
  const { productName, targetSegment } = opts;
  const opening = 'Hola! Te escribo de ' + productName + '.';
  const body = targetSegment === 'cold' ? 'Queria contarte como ayudamos a negocios como el tuyo.' : 'Seguimos en contacto para ver como podemos ayudarte mejor.';
  const closing = 'Cuando seria un buen momento para charlar?';
  return { uid, productName, targetSegment, script: opening + ' ' + body + ' ' + closing };
}

async function getCoachingReport(uid) {
  const snap = await getDb().collection('owners').doc(uid).collection('coaching_snapshots').get();
  let total = 0, scoreSum = 0;
  const flagCounts = {};
  snap.forEach(doc => { const d = doc.data(); total++; scoreSum += d.score || 0; (d.flags || []).forEach(f => { flagCounts[f] = (flagCounts[f] || 0) + 1; }); });
  return { uid, totalConversations: total, avgScore: total > 0 ? Math.round(scoreSum / total) : 0, topFlags: Object.entries(flagCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, c]) => ({ flag: f, count: c })) };
}

module.exports = { __setFirestoreForTests, COACHING_INSIGHT_TYPES, SUCCESS_SIGNALS,
  analyzeConversation, detectSuccessPatterns, saveCoachingSnapshot, buildSalesScript, getCoachingReport };