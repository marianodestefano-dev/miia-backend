'use strict';

/**
 * onboarding_wizard.js -- T-P3-2
 * Backend del wizard de 5 pasos para que un comerciante configure MIIA en <30 min.
 *
 * Pasos:
 *   1. business_info (name, vertical, country)
 *   2. products (catalogo inicial)
 *   3. hours (horario atencion)
 *   4. disclaimer_mode (oculto / a pedido / proactivo)
 *   5. test_message (probar primer mensaje)
 */

const STEPS = Object.freeze([
  'business_info',
  'products',
  'hours',
  'disclaimer_mode',
  'test_message',
]);

const VERTICALS = Object.freeze([
  'food', 'retail', 'health', 'beauty', 'fitness', 'education',
  'services', 'real_estate', 'auto', 'other',
]);

const DISCLAIMER_MODES = Object.freeze(['hidden', 'on_request', 'proactive']);
const COL_ONBOARDING = 'onboarding_state';

/* istanbul ignore next */
let _db = null;
/* istanbul ignore next */
function __setFirestoreForTests(fs) { _db = fs; }
/* istanbul ignore next */
function db() { return _db || require('firebase-admin').firestore(); }

function _validateStepData(stepName, data) {
  if (!data || typeof data !== 'object') throw new Error('data requerido');
  if (stepName === 'business_info') {
    if (!data.name || typeof data.name !== 'string') throw new Error('name requerido');
    if (!data.vertical) throw new Error('vertical requerido');
    if (!VERTICALS.includes(data.vertical)) throw new Error('vertical invalida: ' + data.vertical);
  }
  if (stepName === 'hours') {
    if (!data.timezone) throw new Error('timezone requerido');
    if (data.openTime && !/^\d{2}:\d{2}$/.test(data.openTime)) throw new Error('openTime formato HH:MM');
    if (data.closeTime && !/^\d{2}:\d{2}$/.test(data.closeTime)) throw new Error('closeTime formato HH:MM');
  }
  if (stepName === 'disclaimer_mode') {
    if (!DISCLAIMER_MODES.includes(data.mode)) throw new Error('mode invalido: ' + data.mode);
  }
  if (stepName === 'products') {
    if (!Array.isArray(data.products)) throw new Error('products debe ser array');
  }
  if (stepName === 'test_message') {
    if (!data.targetPhone) throw new Error('targetPhone requerido');
  }
  return true;
}

async function startOnboarding(uid) {
  if (!uid) throw new Error('uid requerido');
  const state = {
    uid,
    currentStep: 'business_info',
    completedSteps: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  await db().collection('owners').doc(uid).collection(COL_ONBOARDING).doc('state').set(state);
  return state;
}

async function saveStep(uid, stepName, data) {
  if (!uid) throw new Error('uid requerido');
  if (!STEPS.includes(stepName)) throw new Error('step invalido: ' + stepName);
  _validateStepData(stepName, data);
  const ref = db().collection('owners').doc(uid).collection(COL_ONBOARDING).doc('state');
  const existing = await ref.get();
  const current = existing && existing.exists && existing.data ? existing.data() : { completedSteps: [] };
  const completedSteps = Array.isArray(current.completedSteps) ? current.completedSteps.slice() : [];
  if (!completedSteps.includes(stepName)) completedSteps.push(stepName);
  const isLast = stepName === STEPS[STEPS.length - 1];
  const idx = STEPS.indexOf(stepName);
  const nextStep = !isLast ? STEPS[idx + 1] : null;
  const update = {
    [`step_${stepName}`]: data,
    completedSteps,
    currentStep: nextStep || stepName,
    completedAt: isLast ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString(),
  };
  await ref.set(update, { merge: true });
  return { stepName, nextStep, isComplete: isLast };
}

async function getOnboardingState(uid) {
  if (!uid) throw new Error('uid requerido');
  const doc = await db().collection('owners').doc(uid).collection(COL_ONBOARDING).doc('state').get();
  if (!doc || !doc.exists) return null;
  return doc.data ? doc.data() : null;
}

function calculateProgress(state) {
  if (!state || !state.completedSteps) return { percent: 0, completed: 0, total: STEPS.length };
  const completed = Array.isArray(state.completedSteps) ? state.completedSteps.length : 0;
  return { percent: Math.round((completed / STEPS.length) * 100), completed, total: STEPS.length };
}

function isOnboardingComplete(state) {
  if (!state) return false;
  return !!state.completedAt;
}

module.exports = {
  startOnboarding,
  saveStep,
  getOnboardingState,
  calculateProgress,
  isOnboardingComplete,
  STEPS,
  VERTICALS,
  DISCLAIMER_MODES,
  __setFirestoreForTests,
};
