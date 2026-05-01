"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const SENTIMENTS = Object.freeze(["positive", "neutral", "negative", "urgent"]);

const POSITIVE_WORDS = Object.freeze(["gracias", "excelente", "perfecto", "genial", "bueno", "bien", "encantado", "feliz"]);
const NEGATIVE_WORDS = Object.freeze(["mal", "terrible", "pesimo", "horrible", "molesto", "enojado", "problema", "queja", "reclamo"]);
const URGENT_WORDS = Object.freeze(["urgente", "ya", "ahora", "rapido", "inmediato", "emergencia", "hoy mismo", "cuanto antes"]);

function analyzeSentiment(text) {
  if (!text) return { sentiment: "neutral", score: 0, signals: [] };
  const lower = text.toLowerCase();
  const positiveHits = POSITIVE_WORDS.filter(w => lower.includes(w));
  const negativeHits = NEGATIVE_WORDS.filter(w => lower.includes(w));
  const urgentHits = URGENT_WORDS.filter(w => lower.includes(w));

  if (urgentHits.length > 0) return { sentiment: "urgent", score: -10, signals: urgentHits };
  if (negativeHits.length > 0) return { sentiment: "negative", score: -negativeHits.length * 20, signals: negativeHits };
  if (positiveHits.length > 0) return { sentiment: "positive", score: positiveHits.length * 20, signals: positiveHits };
  return { sentiment: "neutral", score: 0, signals: [] };
}

async function analyzeConversation(uid, phone) {
  if (!uid || !phone) throw new Error("uid and phone required");
  const snap = await getDb().collection("conversations").doc(uid).collection("contacts").doc(phone).get();
  const messages = snap.exists ? (snap.data().messages || []) : [];
  const leadMessages = messages.filter(m => m.role === "lead");
  const analyses = leadMessages.map(m => analyzeSentiment(m.content));
  const sentiments = analyses.map(a => a.sentiment);
  const overall = sentiments.includes("urgent") ? "urgent" : sentiments.includes("negative") ? "negative" : sentiments.filter(s => s === "positive").length > sentiments.length / 2 ? "positive" : "neutral";
  return { uid, phone, overall, messageCount: leadMessages.length, analyses };
}

module.exports = { analyzeSentiment, analyzeConversation, SENTIMENTS, __setFirestoreForTests };
