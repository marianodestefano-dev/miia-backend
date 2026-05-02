'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const ENTERPRISE_STATUS = Object.freeze(['trial', 'active', 'suspended', 'cancelled']);
const BILLING_CYCLES = Object.freeze(['monthly', 'annual']);
const MAX_SEATS_DEFAULT = 5;

async function createEnterprise(adminUid, opts) {
  opts = opts || {};
  if (!opts.name) throw new Error('Enterprise name required');
  const cycle = opts.billingCycle || 'monthly';
  if (!BILLING_CYCLES.includes(cycle)) throw new Error('Invalid billing cycle: ' + cycle);
  const enterprise = { id: randomUUID(), adminUid, name: opts.name, seats: opts.seats || MAX_SEATS_DEFAULT, billingCycle: cycle, status: 'trial', ownerUids: [adminUid], createdAt: new Date().toISOString() };
  await getDb().collection('enterprises').doc(enterprise.id).set(enterprise);
  return enterprise;
}

async function addEnterpriseOwner(enterpriseId, ownerUid) {
  const doc = await getDb().collection('enterprises').doc(enterpriseId).get();
  if (!doc.exists) throw new Error('Enterprise not found: ' + enterpriseId);
  const data = doc.data();
  if (data.ownerUids.length >= data.seats) throw new Error('Enterprise seats full (' + data.seats + ')');
  const updated = [...data.ownerUids.filter(u => u !== ownerUid), ownerUid];
  await getDb().collection('enterprises').doc(enterpriseId).set({ ownerUids: updated, updatedAt: new Date().toISOString() }, { merge: true });
  return { enterpriseId, ownerUid, totalOwners: updated.length };
}

async function getEnterpriseMetrics(enterpriseId) {
  const doc = await getDb().collection('enterprises').doc(enterpriseId).get();
  if (!doc.exists) throw new Error('Enterprise not found: ' + enterpriseId);
  const data = doc.data();
  const snap = await getDb().collection('enterprise_metrics').where('enterpriseId', '==', enterpriseId).get();
  let totalMessages = 0, totalLeads = 0, totalConversions = 0;
  snap.forEach(doc => { const d = doc.data(); totalMessages += d.messages || 0; totalLeads += d.leads || 0; totalConversions += d.conversions || 0; });
  return { enterpriseId, name: data.name, seats: data.seats, activeOwners: data.ownerUids.length, totalMessages, totalLeads, totalConversions, status: data.status };
}

async function updateBilling(enterpriseId, opts) {
  if (opts.billingCycle && !BILLING_CYCLES.includes(opts.billingCycle)) throw new Error('Invalid billing cycle');
  const update = { updatedAt: new Date().toISOString() };
  if (opts.billingCycle) update.billingCycle = opts.billingCycle;
  if (opts.seats) update.seats = opts.seats;
  await getDb().collection('enterprises').doc(enterpriseId).set(update, { merge: true });
  return { enterpriseId, ...update };
}

async function suspendEnterprise(enterpriseId, reason) {
  await getDb().collection('enterprises').doc(enterpriseId).set({ status: 'suspended', suspendedAt: new Date().toISOString(), suspendReason: reason || 'admin_action' }, { merge: true });
  return { enterpriseId, status: 'suspended', reason };
}

async function getEnterpriseSummary(enterpriseId) {
  const doc = await getDb().collection('enterprises').doc(enterpriseId).get();
  if (!doc.exists) throw new Error('Enterprise not found: ' + enterpriseId);
  const d = doc.data();
  return { id: enterpriseId, name: d.name, seats: d.seats, activeOwners: (d.ownerUids || []).length, billingCycle: d.billingCycle, status: d.status };
}

module.exports = { __setFirestoreForTests, ENTERPRISE_STATUS, BILLING_CYCLES, MAX_SEATS_DEFAULT,
  createEnterprise, addEnterpriseOwner, getEnterpriseMetrics, updateBilling, suspendEnterprise, getEnterpriseSummary };