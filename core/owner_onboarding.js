'use strict';
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const STEPS = Object.freeze(["phone_verify", "business_name", "business_type", "first_catalog_item", "test_message"]);

async function getOnboardingState(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("onboarding").doc(uid).get();
  if (!snap.exists) {
    return { step: STEPS[0], completed: false, completedSteps: [], pendingSteps: [...STEPS] };
  }
  const data = snap.data();
  const completedSteps = data.completedSteps || [];
  const pendingSteps = STEPS.filter(s => !completedSteps.includes(s));
  const completed = pendingSteps.length === 0;
  const step = pendingSteps[0] || null;
  return { step, completed, completedSteps, pendingSteps };
}

async function advanceStep(uid, step, data = {}) {
  if (!uid) throw new Error("uid required");
  if (!step || !STEPS.includes(step)) throw new Error("invalid step: " + step);
  const current = await getOnboardingState(uid);
  if (current.completedSteps.includes(step)) return current;
  const completedSteps = [...current.completedSteps, step];
  const pendingSteps = STEPS.filter(s => !completedSteps.includes(s));
  const completed = pendingSteps.length === 0;
  const nextStep = pendingSteps[0] || null;
  const newState = { uid, completedSteps, pendingSteps, completed, step: nextStep, stepData: Object.assign({}, (await getDb().collection("onboarding").doc(uid).get()).data()?.stepData || {}, { [step]: data }) };
  await getDb().collection("onboarding").doc(uid).set(newState);
  return newState;
}

async function isOnboardingComplete(uid) {
  if (!uid) return false;
  const state = await getOnboardingState(uid);
  return state.completed;
}

async function getWelcomeMessage(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("onboarding").doc(uid).get();
  const data = snap.exists ? snap.data() : {};
  const bizName = data.stepData?.business_name?.name || "tu negocio";
  return "Bienvenido a MIIA, " + bizName + "! Tu asistente esta lista para atender tus clientes.";
}

module.exports = { STEPS, getOnboardingState, advanceStep, isOnboardingComplete, getWelcomeMessage, __setFirestoreForTests };
