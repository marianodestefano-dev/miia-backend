'use strict';

/**
 * MIIA â€” Onboarding Wizard V2 (T154)
 * Wizard de 5 pasos con validacion estricta para setup del owner.
 * Steps: identity -> business -> catalog -> whatsapp -> training
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

const WIZARD_STEPS = Object.freeze([
  'identity', 'business', 'catalog', 'whatsapp', 'training',
]);

const STEP_INDEX = Object.freeze(
  WIZARD_STEPS.reduce((acc, s, i) => { acc[s] = i; return acc; }, {})
);

const STEP_VALIDATORS = {
  identity: (data) => {
    const errors = [];
    if (!data.ownerName || typeof data.ownerName !== 'string') errors.push('ownerName requerido');
    if (!data.email || !data.email.includes('@')) errors.push('email invalido');
    return errors;
  },
  business: (data) => {
    const errors = [];
    if (!data.businessName || typeof data.businessName !== 'string') errors.push('businessName requerido');
    if (!data.sector) errors.push('sector requerido');
    if (!data.country || data.country.length < 2) errors.push('country requerido (codigo ISO)');
    return errors;
  },
  catalog: (data) => {
    const errors = [];
    if (data.hasCatalog === undefined || data.hasCatalog === null) errors.push('hasCatalog requerido');
    if (data.hasCatalog && data.productCount !== undefined) {
      if (typeof data.productCount !== 'number' || data.productCount < 0) errors.push('productCount debe ser numero >= 0');
    }
    return errors;
  },
  whatsapp: (data) => {
    const errors = [];
    if (!data.whatsappPhone) errors.push('whatsappPhone requerido');
    if (data.whatsappPhone && !/^\+\d{8,15}$/.test(data.whatsappPhone)) errors.push('whatsappPhone formato invalido');
    return errors;
  },
  training: (data) => {
    const errors = [];
    if (data.trainingText !== undefined && typeof data.trainingText !== 'string') errors.push('trainingText debe ser string');
    return errors;
  },
};

/**
 * Obtiene el estado del wizard para un owner.
 */
async function getWizardState(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('onboarding_wizard').doc(uid).get();
    if (!snap.exists) return _defaultState(uid);
    return { ...snap.data(), uid };
  } catch (e) {
    console.error('[WIZARD] Error leyendo estado uid=' + uid.substring(0,8) + ': ' + e.message);
    return _defaultState(uid);
  }
}

function _defaultState(uid) {
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

/**
 * Valida y avanza un paso del wizard.
 * @param {string} uid
 * @param {string} step
 * @param {object} data
 * @returns {Promise<{success, errors, nextStep, state}>}
 */
async function submitStep(uid, step, data) {
  if (!uid) throw new Error('uid requerido');
  if (!WIZARD_STEPS.includes(step)) throw new Error('step invalido: ' + step);
  if (!data || typeof data !== 'object') throw new Error('data requerido');

  const validator = STEP_VALIDATORS[step];
  const errors = validator(data);
  if (errors.length > 0) return { success: false, errors, nextStep: step, state: null };

  const current = await getWizardState(uid);
  const stepIdx = STEP_INDEX[step];
  const completedSteps = new Set(current.completedSteps);
  completedSteps.add(step);

  const nextStep = WIZARD_STEPS[stepIdx + 1] || null;
  const completed = completedSteps.size === WIZARD_STEPS.length;

  const newState = {
    uid,
    currentStep: nextStep || step,
    completedSteps: Array.from(completedSteps),
    stepData: { ...current.stepData, [step]: data },
    completed,
    startedAt: current.startedAt,
    completedAt: completed ? new Date().toISOString() : null,
  };

  try {
    await db().collection('onboarding_wizard').doc(uid).set(newState);
    console.log('[WIZARD] uid=' + uid.substring(0,8) + ' step=' + step + ' completed=' + completed);
  } catch (e) {
    console.error('[WIZARD] Error guardando estado uid=' + uid.substring(0,8) + ': ' + e.message);
    throw e;
  }

  return { success: true, errors: [], nextStep, state: newState };
}

/**
 * Verifica si el wizard esta completo.
 */
async function isWizardComplete(uid) {
  if (!uid) throw new Error('uid requerido');
  const state = await getWizardState(uid);
  return state.completed === true;
}

/**
 * Reinicia el wizard.
 */
async function resetWizard(uid) {
  if (!uid) throw new Error('uid requerido');
  const fresh = _defaultState(uid);
  try {
    await db().collection('onboarding_wizard').doc(uid).set(fresh);
    return fresh;
  } catch (e) {
    console.error('[WIZARD] Error reseteando uid=' + uid.substring(0,8) + ': ' + e.message);
    throw e;
  }
}

module.exports = {
  getWizardState, submitStep, isWizardComplete, resetWizard,
  WIZARD_STEPS, STEP_INDEX, STEP_VALIDATORS,
  __setFirestoreForTests,
};
