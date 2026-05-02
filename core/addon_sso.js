"use strict";
const { randomUUID } = require("crypto");

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const ADDON_IDS = Object.freeze(["ludo_miia", "miia_dt"]);
const SSO_TTL_SECONDS = 60;

function generateTokenString() { return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""); }

async function generateSSOToken(uid, addonId) {
  if (!ADDON_IDS.includes(addonId)) throw new Error("Invalid addon: " + addonId);
  const addonDoc = await getDb().collection("owner_addons").doc(uid + "_" + addonId).get();
  if (!addonDoc.exists || !addonDoc.data().active) throw new Error("Addon not active: " + addonId);
  const token = generateTokenString();
  const expiresAt = new Date(Date.now() + SSO_TTL_SECONDS * 1000).toISOString();
  const record = { id: randomUUID(), uid, addonId, token, expiresAt, used: false, createdAt: new Date().toISOString() };
  await getDb().collection("sso_tokens").doc(record.id).set(record);
  return { token, addonId, expiresAt, ttlSeconds: SSO_TTL_SECONDS };
}

async function validateSSOToken(token, addonId) {
  const snap = await getDb().collection("sso_tokens").where("token", "==", token).get();
  if (snap.empty) throw new Error("Invalid SSO token");
  let record = null;
  snap.forEach(doc => { record = doc.data(); });
  if (record.addonId !== addonId) throw new Error("Token addon mismatch");
  if (record.used) throw new Error("SSO token already used");
  if (new Date(record.expiresAt) < new Date()) throw new Error("SSO token expired");
  await getDb().collection("sso_tokens").doc(record.id).set({ used: true, usedAt: new Date().toISOString() }, { merge: true });
  return { uid: record.uid, addonId, valid: true };
}

async function revokeSSOToken(token) {
  const snap = await getDb().collection("sso_tokens").where("token", "==", token).get();
  if (snap.empty) throw new Error("Token not found");
  let id = null;
  snap.forEach(doc => { id = doc.id; });
  await getDb().collection("sso_tokens").doc(id).set({ used: true, revokedAt: new Date().toISOString() }, { merge: true });
  return { revoked: true };
}

module.exports = { __setFirestoreForTests, ADDON_IDS, SSO_TTL_SECONDS,
  generateSSOToken, validateSSOToken, revokeSSOToken };
