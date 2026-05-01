"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

async function getActivationTime(uid) {
  if (!uid) throw new Error("uid required");
  const ownerSnap = await getDb().collection("owners").doc(uid).get();
  if (!ownerSnap.exists) return null;
  const owner = ownerSnap.data();
  const leadsSnap = await getDb().collection("leads").where("uid", "==", uid).orderBy("createdAt").limit(1).get();
  if (leadsSnap.empty) return { uid, firstLeadAt: null, activationMs: null };
  const firstLead = leadsSnap.docs[0].data();
  const activationMs = firstLead.createdAt - (owner.createdAt || firstLead.createdAt);
  return { uid, firstLeadAt: firstLead.createdAt, activationMs };
}

async function getRetention30d(uid) {
  if (!uid) throw new Error("uid required");
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const all = await getDb().collection("leads").where("uid", "==", uid).get();
  const returning = await getDb().collection("leads").where("uid", "==", uid).where("lastMessageAt", ">=", since).get();
  const total = all.docs ? all.docs.length : 0;
  const ret = returning.docs ? returning.docs.length : 0;
  return { uid, total, returning: ret, rate: total > 0 ? parseFloat((ret / total * 100).toFixed(1)) : 0 };
}

async function getGrowthSummary(uid) {
  if (!uid) throw new Error("uid required");
  const [activation, retention] = await Promise.all([getActivationTime(uid), getRetention30d(uid)]);
  return { uid, activation, retention };
}

module.exports = { getActivationTime, getRetention30d, getGrowthSummary, __setFirestoreForTests };
