"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const SUPPORTED_CHANNELS = Object.freeze(["whatsapp", "telegram", "web_widget", "email"]);

async function registerChannel(uid, channel, opts) {
  if (!uid || !channel) throw new Error("uid and channel required");
  if (!SUPPORTED_CHANNELS.includes(channel)) throw new Error("invalid channel: " + channel);
  const config = {
    id: uid + "_" + channel, uid, channel,
    active: true,
    config: opts || {},
    registeredAt: Date.now(),
  };
  await getDb().collection("channel_configs").doc(config.id).set(config);
  return config;
}

async function getActiveChannels(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("channel_configs").where("uid", "==", uid).get();
  const channels = [];
  snap.forEach(doc => { const d = doc.data(); if (d.active) channels.push(d); });
  return channels;
}

async function routeMessage(uid, message, sourceChannel) {
  if (!uid || !message || !sourceChannel) throw new Error("uid, message, sourceChannel required");
  if (!SUPPORTED_CHANNELS.includes(sourceChannel)) throw new Error("invalid sourceChannel: " + sourceChannel);
  const record = {
    id: randomUUID(), uid,
    sourceChannel, message,
    routedAt: Date.now(),
    status: "routed",
  };
  await getDb().collection("channel_messages").doc(record.id).set(record);
  return record;
}

async function disableChannel(uid, channel) {
  if (!uid || !channel) throw new Error("uid and channel required");
  await getDb().collection("channel_configs").doc(uid + "_" + channel).update({ active: false });
  return { uid, channel, active: false };
}

module.exports = { registerChannel, getActiveChannels, routeMessage, disableChannel, SUPPORTED_CHANNELS, __setFirestoreForTests };
