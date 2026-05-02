'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const WA_FLOW_TYPES = Object.freeze(['onboarding', 'survey', 'booking', 'payment', 'custom']);
const FLOW_STATUS = Object.freeze(['draft', 'active', 'paused', 'archived']);

async function createFlow(uid, opts) {
  const { type, title, fields } = opts;
  if (!WA_FLOW_TYPES.includes(type)) throw new Error('Invalid flow type: ' + type);
  const flow = { id: randomUUID(), uid, type, title, fields: fields || [], status: 'draft', responseCount: 0, createdAt: new Date().toISOString() };
  await getDb().collection('wa_flows').doc(flow.id).set(flow);
  return flow;
}

async function activateFlow(uid, flowId) {
  const ref = getDb().collection('wa_flows').doc(flowId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Flow not found: ' + flowId);
  if (doc.data().uid !== uid) throw new Error('Unauthorized');
  await ref.set({ status: 'active' }, { merge: true });
  return { flowId, status: 'active' };
}

async function launchFlowForLead(uid, phone, flowId) {
  const doc = await getDb().collection('wa_flows').doc(flowId).get();
  if (!doc.exists) throw new Error('Flow not found: ' + flowId);
  const launch = { id: randomUUID(), uid, phone, flowId, status: 'sent', launchedAt: new Date().toISOString() };
  await getDb().collection('flow_launches').doc(launch.id).set(launch);
  return launch;
}

async function processSurveyResponse(flowId, phone, responses) {
  const entry = { id: randomUUID(), flowId, phone, responses, submittedAt: new Date().toISOString() };
  await getDb().collection('flow_responses').doc(entry.id).set(entry);
  return entry;
}

async function getFlowStats(uid, flowId) {
  const doc = await getDb().collection('wa_flows').doc(flowId).get();
  if (!doc.exists) throw new Error('Flow not found: ' + flowId);
  const data = doc.data();
  const launchSnap = await getDb().collection('flow_launches').where('flowId', '==', flowId).get();
  const responseSnap = await getDb().collection('flow_responses').where('flowId', '==', flowId).get();
  const totalLaunches = launchSnap.size || 0;
  const totalResponses = responseSnap.size || 0;
  return { flowId, type: data.type, status: data.status, totalLaunches, totalResponses, responseRate: totalLaunches > 0 ? totalResponses / totalLaunches : 0 };
}

module.exports = { __setFirestoreForTests, WA_FLOW_TYPES, FLOW_STATUS,
  createFlow, activateFlow, launchFlowForLead, processSurveyResponse, getFlowStats };