'use strict';

/**
 * T303 -- onboarding_engine unit tests (39/39)
 */

const {
  buildOnboardingRecord,
  buildStepPayload,
  validateStepCompletion,
  saveOnboarding,
  getOnboarding,
  advanceStep,
  getNextStep,
  computeProgress,
  buildOnboardingText,
  buildWelcomeMessage,
  ONBOARDING_STEPS,
  ONBOARDING_STATUSES,
  BUSINESS_TYPES,
  ONBOARDING_VERSION,
  __setFirestoreForTests,
} = require('../core/onboarding_engine');

function makeMockDb() {
  const store = {};
  return {
    store,
    db: {
      collection: () => ({
        doc: (uid) => ({
          collection: (subCol) => ({
            doc: (id) => ({
              set: async (data, opts) => {
                if (!store[uid]) store[uid] = {};
                if (!store[uid][subCol]) store[uid][subCol] = {};
                if (opts && opts.merge) {
                  store[uid][subCol][id] = { ...(store[uid][subCol][id] || {}), ...data };
                } else {
                  store[uid][subCol][id] = { ...data };
                }
              },
              get: async () => {
                const rec = store[uid] && store[uid][subCol] && store[uid][subCol][id];
                return { exists: !!rec, data: () => rec };
              },
            }),
          }),
        }),
      }),
    },
  };
}

const UID = 'owner_t303_001';

describe('T303 -- onboarding_engine (39 tests)', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    __setFirestoreForTests(mock.db);
  });

  // getNextStep / computeProgress

  test('getNextStep: null retorna primer step (welcome)', () => {
    expect(getNextStep(null)).toBe('welcome');
    expect(getNextStep(undefined)).toBe('welcome');
  });

  test('getNextStep: welcome retorna business_info', () => {
    expect(getNextStep('welcome')).toBe('business_info');
  });

  test('getNextStep: cada step avanza al siguiente', () => {
    expect(getNextStep('business_info')).toBe('whatsapp_setup');
    expect(getNextStep('whatsapp_setup')).toBe('catalog_setup');
    expect(getNextStep('catalog_setup')).toBe('personality_config');
    expect(getNextStep('personality_config')).toBe('test_conversation');
    expect(getNextStep('test_conversation')).toBe('go_live');
  });

  test('getNextStep: go_live retorna null (ultimo step)', () => {
    expect(getNextStep('go_live')).toBeNull();
  });

  test('getNextStep: step invalido retorna null', () => {
    expect(getNextStep('no_existe')).toBeNull();
  });

  test('computeProgress: array vacio retorna 0', () => {
    expect(computeProgress([])).toBe(0);
    expect(computeProgress(null)).toBe(0);
  });

  test('computeProgress: 7/7 pasos completados = 100%', () => {
    expect(computeProgress([...ONBOARDING_STEPS])).toBe(100);
  });

  test('computeProgress: pasos invalidos no cuentan', () => {
    expect(computeProgress(['welcome', 'business_info', 'no_valido'])).toBe(Math.round(2 / 7 * 100));
  });

  // buildOnboardingRecord

  test('buildOnboardingRecord: defaults correctos', () => {
    const rec = buildOnboardingRecord(UID);
    expect(rec.uid).toBe(UID);
    expect(rec.status).toBe('not_started');
    expect(rec.currentStep).toBe('welcome');
    expect(rec.completedSteps).toEqual([]);
    expect(rec.whatsappConnected).toBe(false);
    expect(rec.catalogSetup).toBe(false);
    expect(rec.testConversationDone).toBe(false);
    expect(rec.version).toBe(ONBOARDING_VERSION);
  });

  test('buildOnboardingRecord: onboardingId = uid.slice(0,8) + "_onboarding"', () => {
    const rec = buildOnboardingRecord(UID);
    expect(rec.onboardingId).toBe(UID.slice(0, 8) + '_onboarding');
  });

  test('buildOnboardingRecord: status y currentStep custom validos', () => {
    const rec = buildOnboardingRecord(UID, {
      status: 'in_progress',
      currentStep: 'catalog_setup',
      completedSteps: ['welcome', 'business_info', 'whatsapp_setup'],
    });
    expect(rec.status).toBe('in_progress');
    expect(rec.currentStep).toBe('catalog_setup');
    expect(rec.completedSteps.length).toBe(3);
  });

  test('buildOnboardingRecord: businessInfo parseado correctamente', () => {
    const rec = buildOnboardingRecord(UID, {
      businessInfo: {
        name: 'Clinica Bella',
        type: 'salud_belleza',
        description: 'Estetica y salud',
        phone: '+5411111',
        timezone: 'America/Bogota',
      },
    });
    expect(rec.businessInfo.name).toBe('Clinica Bella');
    expect(rec.businessInfo.type).toBe('salud_belleza');
    expect(rec.businessInfo.timezone).toBe('America/Bogota');
  });

  test('buildOnboardingRecord: businessType invalido default a "otro"', () => {
    const rec = buildOnboardingRecord(UID, {
      businessInfo: { name: 'Mi Negocio', type: 'tipo_raro' },
    });
    expect(rec.businessInfo.type).toBe('otro');
  });

  test('buildOnboardingRecord: completedSteps invalidos filtrados', () => {
    const rec = buildOnboardingRecord(UID, {
      completedSteps: ['welcome', 'fake_step', 'business_info'],
    });
    expect(rec.completedSteps).toEqual(['welcome', 'business_info']);
  });

  // buildStepPayload

  test('buildStepPayload: welcome retorna acknowledged+timestamp', () => {
    const payload = buildStepPayload('welcome');
    expect(payload.acknowledged).toBe(true);
    expect(typeof payload.timestamp).toBe('number');
  });

  test('buildStepPayload: business_info retorna campos del negocio', () => {
    const payload = buildStepPayload('business_info', {
      name: 'Bella Estetica', type: 'salud_belleza', phone: '+5411', timezone: 'America/Bogota',
    });
    expect(payload.name).toBe('Bella Estetica');
    expect(payload.type).toBe('salud_belleza');
    expect(payload.phone).toBe('+5411');
  });

  test('buildStepPayload: whatsapp_setup retorna connected y qrScanned', () => {
    const payload = buildStepPayload('whatsapp_setup', { connected: true, qrScanned: true });
    expect(payload.connected).toBe(true);
    expect(payload.qrScanned).toBe(true);
  });

  test('buildStepPayload: catalog_setup retorna productCount y skipped', () => {
    const payload = buildStepPayload('catalog_setup', { productCount: 5, skipped: false });
    expect(payload.productCount).toBe(5);
    expect(payload.skipped).toBe(false);
  });

  test('buildStepPayload: personality_config retorna tone, language, customInstructions', () => {
    const payload = buildStepPayload('personality_config', { tone: 'profesional', language: 'es', customInstructions: 'Siempre formal' });
    expect(payload.tone).toBe('profesional');
    expect(payload.language).toBe('es');
    expect(payload.customInstructions).toBe('Siempre formal');
  });

  test('buildStepPayload: test_conversation retorna passed y notes', () => {
    const payload = buildStepPayload('test_conversation', { passed: true, notes: 'OK' });
    expect(payload.passed).toBe(true);
    expect(payload.notes).toBe('OK');
  });

  test('buildStepPayload: go_live retorna activatedAt y channel', () => {
    const payload = buildStepPayload('go_live', { channel: 'whatsapp' });
    expect(typeof payload.activatedAt).toBe('number');
    expect(payload.channel).toBe('whatsapp');
  });

  test('buildStepPayload: step invalido lanza error', () => {
    expect(() => buildStepPayload('step_raro')).toThrow('step invalido');
  });

  // validateStepCompletion

  test('validateStepCompletion: welcome siempre valido', () => {
    expect(validateStepCompletion('welcome', {}).valid).toBe(true);
  });

  test('validateStepCompletion: business_info valido con nombre', () => {
    expect(validateStepCompletion('business_info', { name: 'Mi Negocio' }).valid).toBe(true);
  });

  test('validateStepCompletion: business_info invalido sin nombre', () => {
    const result = validateStepCompletion('business_info', { name: '' });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('business name');
  });

  test('validateStepCompletion: whatsapp_setup invalido si no conectado', () => {
    const result = validateStepCompletion('whatsapp_setup', { connected: false });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('whatsapp no conectado');
  });

  test('validateStepCompletion: test_conversation invalido si no passed', () => {
    const result = validateStepCompletion('test_conversation', { passed: false });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('no aprobado');
  });

  test('validateStepCompletion: go_live siempre valido', () => {
    expect(validateStepCompletion('go_live', {}).valid).toBe(true);
  });

  // saveOnboarding / getOnboarding

  test('saveOnboarding: guarda record y retorna onboardingId', async () => {
    const rec = buildOnboardingRecord(UID);
    const id = await saveOnboarding(UID, rec);
    expect(id).toBe(rec.onboardingId);
    const stored = mock.store[UID] && mock.store[UID]['onboarding'] && mock.store[UID]['onboarding'][rec.onboardingId];
    expect(stored).toBeDefined();
    expect(stored.uid).toBe(UID);
  });

  test('getOnboarding: retorna null si no existe registro', async () => {
    const result = await getOnboarding(UID);
    expect(result).toBeNull();
  });

  test('getOnboarding: retorna record guardado', async () => {
    const rec = buildOnboardingRecord(UID);
    await saveOnboarding(UID, rec);
    const retrieved = await getOnboarding(UID);
    expect(retrieved).not.toBeNull();
    expect(retrieved.uid).toBe(UID);
    expect(retrieved.status).toBe('not_started');
  });

  // advanceStep

  test('advanceStep: lanza error para step invalido', async () => {
    await expect(advanceStep(UID, 'no_existe', {})).rejects.toThrow('step invalido');
  });

  test('advanceStep: lanza error si validacion falla (business_info sin nombre)', async () => {
    await expect(advanceStep(UID, 'business_info', { name: '' })).rejects.toThrow('step no completado');
  });

  test('advanceStep: avanza step y retorna nextStep', async () => {
    const result = await advanceStep(UID, 'welcome', {});
    expect(result.step).toBe('welcome');
    expect(result.nextStep).toBe('business_info');
    expect(result.status).toBe('in_progress');
    expect(result.completedSteps).toContain('welcome');
  });

  test('advanceStep: go_live retorna status completed y nextStep null', async () => {
    const result = await advanceStep(UID, 'go_live', { channel: 'whatsapp' });
    expect(result.status).toBe('completed');
    expect(result.nextStep).toBeNull();
  });

  // buildOnboardingText / buildWelcomeMessage

  test('buildOnboardingText: retorna mensaje por defecto para null', () => {
    const text = buildOnboardingText(null);
    expect(text).toContain('no iniciado');
  });

  test('buildOnboardingText: contiene progreso y estado', () => {
    const rec = buildOnboardingRecord(UID, {
      status: 'in_progress',
      currentStep: 'catalog_setup',
      completedSteps: ['welcome', 'business_info', 'whatsapp_setup'],
      businessInfo: { name: 'Clinica Test', type: 'salud_belleza' },
    });
    const text = buildOnboardingText(rec);
    expect(text).toContain('in_progress');
    expect(text).toContain('catalog_setup');
    expect(text).toContain('Clinica Test');
  });

  test('buildWelcomeMessage: contiene nombre del negocio', () => {
    const msg = buildWelcomeMessage('Mi Estetica');
    expect(msg).toContain('Mi Estetica');
    expect(msg).toContain('MIIA');
  });

  test('buildWelcomeMessage: sin nombre usa "tu negocio"', () => {
    const msg = buildWelcomeMessage(null);
    expect(msg).toContain('tu negocio');
  });

  // Constantes

  test('ONBOARDING_STEPS es frozen con 7 pasos en orden correcto', () => {
    expect(Object.isFrozen(ONBOARDING_STEPS)).toBe(true);
    expect(ONBOARDING_STEPS.length).toBe(7);
    expect(ONBOARDING_STEPS[0]).toBe('welcome');
    expect(ONBOARDING_STEPS[6]).toBe('go_live');
  });

  test('ONBOARDING_STATUSES es frozen con 5 estados', () => {
    expect(Object.isFrozen(ONBOARDING_STATUSES)).toBe(true);
    expect(ONBOARDING_STATUSES.length).toBe(5);
    ['not_started','in_progress','paused','completed','failed'].forEach(s => {
      expect(ONBOARDING_STATUSES).toContain(s);
    });
  });

  test('BUSINESS_TYPES es frozen con 9 tipos incluyendo "otro"', () => {
    expect(Object.isFrozen(BUSINESS_TYPES)).toBe(true);
    expect(BUSINESS_TYPES.length).toBe(9);
    expect(BUSINESS_TYPES).toContain('otro');
    expect(BUSINESS_TYPES).toContain('salud_belleza');
    expect(BUSINESS_TYPES).toContain('ecommerce');
  });
});
