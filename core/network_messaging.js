"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const RATE_LIMIT_PER_DAY = 5;

async function getOptInStatus(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("owners").doc(uid).get();
  if (!snap.exists) return { uid, optedIn: false };
  return { uid, optedIn: !!snap.data().networkOptIn };
}

async function setOptIn(uid, value) {
  if (!uid) throw new Error("uid required");
  await getDb().collection("owners").doc(uid).update({ networkOptIn: !!value });
  return { uid, optedIn: !!value };
}

async function checkRateLimit(fromUid, toUid) {
  const today = new Date().toISOString().split("T")[0];
  const key = fromUid + "_" + toUid + "_" + today;
  const snap = await getDb().collection("network_msg_log").doc(key).get();
  const count = snap.exists ? (snap.data().count || 0) : 0;
  return { allowed: count < RATE_LIMIT_PER_DAY, count, remaining: Math.max(0, RATE_LIMIT_PER_DAY - count) };
}

async function sendNetworkMessage(fromUid, toUid, message) {
  if (!fromUid || !toUid || !message) throw new Error("fromUid, toUid and message required");
  const toStatus = await getOptInStatus(toUid);
  if (!toStatus.optedIn) throw new Error("recipient not opted in to network messaging");
  const rateCheck = await checkRateLimit(fromUid, toUid);
  if (!rateCheck.allowed) throw new Error("rate limit exceeded: max " + RATE_LIMIT_PER_DAY + " messages/day");
  const today = new Date().toISOString().split("T")[0];
  const key = fromUid + "_" + toUid + "_" + today;
  await getDb().collection("network_msg_log").doc(key).set({ count: rateCheck.count + 1, date: today });
  const msg = { id: randomUUID(), fromUid, toUid, message, sentAt: Date.now() };
  await getDb().collection("network_messages").doc(msg.id).set(msg);
  return msg;
}

module.exports = { getOptInStatus, setOptIn, checkRateLimit, sendNetworkMessage, RATE_LIMIT_PER_DAY, __setFirestoreForTests };
