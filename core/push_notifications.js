"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const NOTIFICATION_TYPES = Object.freeze({
  LEAD_NUEVO: "lead_nuevo",
  MENSAJE_URGENTE: "mensaje_urgente",
  PAGO_RECIBIDO: "pago_recibido",
  BOOKING_NEW: "booking_new",
});

async function sendNotification(uid, type, payload) {
  if (!uid || !type) throw new Error("uid and type required");
  if (!Object.values(NOTIFICATION_TYPES).includes(type)) throw new Error("invalid notification type: " + type);
  const notif = { id: randomUUID(), uid, type, payload: payload || {}, status: "queued", createdAt: Date.now() };
  await getDb().collection("notifications").doc(notif.id).set(notif);
  console.log("[PUSH]", type, "uid:", uid);
  return notif;
}

async function getNotificationHistory(uid, limit) {
  if (!uid) throw new Error("uid required");
  const n = limit || 20;
  const snap = await getDb().collection("notifications").where("uid", "==", uid).orderBy("createdAt").limit(n).get();
  const items = [];
  snap.forEach(doc => items.push(doc.data()));
  return items;
}

async function markRead(notifId) {
  if (!notifId) throw new Error("notifId required");
  await getDb().collection("notifications").doc(notifId).update({ status: "read", readAt: Date.now() });
  return { notifId, status: "read" };
}

module.exports = { sendNotification, getNotificationHistory, markRead, NOTIFICATION_TYPES, __setFirestoreForTests };
