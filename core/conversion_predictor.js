"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const CONVERSION_SIGNALS = Object.freeze(["precio", "comprar", "contratar", "reservar", "cuando empezamos", "me interesa", "adelante"]);

function predictConversion(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { probability: 0, factors: [], level: "low" };
  const leadText = messages.filter(m => m.role === "lead").map(m => (m.content || "").toLowerCase()).join(" ");
  const signals = CONVERSION_SIGNALS.filter(s => leadText.includes(s));
  const messagingVolume = messages.filter(m => m.role === "lead").length;
  let score = signals.length * 15 + Math.min(messagingVolume * 5, 25);
  score = Math.min(95, score);
  const level = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
  return { probability: score, factors: signals, level, explanation: "Basado en " + signals.length + " senales de conversion y " + messagingVolume + " mensajes" };
}

async function predictLeadConversion(uid, phone) {
  if (!uid || !phone) throw new Error("uid and phone required");
  const snap = await getDb().collection("conversations").doc(uid).collection("contacts").doc(phone).get();
  const messages = snap.exists ? (snap.data().messages || []) : [];
  return predictConversion(messages);
}

module.exports = { predictConversion, predictLeadConversion, CONVERSION_SIGNALS, __setFirestoreForTests };
