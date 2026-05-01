'use strict';
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const FLAGS = Object.freeze({
  RESPONSE_TOO_SHORT: "RESPONSE_TOO_SHORT",
  ESCALATION_DETECTED: "ESCALATION_DETECTED",
  LOOP_DETECTED: "LOOP_DETECTED",
  PROMISE_BROKEN: "PROMISE_BROKEN",
  UNANSWERED_QUESTION: "UNANSWERED_QUESTION",
});

function scoreConversation(messages) {
  if (!Array.isArray(messages)) throw new Error("messages must be array");
  const flags = [];
  let score = 100;
  const miia = messages.filter(m => m.role === "miia");
  const lead = messages.filter(m => m.role === "lead");
  if (miia.some(m => (m.content || "").length < 10)) { flags.push(FLAGS.RESPONSE_TOO_SHORT); score -= 15; }
  if (detectEscalation(messages)) { flags.push(FLAGS.ESCALATION_DETECTED); score -= 20; }
  const counts = {};
  miia.forEach(m => { const k = (m.content || "").trim().toLowerCase().slice(0, 50); counts[k] = (counts[k] || 0) + 1; });
  if (Object.values(counts).some(c => c >= 3)) { flags.push(FLAGS.LOOP_DETECTED); score -= 25; }
  lead.forEach(lm => {
    if ((lm.content || "").includes("?")) {
      const idx = messages.indexOf(lm);
      const answered = messages.slice(idx + 1).some(m => m.role === "miia");
      if (!answered) { flags.push(FLAGS.UNANSWERED_QUESTION); score -= 10; }
    }
  });
  const promises = miia.filter(m => /te (mando|env[ii]o|llamo|confirmo)/i.test(m.content || ""));
  if (promises.length > 0 && miia.length <= promises.length) { flags.push(FLAGS.PROMISE_BROKEN); score -= 20; }
  score = Math.max(0, Math.min(100, score));
  const uniqueFlags = [...new Set(flags)];
  return { score, flags: uniqueFlags, breakdown: { baseScore: 100, deductions: 100 - score, flagCount: uniqueFlags.length, messageCount: messages.length } };
}

function detectEscalation(messages) {
  const patterns = [
    /hablar con (un|una) (persona|humano|agente)/i,
    /quiero (hablar|comunicarme) con alguien/i,
    /humano por favor/i,
    /esto no (funciona|sirve)/i,
    /necesito hablar con una persona/i,
  ];
  return messages.filter(m => m.role === "lead").some(m => patterns.some(p => p.test(m.content || "")));
}

async function getQualityTrend(uid, days) {
  if (!uid || !days || days <= 0) throw new Error("uid and days required");
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const snap = await getDb().collection("quality_scores").where("uid", "==", uid).where("timestamp", ">=", since).get();
  const scores = [];
  snap.forEach(doc => scores.push(doc.data().score));
  if (scores.length === 0) return { average: null, count: 0 };
  return { average: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length), count: scores.length };
}

async function flagConversation(uid, phone, flags) {
  if (!uid || !phone || !Array.isArray(flags)) throw new Error("uid, phone, flags[] required");
  await getDb().collection("flagged_conversations").doc(uid + "_" + phone).set({ uid, phone, flags, timestamp: Date.now() });
}

module.exports = { FLAGS, scoreConversation, detectEscalation, getQualityTrend, flagConversation, __setFirestoreForTests };
