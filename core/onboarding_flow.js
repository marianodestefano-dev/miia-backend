'use strict';

/**
 * MIIA - Onboarding Flow (T237)
 * P3.2 ROADMAP: onboarding socratico 6 fases para nuevos owners.
 * Descubrimiento -> carga material -> preguntas adaptativas -> deteccion grises -> certificacion -> aprendizaje pasivo.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const ONBOARDING_PHASES = Object.freeze([
  'discovery', 'material_load', 'adaptive_questions', 'grey_detection', 'certification', 'passive_learning',
]);

const PHASE_LABELS = Object.freeze({
  discovery: 'Descubrimiento del negocio',
  material_load: 'Carga de material',
  adaptive_questions: 'Preguntas adaptativas',
  grey_detection: 'Deteccion de casos grises',
  certification: 'Certificacion MIIA',
  passive_learning: 'Aprendizaje pasivo continuo',
});

const CERTIFICATION_LEVELS = Object.freeze(['bronze', 'silver', 'gold', 'diamond']);
const MIN_QUESTIONS_PER_PHASE = 3;
const MAX_QUESTIONS_PER_PHASE = 10;
const COMPLETION_THRESHOLD = 0.75;

function isValidPhase(phase) {
  return ONBOARDING_PHASES.includes(phase);
}

function getPhaseIndex(phase) {
  return ONBOARDING_PHASES.indexOf(phase);
}

function getNextPhase(currentPhase) {
  var idx = getPhaseIndex(currentPhase);
  if (idx === -1 || idx >= ONBOARDING_PHASES.length - 1) return null;
  return ONBOARDING_PHASES[idx + 1];
}

function buildDiscoveryQuestions(sector) {
  var base = [
    { id: 'q_name', question: 'Como se llama tu negocio?', type: 'text', required: true },
    { id: 'q_sector', question: 'A que se dedica tu negocio?', type: 'text', required: true },
    { id: 'q_hours', question: 'Cual es tu horario de atencion?', type: 'text', required: false },
    { id: 'q_location', question: 'Donde esta ubicado tu negocio?', type: 'text', required: false },
  ];
  if (sector === 'food') {
    base.push({ id: 'q_delivery', question: 'Ofreces delivery?', type: 'boolean', required: false });
  } else if (sector === 'health') {
    base.push({ id: 'q_appointments', question: 'Trabajas con turnos?', type: 'boolean', required: false });
  }
  return base;
}

async function getOnboardingState(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('onboarding').doc('state').get();
    if (!snap || !snap.exists) {
      return {
        uid,
        currentPhase: ONBOARDING_PHASES[0],
        phaseIndex: 0,
        completedPhases: [],
        answers: {},
        certificationLevel: null,
        startedAt: null,
        completedAt: null,
        progress: 0,
      };
    }
    return snap.data();
  } catch (e) {
    console.error('[ONBOARDING] Error leyendo estado: ' + e.message);
    return null;
  }
}

async function saveOnboardingState(uid, state) {
  if (!uid) throw new Error('uid requerido');
  if (!state) throw new Error('state requerido');
  await db().collection('tenants').doc(uid).collection('onboarding').doc('state').set({
    ...state,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  console.log('[ONBOARDING] Estado guardado uid=' + uid + ' phase=' + state.currentPhase);
}

async function startOnboarding(uid) {
  if (!uid) throw new Error('uid requerido');
  var state = {
    uid,
    currentPhase: ONBOARDING_PHASES[0],
    phaseIndex: 0,
    completedPhases: [],
    answers: {},
    certificationLevel: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    progress: 0,
  };
  await saveOnboardingState(uid, state);
  return state;
}

async function advancePhase(uid) {
  if (!uid) throw new Error('uid requerido');
  var state = await getOnboardingState(uid);
  if (!state) throw new Error('estado de onboarding no encontrado');
  var next = getNextPhase(state.currentPhase);
  if (!next) {
    var updated = {
      ...state,
      completedAt: new Date().toISOString(),
      progress: 1,
    };
    await saveOnboardingState(uid, updated);
    return { completed: true, state: updated };
  }
  var completedPhases = [...(state.completedPhases || []), state.currentPhase];
  var updated = {
    ...state,
    currentPhase: next,
    phaseIndex: getPhaseIndex(next),
    completedPhases,
    progress: completedPhases.length / ONBOARDING_PHASES.length,
  };
  await saveOnboardingState(uid, updated);
  return { completed: false, state: updated, nextPhase: next };
}

async function saveAnswer(uid, questionId, answer) {
  if (!uid) throw new Error('uid requerido');
  if (!questionId) throw new Error('questionId requerido');
  var state = await getOnboardingState(uid);
  if (!state) throw new Error('estado de onboarding no encontrado');
  var answers = { ...(state.answers || {}), [questionId]: answer };
  await saveOnboardingState(uid, { ...state, answers });
  return { saved: true, questionId, answer };
}

function calculateCertificationLevel(answers, completedPhases) {
  var phaseCount = (completedPhases || []).length;
  var answerCount = Object.keys(answers || {}).length;
  if (phaseCount >= ONBOARDING_PHASES.length && answerCount >= 10) return 'diamond';
  if (phaseCount >= 4 && answerCount >= 7) return 'gold';
  if (phaseCount >= 3 && answerCount >= 5) return 'silver';
  if (phaseCount >= 1) return 'bronze';
  return null;
}

function buildProgressSummary(state) {
  if (!state) return null;
  return {
    uid: state.uid,
    currentPhase: state.currentPhase,
    currentPhaseLabel: PHASE_LABELS[state.currentPhase] || state.currentPhase,
    phaseIndex: state.phaseIndex || 0,
    totalPhases: ONBOARDING_PHASES.length,
    completedPhases: (state.completedPhases || []).length,
    progress: state.progress || 0,
    certificationLevel: state.certificationLevel,
    isComplete: !!state.completedAt,
  };
}

module.exports = {
  startOnboarding,
  getOnboardingState,
  saveOnboardingState,
  advancePhase,
  saveAnswer,
  calculateCertificationLevel,
  buildProgressSummary,
  buildDiscoveryQuestions,
  getNextPhase,
  getPhaseIndex,
  isValidPhase,
  ONBOARDING_PHASES,
  PHASE_LABELS,
  CERTIFICATION_LEVELS,
  MIN_QUESTIONS_PER_PHASE,
  MAX_QUESTIONS_PER_PHASE,
  COMPLETION_THRESHOLD,
  __setFirestoreForTests,
};
