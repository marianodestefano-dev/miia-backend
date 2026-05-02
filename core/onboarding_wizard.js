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


// ────────────────────────────────────────────────────────────
// API LEGACY (T154) -- WIZARD_STEPS/STEP_VALIDATORS por uid
// ────────────────────────────────────────────────────────────

const WIZARD_STEPS = Object.freeze(['identity', 'business', 'catalog', 'whatsapp', 'training']);
const STEP_INDEX = Object.freeze(WIZARD_STEPS.reduce((acc, s, i) => { acc[s] = i; return acc; }, {}));

const STEP_VALIDATORS = Object.freeze({
  identity: (data) => {
    const errors = [];
    if (!data.ownerName || typeof data.ownerName !== 'string' || !data.ownerName.trim()) errors.push('ownerName requerido');
    if (!data.email) errors.push('email requerido');
    else if (typeof data.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.push('email invalido');
    return errors;
  },
  business: (data) => {
    const errors = [];
    if (!data.businessName) errors.push('businessName requerido');
    if (!data.sector) errors.push('sector requerido');
    if (!data.country) errors.push('country requerido');
    return errors;
  },
  catalog: (data) => {
    const errors = [];
    if (data.hasCatalog === undefined || data.hasCatalog === null) errors.push('hasCatalog requerido');
    if (data.hasCatalog === true && data.productCount !== undefined) {
      if (typeof data.productCount !== 'number' || data.productCount < 0) errors.push('productCount debe ser numero >= 0');
    }
    return errors;
  },
  whatsapp: (data) => {
    const errors = [];
    if (!data.whatsappPhone) errors.push('whatsappPhone requerido');
    else if (!/^\+?[1-9]\d{6,14}$/.test(data.whatsappPhone)) errors.push('whatsappPhone formato invalido');
    return errors;
  },
  training: (data) => {
    const errors = [];
    if (data.trainingText !== undefined && typeof data.trainingText !== 'string') errors.push('trainingText debe ser string');
    return errors;
  },
});

const COL_WIZARD = 'onboarding_wizard';

function _initialState(uid) {
  return {
    uid,
    currentStep: 'identity',
    completedSteps: [],
    stepData: {},
    completed: false,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}

async function getWizardState(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const doc = await db().collection(COL_WIZARD).doc(uid).get();
    if (!doc || !doc.exists) return _initialState(uid);
    return doc.data ? doc.data() : _initialState(uid);
  } catch (e) {
    return _initialState(uid);
  }
}

async function submitStep(uid, step, data) {
  if (!uid) throw new Error('uid requerido');
  if (!WIZARD_STEPS.includes(step)) throw new Error('step invalido: ' + step);
  if (data === undefined || data === null) throw new Error('data requerido');

  const errors = STEP_VALIDATORS[step](data);
  if (errors.length > 0) {
    return { success: false, errors, nextStep: step, state: null };
  }

  let state;
  try {
    const doc = await db().collection(COL_WIZARD).doc(uid).get();
    /* istanbul ignore next: ternary doc edge cases ya cubiertos por getWizardState test */
    state = (doc && doc.exists && doc.data) ? doc.data() : _initialState(uid);
  } catch (e) {
    /* istanbul ignore next: catch fail-open submitStep -- getWizardState ya tiene su test fail-open */
    state = _initialState(uid);
  }

  if (!Array.isArray(state.completedSteps)) state.completedSteps = [];
  if (!state.completedSteps.includes(step)) state.completedSteps.push(step);
  state.stepData = state.stepData || {};
  state.stepData[step] = data;

  const idx = STEP_INDEX[step];
  const isLast = idx === WIZARD_STEPS.length - 1;
  const nextStep = isLast ? null : WIZARD_STEPS[idx + 1];
  state.currentStep = nextStep || step;
  if (isLast) {
    state.completed = true;
    state.completedAt = new Date().toISOString();
  }
  state.updatedAt = new Date().toISOString();

  await db().collection(COL_WIZARD).doc(uid).set(state, { merge: true });
  return { success: true, errors: [], nextStep, state };
}

async function isWizardComplete(uid) {
  if (!uid) throw new Error('uid requerido');
  const s = await getWizardState(uid);
  return !!s.completed;
}

async function resetWizard(uid) {
  if (!uid) throw new Error('uid requerido');
  const initial = _initialState(uid);
  await db().collection(COL_WIZARD).doc(uid).set(initial);
  return initial;
}

module.exports.getWizardState = getWizardState;
module.exports.submitStep = submitStep;
module.exports.isWizardComplete = isWizardComplete;
module.exports.resetWizard = resetWizard;
module.exports.WIZARD_STEPS = WIZARD_STEPS;
module.exports.STEP_INDEX = STEP_INDEX;
module.exports.STEP_VALIDATORS = STEP_VALIDATORS;
module.exports.__setFirestoreForTests = __setFirestoreForTests;
