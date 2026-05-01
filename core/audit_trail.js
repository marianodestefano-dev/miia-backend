"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const ACTION_TYPES = Object.freeze([
  "login", "logout", "message_sent", "booking_created", "lead_classified",
  "settings_changed", "api_key_created", "api_key_revoked", "export_data",
]);

async function logAction(uid, action, opts) {
  if (!uid || !action) throw new Error("uid and action required");
  if (!ACTION_TYPES.includes(action)) throw new Error("invalid action: " + action);
  const entry = {
    id: randomUUID(),
    uid,
    action,
    ip: (opts && opts.ip) || "unknown",
    userAgent: (opts && opts.userAgent) || null,
    metadata: (opts && opts.metadata) || {},
    timestamp: Date.now(),
  };
  await getDb().collection("audit_log").doc(entry.id).set(entry);
  return entry;
}

async function getAuditLog(uid, opts) {
  if (!uid) throw new Error("uid required");
  const limit = (opts && opts.limit) || 50;
  const snap = await getDb().collection("audit_log").where("uid", "==", uid).orderBy("timestamp").limit(limit).get();
  const entries = [];
  snap.forEach(doc => entries.push(doc.data()));
  return entries;
}

module.exports = { logAction, getAuditLog, ACTION_TYPES, __setFirestoreForTests };
