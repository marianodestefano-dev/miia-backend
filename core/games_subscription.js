"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const PLANS = Object.freeze({
  BASIC: { name: "Basic", priceUsd: 3, gamesPerMonth: 20, features: ["trivia", "wordgame"] },
  PRO: { name: "Pro", priceUsd: 8, gamesPerMonth: 100, features: ["trivia", "wordgame", "quiz", "math"] },
  ENTERPRISE: { name: "Enterprise", priceUsd: 25, gamesPerMonth: -1, features: ["all"] },
});

async function createSubscription(uid, planKey) {
  if (!uid || !planKey) throw new Error("uid and planKey required");
  if (!PLANS[planKey.toUpperCase()]) throw new Error("invalid plan: " + planKey);
  const plan = PLANS[planKey.toUpperCase()];
  const sub = {
    id: randomUUID(), uid,
    plan: planKey.toLowerCase(), planName: plan.name,
    priceUsd: plan.priceUsd, gamesPerMonth: plan.gamesPerMonth,
    gamesUsed: 0,
    status: "active",
    renewsAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    createdAt: Date.now(),
  };
  await getDb().collection("games_subscriptions").doc(uid).set(sub);
  return sub;
}

async function checkGameLimit(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("games_subscriptions").doc(uid).get();
  if (!snap.exists) return { allowed: false, reason: "no_subscription" };
  const sub = snap.data();
  if (sub.status !== "active") return { allowed: false, reason: "inactive_subscription" };
  if (sub.gamesPerMonth === -1) return { allowed: true, remaining: -1 };
  const remaining = sub.gamesPerMonth - (sub.gamesUsed || 0);
  return { allowed: remaining > 0, remaining, used: sub.gamesUsed };
}

module.exports = { createSubscription, checkGameLimit, PLANS, __setFirestoreForTests };
