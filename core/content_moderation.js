"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const ABUSE_PATTERNS = Object.freeze([
  /spam/i, /abuse/i, /hack/i, /scam/i, /fraude/i,
  /estafa/i, /robo/i, /amenaza/i, /odio/i,
]);

const SEVERITY_LEVELS = Object.freeze({ LOW: "low", MEDIUM: "medium", HIGH: "high" });

function moderateContent(text) {
  if (!text) return { flagged: false, patterns: [], severity: null };
  const matched = ABUSE_PATTERNS.filter(p => p.test(text));
  if (matched.length === 0) return { flagged: false, patterns: [], severity: null };
  const severity = matched.length >= 3 ? SEVERITY_LEVELS.HIGH : matched.length >= 2 ? SEVERITY_LEVELS.MEDIUM : SEVERITY_LEVELS.LOW;
  return { flagged: true, patterns: matched.map(p => p.toString()), severity };
}

async function flagMessage(uid, phone, message, result) {
  if (!uid || !phone || !message) throw new Error("uid, phone, message required");
  const entry = { uid, phone, message, severity: result.severity, patterns: result.patterns, flaggedAt: Date.now(), reviewed: false };
  await getDb().collection("moderation_flags").doc(uid + "_" + Date.now()).set(entry);
  console.log("[MODERATION] Flagged", result.severity, "uid:", uid, "phone:", phone);
  return entry;
}

async function checkAndFlag(uid, phone, message) {
  const result = moderateContent(message);
  if (!result.flagged) return result;
  await flagMessage(uid, phone, message, result);
  return result;
}

module.exports = { moderateContent, flagMessage, checkAndFlag, ABUSE_PATTERNS, SEVERITY_LEVELS, __setFirestoreForTests };
