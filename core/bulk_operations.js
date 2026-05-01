"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

async function broadcastToAllOwners(message, opts) {
  if (!message) throw new Error("message required");
  const snap = await getDb().collection("owners").get();
  const results = [];
  snap.forEach(doc => {
    const d = doc.data();
    if (!d._deleted) results.push({ uid: doc.id, status: "queued" });
  });
  const batchId = "batch_" + Date.now();
  await getDb().collection("bulk_operations").doc(batchId).set({
    type: "broadcast", message, targetCount: results.length, status: "queued", createdAt: Date.now()
  });
  return { batchId, targetCount: results.length, status: "queued" };
}

async function changePlanBulk(ownerUids, newPlan) {
  if (!Array.isArray(ownerUids) || ownerUids.length === 0) throw new Error("ownerUids array required");
  const valid = ["free", "starter", "pro", "enterprise"];
  if (!valid.includes(newPlan)) throw new Error("invalid plan: " + newPlan);
  const results = [];
  for (const uid of ownerUids) {
    await getDb().collection("owners").doc(uid).update({ plan: newPlan, planChangedAt: Date.now() });
    results.push({ uid, plan: newPlan, status: "updated" });
  }
  return { updated: results.length, plan: newPlan, results };
}

module.exports = { broadcastToAllOwners, changePlanBulk, __setFirestoreForTests };
