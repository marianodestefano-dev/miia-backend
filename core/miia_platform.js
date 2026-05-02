'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const PLUGIN_STATUS = Object.freeze(['pending_review', 'approved', 'rejected', 'suspended']);
const REVENUE_SHARE_PERCENT = 30;

async function registerPlugin(uid, opts) {
  const { name, description, apiEndpoint, webhookUrl } = opts;
  const plugin = { id: randomUUID(), uid, name, description, apiEndpoint, webhookUrl: webhookUrl || null, status: 'pending_review', totalRevenue: 0, createdAt: new Date().toISOString() };
  await getDb().collection('plugins').doc(plugin.id).set(plugin);
  return plugin;
}

async function approvePlugin(pluginId) {
  const ref = getDb().collection('plugins').doc(pluginId);
  await ref.set({ status: 'approved', approvedAt: new Date().toISOString() }, { merge: true });
  return { pluginId, status: 'approved' };
}

async function listPlugins(opts) {
  opts = opts || {};
  const snap = await getDb().collection('plugins').where('status', '==', opts.status || 'approved').get();
  const plugins = [];
  snap.forEach(doc => plugins.push({ id: doc.id, ...doc.data() }));
  return plugins;
}

async function recordPluginRevenue(pluginId, amount, currency) {
  const entry = { id: randomUUID(), pluginId, amount, currency, developerShare: Math.round(amount * (1 - REVENUE_SHARE_PERCENT / 100)), miiaShare: Math.round(amount * REVENUE_SHARE_PERCENT / 100), recordedAt: new Date().toISOString() };
  await getDb().collection('plugin_revenue').doc(entry.id).set(entry);
  return entry;
}

async function getRevenueSummary(uid) {
  const snap = await getDb().collection('plugin_revenue').where('uid', '==', uid).get();
  let total = 0, miiaTotal = 0;
  snap.forEach(doc => { const d = doc.data(); total += d.amount || 0; miiaTotal += d.miiaShare || 0; });
  return { uid, totalRevenue: total, miiaShare: miiaTotal, developerShare: total - miiaTotal };
}

module.exports = { __setFirestoreForTests, PLUGIN_STATUS, REVENUE_SHARE_PERCENT,
  registerPlugin, approvePlugin, listPlugins, recordPluginRevenue, getRevenueSummary };