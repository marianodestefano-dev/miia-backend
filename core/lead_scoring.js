"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const SCORE_FACTORS = Object.freeze({
  message_frequency: 0.30,
  response_rate: 0.25,
  intent_signals: 0.25,
  recency: 0.20,
});

const INTENT_KEYWORDS = Object.freeze(["precio", "cuanto", "comprar", "reservar", "contratar", "cuando", "disponible", "costo"]);

function computeLeadScore(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { score: 0, factors: {}, breakdown: {} };
  const leadMsgs = messages.filter(m => m.role === "lead");
  const miaMsgs = messages.filter(m => m.role === "miia");

  const freqScore = Math.min(100, leadMsgs.length * 10);
  const responseRate = miaMsgs.length > 0 ? Math.min(100, (miaMsgs.length / Math.max(leadMsgs.length, 1)) * 100) : 0;
  const allText = leadMsgs.map(m => (m.content || "").toLowerCase()).join(" ");
  const intentCount = INTENT_KEYWORDS.filter(k => allText.includes(k)).length;
  const intentScore = Math.min(100, intentCount * 20);
  const lastMsg = leadMsgs[leadMsgs.length - 1];
  const daysSince = lastMsg ? (Date.now() - (lastMsg.timestamp || Date.now())) / (24 * 60 * 60 * 1000) : 30;
  const recencyScore = Math.max(0, 100 - daysSince * 5);

  const score = Math.round(
    freqScore * SCORE_FACTORS.message_frequency +
    responseRate * SCORE_FACTORS.response_rate +
    intentScore * SCORE_FACTORS.intent_signals +
    recencyScore * SCORE_FACTORS.recency
  );
  return {
    score: Math.min(100, Math.max(0, score)),
    factors: { freqScore, responseRate, intentScore, recencyScore },
    breakdown: { messages: leadMsgs.length, intentKeywords: intentCount },
  };
}

async function scoreLeadFromDb(uid, phone) {
  if (!uid || !phone) throw new Error("uid and phone required");
  const snap = await getDb().collection("conversations").doc(uid).collection("contacts").doc(phone).get();
  const messages = snap.exists ? (snap.data().messages || []) : [];
  const result = computeLeadScore(messages);
  await getDb().collection("lead_scores").doc(uid + "_" + phone).set({ uid, phone, ...result, scoredAt: Date.now() });
  return result;
}

module.exports = { computeLeadScore, scoreLeadFromDb, SCORE_FACTORS, INTENT_KEYWORDS, __setFirestoreForTests };
