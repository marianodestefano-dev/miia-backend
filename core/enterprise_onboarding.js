"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const ENTERPRISE_STEPS = Object.freeze([
  "company_info", "legal_contact", "user_seats", "contract_sign", "sla_config", "go_live"
]);
const MIN_ENTERPRISE_SEATS = 5;

async function createEnterpriseAccount(opts) {
  const { uid, companyName, contactEmail, seats } = opts || {};
  if (!uid || !companyName || !contactEmail) throw new Error("uid, companyName, contactEmail required");
  if ((seats || 0) < MIN_ENTERPRISE_SEATS) throw new Error("enterprise requires at least " + MIN_ENTERPRISE_SEATS + " seats");
  const account = {
    id: uid,
    companyName,
    contactEmail,
    seats: seats || MIN_ENTERPRISE_SEATS,
    plan: "enterprise",
    onboardingStep: ENTERPRISE_STEPS[0],
    onboardingCompleted: false,
    contractSigned: false,
    createdAt: Date.now(),
  };
  await getDb().collection("enterprise_accounts").doc(uid).set(account);
  return account;
}

async function advanceOnboarding(uid, step, data) {
  if (!uid || !step) throw new Error("uid and step required");
  const idx = ENTERPRISE_STEPS.indexOf(step);
  if (idx === -1) throw new Error("invalid step: " + step);
  const next = ENTERPRISE_STEPS[idx + 1] || null;
  const completed = next === null;
  const update = { onboardingStep: next || step, onboardingCompleted: completed };
  if (step === "contract_sign") update.contractSigned = true;
  if (data) update.stepData = { ...(data), step };
  await getDb().collection("enterprise_accounts").doc(uid).update(update);
  return { uid, step, next, completed };
}

async function getEnterpriseStatus(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("enterprise_accounts").doc(uid).get();
  if (!snap.exists) return null;
  const d = snap.data();
  return { uid, companyName: d.companyName, step: d.onboardingStep, completed: d.onboardingCompleted, contractSigned: d.contractSigned };
}

module.exports = { createEnterpriseAccount, advanceOnboarding, getEnterpriseStatus, ENTERPRISE_STEPS, MIN_ENTERPRISE_SEATS, __setFirestoreForTests };
