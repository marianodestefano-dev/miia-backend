"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const SMARTHOME_PROVIDERS = Object.freeze(["alexa", "google_home", "apple_homekit"]);

async function registerSmartHomeWebhook(uid, opts) {
  const { provider, webhookUrl, deviceTypes } = opts || {};
  if (!uid || !provider || !webhookUrl) throw new Error("uid, provider, webhookUrl required");
  if (!SMARTHOME_PROVIDERS.includes(provider)) throw new Error("invalid provider: " + provider);
  const config = {
    id: randomUUID(), uid, provider, webhookUrl,
    deviceTypes: deviceTypes || ["light", "thermostat", "lock"],
    active: true, registeredAt: Date.now(),
  };
  await getDb().collection("smarthome_integrations").doc(uid + "_" + provider).set(config);
  return config;
}

async function processSmartHomeCommand(uid, command, payload) {
  if (!uid || !command) throw new Error("uid and command required");
  const log = { id: randomUUID(), uid, command, payload: payload || {}, processedAt: Date.now() };
  await getDb().collection("smarthome_commands").doc(log.id).set(log);
  return { processed: true, command, log };
}

module.exports = { registerSmartHomeWebhook, processSmartHomeCommand, SMARTHOME_PROVIDERS, __setFirestoreForTests };
