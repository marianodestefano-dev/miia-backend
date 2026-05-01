"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

async function setFlag(flagName, value, opts) {
  if (!flagName) throw new Error("flagName required");
  const record = {
    name: flagName,
    value: !!value,
    scope: (opts && opts.scope) || "global",
    ownerUid: (opts && opts.ownerUid) || null,
    updatedAt: Date.now(),
  };
  const key = record.ownerUid ? flagName + "_" + record.ownerUid : flagName;
  await getDb().collection("feature_flags").doc(key).set(record);
  return record;
}

async function getFlag(flagName, ownerUid) {
  if (!flagName) throw new Error("flagName required");
  if (ownerUid) {
    const ownerSnap = await getDb().collection("feature_flags").doc(flagName + "_" + ownerUid).get();
    if (ownerSnap.exists) return ownerSnap.data().value;
  }
  const globalSnap = await getDb().collection("feature_flags").doc(flagName).get();
  return globalSnap.exists ? globalSnap.data().value : false;
}

async function listFlags(ownerUid) {
  const snap = await getDb().collection("feature_flags").get();
  const flags = {};
  snap.forEach(doc => { const d = doc.data(); if (!d.ownerUid || d.ownerUid === ownerUid) flags[d.name] = d.value; });
  return flags;
}

module.exports = { setFlag, getFlag, listFlags, __setFirestoreForTests };
