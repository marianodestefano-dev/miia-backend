'use strict';

const {
  getWizardState, submitStep, isWizardComplete, resetWizard,
  WIZARD_STEPS, STEP_INDEX, STEP_VALIDATORS,
  __setFirestoreForTests,
} = require('../core/onboarding_wizard');

const UID = 'testUid1234567890abcdef';

const VALID_DATA = {
  identity: { ownerName: 'Mariano', email: 'mariano@test.com' },
  business: { businessName: 'MiNegocio', sector: 'retail', country: 'CO' },
  catalog: { hasCatalog: true, productCount: 10 },
  whatsapp: { whatsappPhone: '+573001234567' },
  training: { trainingText: 'Hola soy MIIA' },
};

let savedState = null;

function makeMockDb({ existingState = null, throwGet = false, throwSet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => {
          if (throwGet) throw new Error('get error');
          if (!existingState) return { exists: false };
          return { exists: true, data: () => existingState };
        },
        set: async (data) => {
          if (throwSet) throw new Error('set error');
          savedState = data;
        },
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); savedState = null; });
afterEach(() => { __setFirestoreForTests(null); });

describe('WIZARD_STEPS y STEP_INDEX', () => {
  test('tiene 5 pasos en orden', () => {
    expect(WIZARD_STEPS).toEqual(['identity','business','catalog','whatsapp','training']);
    expect(WIZARD_STEPS.length).toBe(5);
  });
  test('WIZARD_STEPS es frozen', () => {
    expect(() => { WIZARD_STEPS.push('x'); }).toThrow();
  });
  test('STEP_INDEX mapea correctamente', () => {
    expect(STEP_INDEX['identity']).toBe(0);
    expect(STEP_INDEX['training']).toBe(4);
  });
});

describe('STEP_VALIDATORS', () => {
  test('identity: valida ownerName y email', () => {
    expect(STEP_VALIDATORS.identity({})).toContain('ownerName requerido');
    expect(STEP_VALIDATORS.identity({ ownerName: 'M', email: 'bad' })).toContain('email invalido');
    expect(STEP_VALIDATORS.identity(VALID_DATA.identity)).toEqual([]);
  });
  test('business: valida businessName sector country', () => {
    expect(STEP_VALIDATORS.business({})).toContain('businessName requerido');
    expect(STEP_VALIDATORS.business(VALID_DATA.business)).toEqual([]);
  });
  test('catalog: valida hasCatalog', () => {
    expect(STEP_VALIDATORS.catalog({})).toContain('hasCatalog requerido');
    expect(STEP_VALIDATORS.catalog({ hasCatalog: false })).toEqual([]);
    expect(STEP_VALIDATORS.catalog({ hasCatalog: true, productCount: -1 })).toContain('productCount debe ser numero >= 0');
    expect(STEP_VALIDATORS.catalog(VALID_DATA.catalog)).toEqual([]);
  });
  test('whatsapp: valida formato E.164', () => {
    expect(STEP_VALIDATORS.whatsapp({})).toContain('whatsappPhone requerido');
    expect(STEP_VALIDATORS.whatsapp({ whatsappPhone: 'abc' })).toContain('whatsappPhone formato invalido');
    expect(STEP_VALIDATORS.whatsapp(VALID_DATA.whatsapp)).toEqual([]);
  });
  test('training: permite texto opcional', () => {
    expect(STEP_VALIDATORS.training({})).toEqual([]);
    expect(STEP_VALIDATORS.training({ trainingText: 123 })).toContain('trainingText debe ser string');
  });
});

describe('getWizardState', () => {
  test('lanza si uid undefined', async () => {
    await expect(getWizardState(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna estado default si no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    const s = await getWizardState(UID);
    expect(s.currentStep).toBe('identity');
    expect(s.completed).toBe(false);
    expect(s.completedSteps).toEqual([]);
  });
  test('fail-open retorna estado default si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const s = await getWizardState(UID);
    expect(s.currentStep).toBe('identity');
  });
});

describe('submitStep', () => {
  test('lanza si uid undefined', async () => {
    await expect(submitStep(undefined, 'identity', {})).rejects.toThrow('uid requerido');
  });
  test('lanza si step invalido', async () => {
    await expect(submitStep(UID, 'unknown_step', {})).rejects.toThrow('step invalido');
  });
  test('lanza si data undefined', async () => {
    await expect(submitStep(UID, 'identity', undefined)).rejects.toThrow('data requerido');
  });
  test('retorna errores si validacion falla', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await submitStep(UID, 'identity', { ownerName: '', email: '' });
    expect(r.success).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.nextStep).toBe('identity');
  });
  test('avanza al siguiente paso con datos validos', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await submitStep(UID, 'identity', VALID_DATA.identity);
    expect(r.success).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.nextStep).toBe('business');
    expect(r.state.completedSteps).toContain('identity');
  });
  test('retorna nextStep=null y completed=true en ultimo paso', async () => {
    const existingState = {
      uid: UID, currentStep: 'training',
      completedSteps: ['identity','business','catalog','whatsapp'],
      stepData: {}, completed: false, startedAt: '2026-05-01T00:00:00Z', completedAt: null,
    };
    __setFirestoreForTests(makeMockDb({ existingState }));
    const r = await submitStep(UID, 'training', VALID_DATA.training);
    expect(r.success).toBe(true);
    expect(r.nextStep).toBeNull();
    expect(r.state.completed).toBe(true);
    expect(r.state.completedAt).not.toBeNull();
  });
  test('lanza si Firestore falla al guardar', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(submitStep(UID, 'identity', VALID_DATA.identity)).rejects.toThrow('set error');
  });
});

describe('isWizardComplete', () => {
  test('lanza si uid undefined', async () => {
    await expect(isWizardComplete(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna false si no completado', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await isWizardComplete(UID)).toBe(false);
  });
  test('retorna true si completed=true', async () => {
    const state = { completed: true, completedSteps: [], stepData: {}, currentStep: 'training', uid: UID, startedAt: '', completedAt: '' };
    __setFirestoreForTests(makeMockDb({ existingState: state }));
    expect(await isWizardComplete(UID)).toBe(true);
  });
});

describe('resetWizard', () => {
  test('lanza si uid undefined', async () => {
    await expect(resetWizard(undefined)).rejects.toThrow('uid requerido');
  });
  test('resetea a estado inicial', async () => {
    __setFirestoreForTests(makeMockDb());
    const s = await resetWizard(UID);
    expect(s.currentStep).toBe('identity');
    expect(s.completed).toBe(false);
    expect(s.completedSteps).toEqual([]);
  });
  test('lanza si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(resetWizard(UID)).rejects.toThrow('set error');
  });
});
