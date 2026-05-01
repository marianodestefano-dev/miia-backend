'use strict';

const {
  startOnboarding, getOnboardingState, advancePhase, saveAnswer,
  calculateCertificationLevel, buildProgressSummary, buildDiscoveryQuestions,
  getNextPhase, getPhaseIndex, isValidPhase,
  ONBOARDING_PHASES, PHASE_LABELS, CERTIFICATION_LEVELS,
  MIN_QUESTIONS_PER_PHASE, MAX_QUESTIONS_PER_PHASE, COMPLETION_THRESHOLD,
  __setFirestoreForTests,
} = require('../core/onboarding_flow');

const UID = 'testUid1234567890';

function makeMockDb({ stateData = null, throwGet = false, throwSet = false } = {}) {
  let stored = stateData ? { ...stateData } : null;
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              stored = opts && opts.merge ? { ...(stored || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { exists: !!stored, data: () => stored };
            },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('Constantes', () => {
  test('ONBOARDING_PHASES tiene 6 fases', () => { expect(ONBOARDING_PHASES.length).toBe(6); });
  test('primera fase es discovery', () => { expect(ONBOARDING_PHASES[0]).toBe('discovery'); });
  test('ultima fase es passive_learning', () => { expect(ONBOARDING_PHASES[5]).toBe('passive_learning'); });
  test('frozen ONBOARDING_PHASES', () => { expect(() => { ONBOARDING_PHASES.push('x'); }).toThrow(); });
  test('CERTIFICATION_LEVELS tiene 4 niveles', () => { expect(CERTIFICATION_LEVELS.length).toBe(4); });
  test('COMPLETION_THRESHOLD es 0.75', () => { expect(COMPLETION_THRESHOLD).toBe(0.75); });
  test('PHASE_LABELS tiene labels para todas las fases', () => {
    ONBOARDING_PHASES.forEach(p => { expect(PHASE_LABELS[p]).toBeDefined(); });
  });
});

describe('isValidPhase, getPhaseIndex, getNextPhase', () => {
  test('discovery es fase valida', () => { expect(isValidPhase('discovery')).toBe(true); });
  test('random no es fase valida', () => { expect(isValidPhase('random')).toBe(false); });
  test('discovery tiene index 0', () => { expect(getPhaseIndex('discovery')).toBe(0); });
  test('getNextPhase(discovery) es material_load', () => { expect(getNextPhase('discovery')).toBe('material_load'); });
  test('getNextPhase(passive_learning) es null', () => { expect(getNextPhase('passive_learning')).toBeNull(); });
  test('fase invalida retorna null', () => { expect(getNextPhase('nope')).toBeNull(); });
});

describe('buildDiscoveryQuestions', () => {
  test('retorna preguntas base para sector generico', () => {
    const qs = buildDiscoveryQuestions('retail');
    expect(qs.length).toBeGreaterThanOrEqual(4);
    expect(qs.some(q => q.id === 'q_name')).toBe(true);
    expect(qs.some(q => q.id === 'q_sector')).toBe(true);
  });
  test('agrega pregunta delivery para sector food', () => {
    const qs = buildDiscoveryQuestions('food');
    expect(qs.some(q => q.id === 'q_delivery')).toBe(true);
  });
  test('agrega pregunta turnos para sector health', () => {
    const qs = buildDiscoveryQuestions('health');
    expect(qs.some(q => q.id === 'q_appointments')).toBe(true);
  });
});

describe('getOnboardingState', () => {
  test('lanza si uid undefined', async () => {
    await expect(getOnboardingState(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna estado default si no existe', async () => {
    __setFirestoreForTests(makeMockDb({ stateData: null }));
    const s = await getOnboardingState(UID);
    expect(s.currentPhase).toBe('discovery');
    expect(s.phaseIndex).toBe(0);
    expect(s.progress).toBe(0);
  });
  test('retorna estado guardado si existe', async () => {
    const saved = { uid: UID, currentPhase: 'material_load', phaseIndex: 1, progress: 0.2, completedPhases: ['discovery'], answers: {} };
    __setFirestoreForTests(makeMockDb({ stateData: saved }));
    const s = await getOnboardingState(UID);
    expect(s.currentPhase).toBe('material_load');
  });
  test('fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const s = await getOnboardingState(UID);
    expect(s).toBeNull();
  });
});

describe('startOnboarding', () => {
  test('lanza si uid undefined', async () => {
    await expect(startOnboarding(undefined)).rejects.toThrow('uid requerido');
  });
  test('inicia onboarding con estado inicial correcto', async () => {
    __setFirestoreForTests(makeMockDb());
    const s = await startOnboarding(UID);
    expect(s.currentPhase).toBe('discovery');
    expect(s.phaseIndex).toBe(0);
    expect(s.progress).toBe(0);
    expect(s.startedAt).toBeDefined();
    expect(s.completedAt).toBeNull();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(startOnboarding(UID)).rejects.toThrow('set error');
  });
});

describe('advancePhase', () => {
  test('lanza si uid undefined', async () => {
    await expect(advancePhase(undefined)).rejects.toThrow('uid requerido');
  });
  test('avanza a la siguiente fase', async () => {
    const state = { uid: UID, currentPhase: 'discovery', phaseIndex: 0, completedPhases: [], answers: {}, progress: 0 };
    __setFirestoreForTests(makeMockDb({ stateData: state }));
    const r = await advancePhase(UID);
    expect(r.completed).toBe(false);
    expect(r.state.currentPhase).toBe('material_load');
    expect(r.state.completedPhases).toContain('discovery');
  });
  test('marca como completado en la ultima fase', async () => {
    const state = { uid: UID, currentPhase: 'passive_learning', phaseIndex: 5, completedPhases: ONBOARDING_PHASES.slice(0, 5), answers: {}, progress: 0.9 };
    __setFirestoreForTests(makeMockDb({ stateData: state }));
    const r = await advancePhase(UID);
    expect(r.completed).toBe(true);
    expect(r.state.completedAt).toBeDefined();
  });
});

describe('saveAnswer', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveAnswer(undefined, 'q1', 'resp')).rejects.toThrow('uid requerido');
  });
  test('lanza si questionId undefined', async () => {
    const state = { uid: UID, currentPhase: 'discovery', answers: {} };
    __setFirestoreForTests(makeMockDb({ stateData: state }));
    await expect(saveAnswer(UID, undefined, 'resp')).rejects.toThrow('questionId requerido');
  });
  test('guarda respuesta correctamente', async () => {
    const state = { uid: UID, currentPhase: 'discovery', answers: {} };
    __setFirestoreForTests(makeMockDb({ stateData: state }));
    const r = await saveAnswer(UID, 'q_name', 'Mi Negocio SA');
    expect(r.saved).toBe(true);
    expect(r.questionId).toBe('q_name');
  });
});

describe('calculateCertificationLevel', () => {
  test('sin datos retorna null', () => {
    expect(calculateCertificationLevel({}, [])).toBeNull();
  });
  test('bronze con 1 fase completada', () => {
    expect(calculateCertificationLevel({ q1: 'a' }, ['discovery'])).toBe('bronze');
  });
  test('silver con 3+ fases y 5+ respuestas', () => {
    const answers = Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['q' + i, 'r' + i]));
    expect(calculateCertificationLevel(answers, ['discovery', 'material_load', 'adaptive_questions'])).toBe('silver');
  });
  test('diamond con todas las fases y 10+ respuestas', () => {
    const answers = Object.fromEntries(Array.from({ length: 11 }, (_, i) => ['q' + i, 'r' + i]));
    expect(calculateCertificationLevel(answers, [...ONBOARDING_PHASES])).toBe('diamond');
  });
});

describe('buildProgressSummary', () => {
  test('retorna null si state null', () => { expect(buildProgressSummary(null)).toBeNull(); });
  test('retorna summary con campos correctos', () => {
    const state = { uid: UID, currentPhase: 'material_load', phaseIndex: 1, completedPhases: ['discovery'], progress: 0.17, certificationLevel: null, completedAt: null };
    const s = buildProgressSummary(state);
    expect(s.currentPhaseLabel).toBe('Carga de material');
    expect(s.totalPhases).toBe(6);
    expect(s.completedPhases).toBe(1);
    expect(s.isComplete).toBe(false);
  });
  test('isComplete true si hay completedAt', () => {
    const state = { uid: UID, currentPhase: 'passive_learning', completedPhases: [], progress: 1, completedAt: '2026-05-01T10:00:00Z' };
    expect(buildProgressSummary(state).isComplete).toBe(true);
  });
});
