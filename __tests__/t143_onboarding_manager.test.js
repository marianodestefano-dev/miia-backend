'use strict';
const { getOnboardingState, advanceOnboarding, isOnboardingComplete, resetOnboarding, ONBOARDING_STAGES, STAGE_ORDER, __setFirestoreForTests } = require('../core/onboarding_manager');

const UID = 'onboardingTestUid1234567';

function makeMockDb({ data = null, throwGet = false, throwSet = false } = {}) {
  let stored = data ? { ...data } : null;
  return {
    collection: () => ({ doc: () => ({
      get: async () => {
        if (throwGet) throw new Error('get failed');
        return stored ? { exists: true, data: () => ({ ...stored }) } : { exists: false };
      },
      set: async (newData, opts) => {
        if (throwSet) throw new Error('set failed');
        stored = opts && opts.merge ? { ...(stored || {}), ...newData } : { ...newData };
      }
    }) })
  };
}

afterEach(() => __setFirestoreForTests(null));

describe('ONBOARDING_STAGES y STAGE_ORDER', () => {
  test('tiene las etapas esperadas en orden', () => {
    expect(ONBOARDING_STAGES[0]).toBe('welcome');
    expect(ONBOARDING_STAGES[ONBOARDING_STAGES.length - 1]).toBe('complete');
    expect(ONBOARDING_STAGES).toContain('business_info');
    expect(ONBOARDING_STAGES).toContain('whatsapp');
  });
  test('STAGE_ORDER es un mapeo numerico', () => {
    expect(STAGE_ORDER['welcome']).toBe(0);
    expect(STAGE_ORDER['business_info']).toBe(1);
  });
});

describe('getOnboardingState', () => {
  test('lanza si uid falta', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getOnboardingState(null)).rejects.toThrow('uid requerido');
  });
  test('doc inexistente = welcome', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getOnboardingState(UID);
    expect(r.stage).toBe('welcome');
    expect(r.completedStages).toEqual([]);
  });
  test('falla Firestore = fail-open con welcome', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getOnboardingState(UID);
    expect(r.stage).toBe('welcome');
  });
  test('doc existente retorna datos guardados', async () => {
    __setFirestoreForTests(makeMockDb({ data: { stage: 'training', completedStages: ['welcome','business_info'] } }));
    const r = await getOnboardingState(UID);
    expect(r.stage).toBe('training');
    expect(r.completedStages).toContain('welcome');
  });
});

describe('advanceOnboarding', () => {
  test('lanza si uid falta', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(advanceOnboarding(null, 'welcome')).rejects.toThrow('uid requerido');
  });
  test('lanza si etapa invalida', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(advanceOnboarding(UID, 'invalid_stage')).rejects.toThrow('etapa invalida');
  });
  test('avanza al siguiente stage', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await advanceOnboarding(UID, 'welcome');
    expect(r.stage).toBe('business_info');
    expect(r.completedStages).toContain('welcome');
    expect(r.isComplete).toBe(false);
  });
  test('completar whatsapp = complete', async () => {
    const data = { stage: 'whatsapp', completedStages: ['welcome','business_info','training'] };
    __setFirestoreForTests(makeMockDb({ data }));
    const r = await advanceOnboarding(UID, 'whatsapp');
    expect(r.stage).toBe('complete');
    expect(r.isComplete).toBe(true);
    expect(r.completedAt).not.toBeNull();
  });
  test('lanza si Firestore falla en set', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(advanceOnboarding(UID, 'welcome')).rejects.toThrow('set failed');
  });
});

describe('isOnboardingComplete', () => {
  test('false si stage no es complete', async () => {
    __setFirestoreForTests(makeMockDb({ data: { stage: 'training', completedStages: [] } }));
    expect(await isOnboardingComplete(UID)).toBe(false);
  });
  test('true si stage = complete', async () => {
    __setFirestoreForTests(makeMockDb({ data: { stage: 'complete', completedStages: ONBOARDING_STAGES } }));
    expect(await isOnboardingComplete(UID)).toBe(true);
  });
});

describe('resetOnboarding', () => {
  test('lanza si uid falta', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(resetOnboarding(null)).rejects.toThrow('uid requerido');
  });
  test('resetea al estado inicial', async () => {
    const mock = makeMockDb({ data: { stage: 'complete' } });
    __setFirestoreForTests(mock);
    await resetOnboarding(UID);
    const state = await getOnboardingState(UID);
    expect(state.stage).toBe('welcome');
  });
});
