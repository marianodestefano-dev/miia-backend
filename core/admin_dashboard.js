'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const ADMIN_ACTIONS = Object.freeze(['suspend_tenant', 'activate_tenant', 'reset_quota', 'force_logout', 'view_audit']);
const AUDIT_SEVERITY = Object.freeze(['info', 'warning', 'critical']);

async function getAllTenants(filters) {
  filters = filters || {};
  const snap = await getDb().collection('owners').get();
  const tenants = [];
  snap.forEach(doc => {
    const d = doc.data();
    if (filters.status && d.status !== filters.status) return;
    tenants.push({ uid: doc.id, businessName: d.business_name || d.businessName || 'Sin nombre', phone: d.phone || null, status: d.status || 'active', createdAt: d.createdAt || null });
  });
  return tenants;
}

async function suspendTenant(adminId, uid, reason) {
  await getDb().collection('owners').doc(uid).set({ suspended: true, suspendReason: reason || 'admin_action', suspendedAt: new Date().toISOString() }, { merge: true });
  await logAdminAction(adminId, 'suspend_tenant', uid, { reason });
  return { uid, suspended: true, reason };
}

async function activateTenant(adminId, uid) {
  await getDb().collection('owners').doc(uid).set({ suspended: false, activatedAt: new Date().toISOString() }, { merge: true });
  await logAdminAction(adminId, 'activate_tenant', uid, {});
  return { uid, suspended: false };
}

async function logAdminAction(adminId, action, targetUid, details) {
  if (!ADMIN_ACTIONS.includes(action)) throw new Error('Invalid admin action: ' + action);
  const severity = action === 'suspend_tenant' || action === 'force_logout' ? 'critical' : action === 'reset_quota' ? 'warning' : 'info';
  const entry = { id: randomUUID(), adminId, action, targetUid, details: details || {}, severity, loggedAt: new Date().toISOString() };
  await getDb().collection('admin_audit').doc(entry.id).set(entry);
  return entry;
}

async function getAuditLogs(filters) {
  filters = filters || {};
  const snap = await getDb().collection('admin_audit').get();
  const logs = [];
  snap.forEach(doc => {
    const d = doc.data();
    if (filters.targetUid && d.targetUid !== filters.targetUid) return;
    if (filters.action && d.action !== filters.action) return;
    if (filters.severity && d.severity !== filters.severity) return;
    logs.push(d);
  });
  return logs.sort((a, b) => b.loggedAt.localeCompare(a.loggedAt));
}

async function getTenantStats(uid) {
  const doc = await getDb().collection('owners').doc(uid).get();
  const data = doc.exists ? doc.data() : {};
  return { uid, businessName: data.business_name || data.businessName || 'Sin nombre', messagesTODAY: data.messages_today || 0, activeLeads: data.active_leads || 0, suspended: data.suspended || false, status: data.suspended ? 'suspended' : 'active' };
}

async function getGlobalStats() {
  const snap = await getDb().collection('owners').get();
  let total = 0, active = 0, suspended = 0;
  snap.forEach(doc => { total++; const d = doc.data(); if (d.suspended) suspended++; else active++; });
  return { totalTenants: total, activeTenants: active, suspendedTenants: suspended, recordedAt: new Date().toISOString() };
}

module.exports = { __setFirestoreForTests, ADMIN_ACTIONS, AUDIT_SEVERITY,
  getAllTenants, suspendTenant, activateTenant, logAdminAction, getAuditLogs, getTenantStats, getGlobalStats };