"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

async function exportOwnerData(uid) {
  if (!uid) throw new Error("uid required");
  const [ownerSnap, leadsSnap, convSnap, templatesSnap] = await Promise.all([
    getDb().collection("owners").doc(uid).get(),
    getDb().collection("leads").where("uid", "==", uid).get(),
    getDb().collection("conversations").doc(uid).get(),
    getDb().collection("templates").where("uid", "==", uid).get(),
  ]);
  const leads = [];
  leadsSnap.forEach(doc => leads.push(doc.data()));
  const templates = [];
  templatesSnap.forEach(doc => templates.push(doc.data()));
  return {
    exportedAt: new Date().toISOString(),
    uid,
    owner: ownerSnap.exists ? ownerSnap.data() : null,
    leads,
    conversations: convSnap.exists ? convSnap.data() : null,
    templates,
  };
}

async function deleteOwnerData(uid, reason) {
  if (!uid) throw new Error("uid required");
  const collections = ["leads", "conversations", "templates", "notifications", "commissions"];
  const deletionLog = { uid, reason: reason || "gdpr_request", deletedAt: Date.now(), collections };
  for (const coll of collections) {
    const snap = await getDb().collection(coll).where("uid", "==", uid).get();
    snap.forEach(doc => { doc.ref.update({ _deleted: true, _deletedAt: Date.now() }); });
  }
  await getDb().collection("owners").doc(uid).update({ _deleted: true, _deletedAt: Date.now(), _deleteReason: reason || "gdpr_request" });
  await getDb().collection("gdpr_log").doc(uid + "_" + Date.now()).set(deletionLog);
  return deletionLog;
}

async function logConsent(uid, consentType, value) {
  if (!uid || !consentType) throw new Error("uid and consentType required");
  const entry = { uid, consentType, value: !!value, recordedAt: Date.now() };
  await getDb().collection("consent_log").doc(uid + "_" + consentType).set(entry);
  return entry;
}

module.exports = { exportOwnerData, deleteOwnerData, logConsent, __setFirestoreForTests };
