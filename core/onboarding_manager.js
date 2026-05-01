'use strict';

/**
 * MIIA — Onboarding Manager (T143)
 * Gestiona el estado de onboarding de nuevos tenants.
 * Etapas: welcome -> business_info -> training -> whatsapp -> complete.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

const ONBOARDING_STAGES = Object.freeze([
  'welcome',
  'business_info',
  'training',
  'whatsapp',
  'complete',
]);

const STAGE_ORDER = Object.freeze(
  Object.fromEntries(ONBOARDING_STAGES.map((s, i) => [s, i]))
);

/**
 * Obtiene el estado de onboarding de un owner.
 * @returns {Promise<{ uid, stage, completedStages, startedAt, completedAt }>}
 */
async function getOnboardingState(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('onboarding').doc(uid).get();
    if (!snap.exists) {
      return {
        uid,
        stage: 'welcome',
        completedStages: [],
        startedAt: null,
        completedAt: null,
      };
    }
    return { uid, ...snap.data() };
  } catch (e) {
    console.error(`[ONBOARDING] Error leyendo estado uid=${uid.substring(0,8)}: ${e.message}`);
    return { uid, stage: 'welcome', completedStages: [], startedAt: null, completedAt: null };
  }
}

/**
 * Avanza al siguiente estado de onboarding.
 * @param {string} uid
 * @param {string} completedStage - etapa que se acaba de completar
 * @returns {Promise<{ uid, stage, completedStages, isComplete }>}
 */
async function advanceOnboarding(uid, completedStage) {
  if (!uid) throw new Error('uid requerido');
  if (!ONBOARDING_STAGES.includes(completedStage)) throw new Error(`etapa invalida: ${completedStage}`);

  const current = await getOnboardingState(uid);
  const completedStages = [...new Set([...(current.completedStages || []), completedStage])];

  const nextIdx = STAGE_ORDER[completedStage] + 1;
  const nextStage = nextIdx < ONBOARDING_STAGES.length ? ONBOARDING_STAGES[nextIdx] : 'complete';

  const now = new Date().toISOString();
  const isComplete = nextStage === 'complete' || completedStage === 'whatsapp';

  const update = {
    uid,
    stage: isComplete ? 'complete' : nextStage,
    completedStages,
    startedAt: current.startedAt || now,
    completedAt: isComplete ? now : null,
    updatedAt: now,
  };

  try {
    await db().collection('onboarding').doc(uid).set(update, { merge: true });
    console.log(`[ONBOARDING] uid=${uid.substring(0,8)} advanced: ${completedStage} -> ${update.stage}`);
  } catch (e) {
    console.error(`[ONBOARDING] Error guardando avance uid=${uid.substring(0,8)}: ${e.message}`);
    throw e;
  }

  return { ...update, isComplete };
}

/**
 * Verifica si el onboarding esta completo.
 */
async function isOnboardingComplete(uid) {
  const state = await getOnboardingState(uid);
  return state.stage === 'complete';
}

/**
 * Resetea el onboarding (para testing/admin).
 */
async function resetOnboarding(uid) {
  if (!uid) throw new Error('uid requerido');
  await db().collection('onboarding').doc(uid).set({
    uid,
    stage: 'welcome',
    completedStages: [],
    startedAt: null,
    completedAt: null,
  });
}

module.exports = {
  getOnboardingState,
  advanceOnboarding,
  isOnboardingComplete,
  resetOnboarding,
  ONBOARDING_STAGES,
  STAGE_ORDER,
  __setFirestoreForTests,
};
