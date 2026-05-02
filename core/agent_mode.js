'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const AGENT_DECISIONS = Object.freeze(['respond', 'escalate', 'wait', 'request_permission']);
const AUTONOMY_LEVELS = Object.freeze(['none', 'low', 'medium', 'high', 'full']);
const AUTONOMY_THRESHOLDS = Object.freeze({ none: 0, low: 0.3, medium: 0.5, high: 0.7, full: 1.0 });

async function getAgentConfig(uid) {
  const doc = await getDb().collection('owners').doc(uid).get();
  const data = doc.exists ? doc.data() : {};
  return { autonomyLevel: data.agent_autonomy_level || 'low', enabled: data.agent_enabled || false, maxActionsPerHour: data.agent_max_actions_per_hour || 10 };
}

async function setAutonomyLevel(uid, level) {
  if (!AUTONOMY_LEVELS.includes(level)) throw new Error('Invalid autonomy level: ' + level);
  await getDb().collection('owners').doc(uid).set({ agent_autonomy_level: level, agent_enabled: level !== 'none' }, { merge: true });
  return { uid, level };
}

async function decideAction(uid, message, context) {
  const config = await getAgentConfig(uid);
  if (!config.enabled) return { decision: 'escalate', reason: 'agent_disabled' };
  const hasUrgency = /urgente|emergencia|ahora mismo|inmediato/i.test(message);
  if (hasUrgency && config.autonomyLevel !== 'full') return { decision: 'escalate', reason: 'urgency_detected' };
  const threshold = AUTONOMY_THRESHOLDS[config.autonomyLevel] || 0;
  const confidence = context && context.confidence !== undefined ? context.confidence : 0.5;
  if (confidence < threshold) return { decision: 'request_permission', reason: 'below_threshold' };
  return { decision: 'respond', reason: 'within_autonomy' };
}

async function logAgentDecision(uid, decisionData) {
  if (!AGENT_DECISIONS.includes(decisionData.decision)) throw new Error('Invalid decision: ' + decisionData.decision);
  const entry = { id: randomUUID(), uid, ...decisionData, timestamp: new Date().toISOString() };
  await getDb().collection('owners').doc(uid).collection('agent_log').doc(entry.id).set(entry);
  return entry;
}

async function detectNewLead(uid, phone, message) {
  const doc = await getDb().collection('owners').doc(uid).collection('contacts').doc(phone).get();
  const isNew = !doc.exists;
  return { isNew, score: isNew ? 50 : 30, phone };
}

async function checkPermissionRequired(uid, action) {
  const config = await getAgentConfig(uid);
  const highRiskActions = ['send_payment_link', 'cancel_booking', 'delete_contact'];
  if (highRiskActions.includes(action)) return config.autonomyLevel !== 'full';
  return config.autonomyLevel === 'none';
}

module.exports = { __setFirestoreForTests, AGENT_DECISIONS, AUTONOMY_LEVELS, AUTONOMY_THRESHOLDS,
  getAgentConfig, setAutonomyLevel, decideAction, logAgentDecision, detectNewLead, checkPermissionRequired };