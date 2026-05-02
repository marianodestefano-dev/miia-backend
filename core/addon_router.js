"use strict";
const { randomUUID } = require("crypto");

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const ADDON_IDS = Object.freeze(["ludo_miia", "miia_dt"]);
const INTENT_PATTERNS = Object.freeze({
  ludo_miia: ["juego", "jugar", "ruleta", "puntos", "sorteo", "premio", "concurso", "fidelidad"],
  miia_dt: ["aviso automatico", "notificacion automatica", "recordatorio masivo", "broadcast", "envio masivo"],
});

function detectAddonIntent(message) {
  const lower = (message || "").toLowerCase();
  for (const [addonId, patterns] of Object.entries(INTENT_PATTERNS)) {
    const matched = patterns.filter(p => lower.includes(p));
    if (matched.length > 0) return { detected: true, addonId, matchedPatterns: matched, confidence: Math.min(matched.length / 2, 1) };
  }
  return { detected: false, addonId: null, matchedPatterns: [], confidence: 0 };
}

async function routeToAddon(uid, addonId, message, context) {
  if (!ADDON_IDS.includes(addonId)) throw new Error("Invalid addon: " + addonId);
  const addonSnap = await getDb().collection("owner_addons").doc(uid + "_" + addonId).get();
  if (!addonSnap.exists || !addonSnap.data().active) throw new Error("Addon not active: " + addonId);
  const record = { id: randomUUID(), uid, addonId, message, context: context || {}, routedAt: new Date().toISOString() };
  await getDb().collection("addon_routing").doc(record.id).set(record);
  return record;
}

async function getRoutingHistory(uid, addonId) {
  const snap = await getDb().collection("addon_routing").where("uid", "==", uid).get();
  const records = [];
  snap.forEach(doc => { const d = doc.data(); if (!addonId || d.addonId === addonId) records.push(d); });
  return records;
}

module.exports = { __setFirestoreForTests, ADDON_IDS, INTENT_PATTERNS,
  detectAddonIntent, routeToAddon, getRoutingHistory };
