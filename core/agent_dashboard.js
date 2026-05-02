'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const AGENT_PERMISSIONS = Object.freeze(['view_conversations', 'reply', 'tag_leads', 'approve_actions', 'view_reports', 'manage_catalog']);
const AGENT_STATUS = Object.freeze(['active', 'inactive', 'suspended']);
const ACTION_DECISION = Object.freeze(['approved', 'rejected']);

async function createAgentProfile(uid, agentPhone, opts) {
  opts = opts || {};
  const perms = (opts.permissions || ['view_conversations', 'reply']).filter(p => AGENT_PERMISSIONS.includes(p));
  const agent = { id: randomUUID(), uid, agentPhone, name: opts.name || agentPhone, permissions: perms, status: 'active', createdAt: new Date().toISOString() };
  await getDb().collection('agents').doc(uid + '_' + agentPhone).set(agent, { merge: true });
  return agent;
}

async function getAgentPermissions(uid, agentPhone) {
  const doc = await getDb().collection('agents').doc(uid + '_' + agentPhone).get();
  if (!doc.exists) throw new Error('Agent not found: ' + agentPhone);
  return doc.data().permissions || [];
}

async function approveAction(uid, agentPhone, actionId, decision) {
  if (!ACTION_DECISION.includes(decision)) throw new Error('Invalid decision: ' + decision);
  const perms = await getAgentPermissions(uid, agentPhone);
  if (!perms.includes('approve_actions')) throw new Error('Agent lacks approve_actions permission');
  const result = { actionId, agentPhone, decision, decidedAt: new Date().toISOString() };
  await getDb().collection('agent_decisions').doc(actionId).set(result, { merge: true });
  return result;
}

async function getConversationSummary(uid, agentPhone, leadPhone) {
  const perms = await getAgentPermissions(uid, agentPhone);
  if (!perms.includes('view_conversations')) throw new Error('Agent lacks view_conversations permission');
  const snap = await getDb().collection('conversations').where('uid', '==', uid).where('phone', '==', leadPhone).get();
  const msgs = [];
  snap.forEach(doc => msgs.push(doc.data()));
  return { uid, agentPhone, leadPhone, messageCount: msgs.length, messages: msgs.slice(-10) };
}

async function updateAgentPermissions(uid, agentPhone, permissions) {
  const invalid = permissions.filter(p => !AGENT_PERMISSIONS.includes(p));
  if (invalid.length) throw new Error('Invalid permissions: ' + invalid.join(', '));
  await getDb().collection('agents').doc(uid + '_' + agentPhone).set({ permissions, updatedAt: new Date().toISOString() }, { merge: true });
  return { uid, agentPhone, permissions };
}

async function getAgentDashboardStats(uid, agentPhone) {
  const snap = await getDb().collection('agent_decisions').where('agentPhone', '==', agentPhone).get();
  let approved = 0, rejected = 0;
  snap.forEach(doc => { const d = doc.data(); if (d.decision === 'approved') approved++; else if (d.decision === 'rejected') rejected++; });
  return { uid, agentPhone, actionsApproved: approved, actionsRejected: rejected, totalDecisions: approved + rejected };
}

module.exports = { __setFirestoreForTests, AGENT_PERMISSIONS, AGENT_STATUS, ACTION_DECISION,
  createAgentProfile, getAgentPermissions, approveAction, getConversationSummary, updateAgentPermissions, getAgentDashboardStats };