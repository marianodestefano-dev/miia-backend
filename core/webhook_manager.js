"use strict";
const crypto = require("crypto");
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const WEBHOOK_EVENTS = Object.freeze(["lead_nuevo", "cita_agendada", "venta_cerrada", "pago_recibido"]);

function generateHmacSignature(secret, body) {
  return crypto.createHmac("sha256", secret).update(typeof body === "string" ? body : JSON.stringify(body)).digest("hex");
}

async function registerWebhook(uid, opts) {
  const { url, events, secret } = opts || {};
  if (!uid || !url) throw new Error("uid and url required");
  const invalidEvents = (events || []).filter(e => !WEBHOOK_EVENTS.includes(e));
  if (invalidEvents.length) throw new Error("invalid events: " + invalidEvents.join(", "));
  const wh = {
    id: randomUUID(),
    uid,
    url,
    events: events || WEBHOOK_EVENTS.slice(),
    secret: secret || crypto.randomBytes(16).toString("hex"),
    active: true,
    createdAt: Date.now(),
  };
  await getDb().collection("webhooks").doc(wh.id).set(wh);
  return wh;
}

async function triggerWebhook(uid, event, payload) {
  if (!uid || !event) throw new Error("uid and event required");
  if (!WEBHOOK_EVENTS.includes(event)) throw new Error("invalid event: " + event);
  const snap = await getDb().collection("webhooks").where("uid", "==", uid).where("active", "==", true).get();
  const triggered = [];
  snap.forEach(doc => {
    const wh = doc.data();
    if (wh.events.includes(event)) {
      const sig = generateHmacSignature(wh.secret, payload);
      triggered.push({ webhookId: wh.id, url: wh.url, signature: sig });
    }
  });
  return { event, triggered };
}

module.exports = { registerWebhook, triggerWebhook, generateHmacSignature, WEBHOOK_EVENTS, __setFirestoreForTests };
