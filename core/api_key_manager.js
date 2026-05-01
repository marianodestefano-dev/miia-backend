"use strict";
const crypto = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const KEY_PREFIX = "mk_";
const DEFAULT_RATE_LIMIT = 1000;

function generateApiKey() {
  return KEY_PREFIX + crypto.randomBytes(24).toString("hex");
}

async function createApiKey(uid, opts) {
  if (!uid) throw new Error("uid required");
  const key = generateApiKey();
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  const record = {
    id: hash.slice(0, 16),
    uid,
    keyHash: hash,
    keyPrefix: key.slice(0, 10),
    name: (opts && opts.name) || "API Key",
    rateLimit: (opts && opts.rateLimit) || DEFAULT_RATE_LIMIT,
    active: true,
    createdAt: Date.now(),
  };
  await getDb().collection("api_keys").doc(record.id).set(record);
  return { ...record, key };
}

async function revokeApiKey(keyId) {
  if (!keyId) throw new Error("keyId required");
  await getDb().collection("api_keys").doc(keyId).update({ active: false, revokedAt: Date.now() });
  return { keyId, active: false };
}

async function validateApiKey(rawKey) {
  if (!rawKey || !rawKey.startsWith(KEY_PREFIX)) return null;
  const hash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const snap = await getDb().collection("api_keys").where("keyHash", "==", hash).where("active", "==", true).get();
  if (snap.empty) return null;
  const doc = snap.docs[0].data();
  return { uid: doc.uid, keyId: doc.id, rateLimit: doc.rateLimit };
}

async function listApiKeys(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("api_keys").where("uid", "==", uid).where("active", "==", true).get();
  const keys = [];
  snap.forEach(doc => { const d = doc.data(); keys.push({ id: d.id, name: d.name, keyPrefix: d.keyPrefix, rateLimit: d.rateLimit, createdAt: d.createdAt }); });
  return keys;
}

module.exports = { createApiKey, revokeApiKey, validateApiKey, listApiKeys, generateApiKey, KEY_PREFIX, __setFirestoreForTests };
