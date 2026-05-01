"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

async function createExperiment(opts) {
  const { name, feature, variants, rolloutPct } = opts || {};
  if (!name || !feature) throw new Error("name and feature required");
  const pct = rolloutPct !== undefined ? rolloutPct : 50;
  if (pct < 0 || pct > 100) throw new Error("rolloutPct must be 0-100");
  const exp = { id: randomUUID(), name, feature, variants: variants || ["control", "treatment"], rolloutPct: pct, active: true, createdAt: Date.now() };
  await getDb().collection("experiments").doc(exp.id).set(exp);
  return exp;
}

function assignVariant(uid, rolloutPct, variants) {
  const hash = uid.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const bucket = hash % 100;
  if (bucket >= rolloutPct) return null;
  return variants[hash % variants.length];
}

async function getVariantForUser(uid, experimentId) {
  if (!uid || !experimentId) throw new Error("uid and experimentId required");
  const snap = await getDb().collection("experiments").doc(experimentId).get();
  if (!snap.exists) return { uid, experimentId, variant: null, active: false };
  const exp = snap.data();
  if (!exp.active) return { uid, experimentId, variant: null, active: false };
  const variant = assignVariant(uid, exp.rolloutPct, exp.variants);
  return { uid, experimentId, variant, active: true };
}

async function listExperiments(activeOnly) {
  let q = getDb().collection("experiments");
  if (activeOnly) q = q.where("active", "==", true);
  const snap = await q.get();
  const items = [];
  snap.forEach(doc => items.push(doc.data()));
  return items;
}

module.exports = { createExperiment, getVariantForUser, listExperiments, assignVariant, __setFirestoreForTests };
