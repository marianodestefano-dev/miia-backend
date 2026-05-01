"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const SUPER_ADMIN_ROLES = Object.freeze(["super_admin", "support", "billing"]);

async function getAllOwners(opts) {
  const limit = (opts && opts.limit) || 50;
  const snap = await getDb().collection("owners").limit(limit).get();
  const owners = [];
  snap.forEach(doc => { const d = doc.data(); if (!d._deleted) owners.push({ uid: doc.id, companyName: d.companyName, plan: d.plan, createdAt: d.createdAt }); });
  return owners;
}

async function getSystemStats() {
  const [ownersSnap, leadsSnap] = await Promise.all([
    getDb().collection("owners").get(),
    getDb().collection("leads").get(),
  ]);
  const totalOwners = ownersSnap.docs ? ownersSnap.docs.length : 0;
  const totalLeads = leadsSnap.docs ? leadsSnap.docs.length : 0;
  const mrrSnap = await getDb().collection("subscriptions").where("status", "==", "active").get();
  let totalMrr = 0;
  mrrSnap.forEach(doc => { totalMrr += doc.data().monthlyAmount || 0; });
  return { totalOwners, totalLeads, totalMrr: parseFloat(totalMrr.toFixed(2)), timestamp: Date.now() };
}

async function isSuperAdmin(uid) {
  if (!uid) return false;
  const snap = await getDb().collection("super_admins").doc(uid).get();
  return snap.exists && !!snap.data().active;
}

module.exports = { getAllOwners, getSystemStats, isSuperAdmin, SUPER_ADMIN_ROLES, __setFirestoreForTests };
