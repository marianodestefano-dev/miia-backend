'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const INVITE_STATUS = Object.freeze(['pending', 'accepted', 'expired', 'revoked']);
const INVITE_TTL_HOURS = 72;

function generateToken() { return randomUUID().replace(/-/g, ''); }

async function generateAgentInviteLink(uid, opts) {
  opts = opts || {};
  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600000).toISOString();
  const invite = { id: randomUUID(), uid, token, role: opts.role || 'agent', permissions: opts.permissions || ['view_conversations', 'reply'], status: 'pending', expiresAt, createdAt: new Date().toISOString() };
  await getDb().collection('agent_invites').doc(invite.id).set(invite);
  return { ...invite, inviteUrl: 'https://app.miia-app.com/join/' + token };
}

async function acceptAgentInvite(token, agentPhone) {
  const snap = await getDb().collection('agent_invites').where('token', '==', token).get();
  if (snap.empty) throw new Error('Invalid invite token');
  let invite = null;
  snap.forEach(doc => { invite = doc.data(); });
  if (invite.status !== 'pending') throw new Error('Invite is ' + invite.status);
  if (new Date(invite.expiresAt) < new Date()) throw new Error('Invite expired');
  await getDb().collection('agent_invites').doc(invite.id).set({ status: 'accepted', agentPhone, acceptedAt: new Date().toISOString() }, { merge: true });
  return { inviteId: invite.id, uid: invite.uid, agentPhone, permissions: invite.permissions, status: 'accepted' };
}

async function revokeAgentInvite(uid, inviteId) {
  const doc = await getDb().collection('agent_invites').doc(inviteId).get();
  if (!doc.exists) throw new Error('Invite not found: ' + inviteId);
  if (doc.data().uid !== uid) throw new Error('Unauthorized');
  await getDb().collection('agent_invites').doc(inviteId).set({ status: 'revoked', revokedAt: new Date().toISOString() }, { merge: true });
  return { inviteId, status: 'revoked' };
}

async function listAgents(uid) {
  const snap = await getDb().collection('agents').where('uid', '==', uid).get();
  const agents = [];
  snap.forEach(doc => agents.push(doc.data()));
  return agents;
}

async function removeAgent(uid, agentPhone) {
  await getDb().collection('agents').doc(uid + '_' + agentPhone).set({ status: 'inactive', removedAt: new Date().toISOString() }, { merge: true });
  return { uid, agentPhone, status: 'inactive' };
}

module.exports = { __setFirestoreForTests, INVITE_STATUS, INVITE_TTL_HOURS,
  generateAgentInviteLink, acceptAgentInvite, revokeAgentInvite, listAgents, removeAgent };