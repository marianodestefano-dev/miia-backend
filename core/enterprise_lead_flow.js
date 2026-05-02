'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const FLOW_STAGES = Object.freeze(['captured', 'qualified', 'assigned', 'contacted', 'converted', 'lost']);
const QUALIFY_THRESHOLD = 60;

async function captureEnterpriseLead(enterpriseId, leadData) {
  const lead = { id: randomUUID(), enterpriseId, phone: leadData.phone, name: leadData.name || null, source: leadData.source || 'organic', stage: 'captured', score: 0, assignedTo: null, capturedAt: new Date().toISOString() };
  await getDb().collection('enterprise_leads').doc(lead.id).set(lead);
  return lead;
}

async function qualifyLead(enterpriseId, leadId, score) {
  if (typeof score !== 'number' || score < 0 || score > 100) throw new Error('Score must be 0-100');
  const stage = score >= QUALIFY_THRESHOLD ? 'qualified' : 'captured';
  await getDb().collection('enterprise_leads').doc(leadId).set({ score, stage, qualifiedAt: stage === 'qualified' ? new Date().toISOString() : null }, { merge: true });
  return { leadId, score, stage, qualified: stage === 'qualified' };
}

async function assignLeadToOwner(enterpriseId, leadId, ownerUid) {
  const doc = await getDb().collection('enterprise_leads').doc(leadId).get();
  if (!doc.exists) throw new Error('Lead not found: ' + leadId);
  await getDb().collection('enterprise_leads').doc(leadId).set({ assignedTo: ownerUid, stage: 'assigned', assignedAt: new Date().toISOString() }, { merge: true });
  return { leadId, assignedTo: ownerUid, stage: 'assigned' };
}

async function updateLeadStage(enterpriseId, leadId, stage) {
  if (!FLOW_STAGES.includes(stage)) throw new Error('Invalid stage: ' + stage);
  await getDb().collection('enterprise_leads').doc(leadId).set({ stage, stageUpdatedAt: new Date().toISOString() }, { merge: true });
  return { leadId, stage };
}

async function getEnterpriseLeadFunnel(enterpriseId) {
  const snap = await getDb().collection('enterprise_leads').where('enterpriseId', '==', enterpriseId).get();
  const funnel = {};
  FLOW_STAGES.forEach(s => { funnel[s] = 0; });
  snap.forEach(doc => { const d = doc.data(); if (funnel[d.stage] !== undefined) funnel[d.stage]++; });
  return { enterpriseId, funnel, total: snap.size };
}

async function getAssignedLeads(enterpriseId, ownerUid) {
  const snap = await getDb().collection('enterprise_leads').where('enterpriseId', '==', enterpriseId).get();
  const leads = [];
  snap.forEach(doc => { const d = doc.data(); if (d.assignedTo === ownerUid) leads.push(d); });
  return leads;
}

module.exports = { __setFirestoreForTests, FLOW_STAGES, QUALIFY_THRESHOLD,
  captureEnterpriseLead, qualifyLead, assignLeadToOwner, updateLeadStage, getEnterpriseLeadFunnel, getAssignedLeads };