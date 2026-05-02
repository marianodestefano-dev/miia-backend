"use strict";
const { randomUUID } = require("crypto");

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const ADDON_IDS = Object.freeze(["ludo_miia", "miia_dt"]);
const WEBHOOK_EVENTS = Object.freeze(["addon_activated", "addon_deactivated", "addon_expired"]);

async function registerWebhook(uid, addonId, webhookUrl, events) {
  if (!ADDON_IDS.includes(addonId)) throw new Error("Invalid addon: " + addonId);
  const invalidEvents = (events || []).filter(e => !WEBHOOK_EVENTS.includes(e));
  if (invalidEvents.length) throw new Error("Invalid events: " + invalidEvents.join(", "));
  const wh = { id: randomUUID(), uid, addonId, webhookUrl, events: events || WEBHOOK_EVENTS, active: true, createdAt: new Date().toISOString() };
  await getDb().collection("addon_webhooks").doc(uid + "_" + addonId).set(wh, { merge: true });
  return wh;
}

async function fireWebhook(uid, addonId, event, payload) {
  if (!WEBHOOK_EVENTS.includes(event)) throw new Error("Invalid event: " + event);
  const snap = await getDb().collection("addon_webhooks").doc(uid + "_" + addonId).get();
  if (!snap.exists || !snap.data().active) return { fired: false, reason: "no webhook registered" };
  const config = snap.data();
  if (!config.events.includes(event)) return { fired: false, reason: "event not subscribed" };
  const log = { id: randomUUID(), uid, addonId, event, payload: payload || {}, webhookUrl: config.webhookUrl, firedAt: new Date().toISOString() };
  await getDb().collection("webhook_logs").doc(log.id).set(log);
  return { fired: true, event, webhookUrl: config.webhookUrl };
}

async function activateAddon(uid, addonId) {
  if (!ADDON_IDS.includes(addonId)) throw new Error("Invalid addon: " + addonId);
  await getDb().collection("owner_addons").doc(uid + "_" + addonId).set({ uid, addonId, active: true, activatedAt: new Date().toISOString() }, { merge: true });
  await fireWebhook(uid, addonId, "addon_activated", { uid, addonId });
  return { uid, addonId, active: true };
}

async function deactivateAddon(uid, addonId) {
  if (!ADDON_IDS.includes(addonId)) throw new Error("Invalid addon: " + addonId);
  await getDb().collection("owner_addons").doc(uid + "_" + addonId).set({ active: false, deactivatedAt: new Date().toISOString() }, { merge: true });
  await fireWebhook(uid, addonId, "addon_deactivated", { uid, addonId });
  return { uid, addonId, active: false };
}

async function getWebhookConfigs(uid, addonId) {
  const snap = await getDb().collection("addon_webhooks").doc(uid + "_" + addonId).get();
  if (!snap.exists) return null;
  return snap.data();
}

module.exports = { __setFirestoreForTests, ADDON_IDS, WEBHOOK_EVENTS,
  registerWebhook, fireWebhook, activateAddon, deactivateAddon, getWebhookConfigs };
