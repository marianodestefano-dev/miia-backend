"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const INACTIVITY_THRESHOLD_DAYS = 14;
const CHURN_RISK_LEVELS = Object.freeze({ LOW: "low", MEDIUM: "medium", HIGH: "high" });

function computeChurnRisk(lastContactMs, totalMessages, avgResponseTimeMs) {
  const daysSince = (Date.now() - lastContactMs) / (24 * 60 * 60 * 1000);
  let score = 0;
  if (daysSince > 30) score += 50;
  else if (daysSince > INACTIVITY_THRESHOLD_DAYS) score += 30;
  else if (daysSince > 7) score += 10;
  if (totalMessages < 3) score += 20;
  if (avgResponseTimeMs > 24 * 60 * 60 * 1000) score += 20;
  const level = score >= 60 ? CHURN_RISK_LEVELS.HIGH : score >= 30 ? CHURN_RISK_LEVELS.MEDIUM : CHURN_RISK_LEVELS.LOW;
  return { score, level, daysSinceContact: Math.round(daysSince) };
}

async function getAtRiskLeads(uid) {
  if (!uid) throw new Error("uid required");
  const since = Date.now() - INACTIVITY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  const snap = await getDb().collection("leads").where("uid", "==", uid).get();
  const atRisk = [];
  snap.forEach(doc => {
    const d = doc.data();
    const lastContact = d.lastMessageAt || d.createdAt || 0;
    if (lastContact < since) {
      const risk = computeChurnRisk(lastContact, d.messageCount || 0, d.avgResponseTime || 0);
      if (risk.level !== CHURN_RISK_LEVELS.LOW) atRisk.push({ phone: d.phone, ...risk });
    }
  });
  return { uid, atRisk, count: atRisk.length };
}

module.exports = { computeChurnRisk, getAtRiskLeads, CHURN_RISK_LEVELS, INACTIVITY_THRESHOLD_DAYS, __setFirestoreForTests };
