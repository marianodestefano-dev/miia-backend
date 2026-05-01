'use strict';

// T261 onboarding_engine — suite completa
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
  __setFirestoreForTests: setDb,
} = require('../core/onboarding_engine');

const UID = 'onboarding261Uid';

function makeMockDb({ stored = {}, throwGet = false, throwSet = false } = {}) {
  const db_stored = { ...stored };
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              db_stored[id] = opts && opts.merge ? { ...(db_stored[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { exists: !!db_stored[id], data: () => db_stored[id] };
            },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => setDb(null));
afterEach(() => setDb(null));

// ─── CONSTANTES ──────────────────────────────────────────────────────────────
describe('onboarding_engine — constantes', () => {
  test('ONBOARDING_STEPS tiene 7 pasos en orden', () => {
    expect(ONBOARDING_STEPS[0]).toBe('welcome');
    expect(ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1]).toBe('go_live');
    expect(ONBOARDING_STEPS.length).toBe(7);
  });
  test('ONBOARDING_STATUSES tiene completed e in_progress', () => {
    expect(ONBOARDING_STATUSES).toContain('completed');
    expect(ONBOARDING_STATUSES).toContain('in_progress');
    expect(ONBOARDING_STATUSES).toContain('not_started');
  });
  test('BUSINESS_TYPES tiene ecommerce y servicios_profesionales', () => {
    expect(BUSINESS_TYPES).toContain('ecommerce');
    expect(BUSINESS_TYPES).toContain('servicios_profesionales');
  });
  test('ONBOARDING_VERSION definido', () => {
    expect(ONBOARDING_VERSION).toBeDefined();
    expect(typeof ONBOARDING_VERSION).toBe('string');
  });
});

// ─── getNextStep ─────────────────────────────────────────────────────────────
describe('getNextStep', () => {
  test('welcome -> business_info', () => {
    expect(getNextStep('welcome')).toBe('business_info');
  });
  test('ultimo paso retorna null', () => {
    expect(getNextStep('go_live')).toBeNull();
  });
  test('undefined retorna primer paso', () => {
    expect(getNextStep(undefined)).toBe('welcome');
  });
  test('step invalido retorna null', () => {
    expect(getNextStep('paso_fake')).toBeNull();
  });
  test('business_info -> whatsapp_setup', () => {
    expect(getNextStep('business_info')).toBe('whatsapp_setup');
  });
});

// ─── computeProgress ─────────────────────────────────────────────────────────
describe('computeProgress', () => {
  test('sin pasos = 0%', () => {
    expect(computeProgress([])).toBe(0);
  });
  test('todos los pasos = 100%', () => {
    expect(computeProgress([...ONBOARDING_STEPS])).toBe(100);
  });
  test('pasos invalidos no cuentan', () => {
    expect(computeProgress(['welcome', 'paso_fake'])).toBe(Math.round(1/7*100));
  });
  test('null retorna 0', () => {
    expect(computeProgress(null)).toBe(0);
  });
  test('3 de 7 pasos = ~43%', () => {
    const progress = computeProgress(['welcome', 'business_info', 'whatsapp_setup']);
    expect(progress).toBe(Math.round(3/7*100));
  });
});

// ─── buildOnboardingRecord ────────────────────────────────────────────────────
describe('buildOnboardingRecord', () => {
  test('defaults correctos', () => {
    const r = buildOnboardingRecord(UID);
    expect(r.uid).toBe(UID);
    expect(r.status).toBe('not_started');
    expect(r.currentStep).toBe('welcome');
    expect(r.completedSteps).toEqual([]);
    expect(r.whatsappConnected).toBe(false);
    expect(r.catalogSetup).toBe(false);
    expect(r.version).toBe(ONBOARDING_VERSION);
  });
  test('status invalido cae a not_started', () => {
    const r = buildOnboardingRecord(UID, { status: 'borrado' });
    expect(r.status).toBe('not_started');
  });
  test('currentStep invalido cae a welcome', () => {
    const r = buildOnboardingRecord(UID, { currentStep: 'paso_fake' });
    expect(r.currentStep).toBe('welcome');
  });
  test('businessInfo se construye correctamente', () => {
    const r = buildOnboardingRecord(UID, {
      businessInfo: { name: 'Mi Negocio', type: 'retail', phone: '+5491155554444' },
    });
    expect(r.businessInfo.name).toBe('Mi Negocio');
    expect(r.businessInfo.type).toBe('retail');
    expect(r.businessInfo.phone).toBe('+5491155554444');
  });
  test('businessInfo.type invalido cae a otro', () => {
    const r = buildOnboardingRecord(UID, { businessInfo: { name: 'X', type: 'fake_type' } });
    expect(r.businessInfo.type).toBe('otro');
  });
  test('completedSteps filtra invalidos', () => {
    const r = buildOnboardingRecord(UID, { completedSteps: ['welcome', 'paso_fake', 'business_info'] });
    expect(r.completedSteps).toEqual(['welcome', 'business_info']);
  });
  test('onboardingId generado desde uid', () => {
    const r = buildOnboardingRecord(UID);
    expect(r.onboardingId).toBe(UID.slice(0, 8) + '_onboarding');
  });
});

// ─── buildStepPayload ─────────────────────────────────────────────────────────
describe('buildStepPayload', () => {
  test('welcome retorna acknowledged=true', () => {
    const p = buildStepPayload('welcome');
    expect(p.acknowledged).toBe(true);
  });
  test('business_info con datos completos', () => {
    const p = buildStepPayload('business_info', { name: 'TiendaX', type: 'retail', phone: '+5491100000000' });
    expect(p.name).toBe('TiendaX');
    expect(p.type).toBe('retail');
    expect(p.phone).toBe('+5491100000000');
  });
  test('business_info type invalido cae a otro', () => {
    const p = buildStepPayload('business_info', { name: 'X', type: 'invalid' });
    expect(p.type).toBe('otro');
  });
  test('whatsapp_setup con connected=true', () => {
    const p = buildStepPayload('whatsapp_setup', { connected: true });
    expect(p.connected).toBe(true);
  });
  test('catalog_setup con productCount', () => {
    const p = buildStepPayload('catalog_setup', { productCount: 5 });
    expect(p.productCount).toBe(5);
  });
  test('personality_config defaults', () => {
    const p = buildStepPayload('personality_config', {});
    expect(p.tone).toBe('amigable');
    expect(p.language).toBe('es');
  });
  test('test_conversation con passed=true', () => {
    const p = buildStepPayload('test_conversation', { passed: true, notes: 'todo bien' });
    expect(p.passed).toBe(true);
    expect(p.notes).toBe('todo bien');
  });
  test('go_live con channel', () => {
    const p = buildStepPayload('go_live', { channel: 'whatsapp' });
    expect(p.channel).toBe('whatsapp');
    expect(p.activatedAt).toBeDefined();
  });
  test('step invalido lanza error', () => {
    expect(() => buildStepPayload('paso_fake')).toThrow('step invalido');
  });
});

// ─── validateStepCompletion ───────────────────────────────────────────────────
describe('validateStepCompletion', () => {
  test('welcome siempre valido', () => {
    expect(validateStepCompletion('welcome', {}).valid).toBe(true);
  });
  test('business_info sin name es invalido', () => {
    const r = validateStepCompletion('business_info', { name: '' });
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('business name');
  });
  test('business_info con name es valido', () => {
    expect(validateStepCompletion('business_info', { name: 'Mi Tienda' }).valid).toBe(true);
  });
  test('whatsapp_setup con connected=false es invalido', () => {
    const r = validateStepCompletion('whatsapp_setup', { connected: false });
    expect(r.valid).toBe(false);
  });
  test('whatsapp_setup con connected=true es valido', () => {
    expect(validateStepCompletion('whatsapp_setup', { connected: true }).valid).toBe(true);
  });
  test('catalog_setup siempre valido (puede saltarse)', () => {
    expect(validateStepCompletion('catalog_setup', { skipped: true }).valid).toBe(true);
  });
  test('test_conversation con passed=false es invalido', () => {
    const r = validateStepCompletion('test_conversation', { passed: false });
    expect(r.valid).toBe(false);
  });
  test('test_conversation con passed=true es valido', () => {
    expect(validateStepCompletion('test_conversation', { passed: true }).valid).toBe(true);
  });
  test('go_live siempre valido', () => {
    expect(validateStepCompletion('go_live', {}).valid).toBe(true);
  });
  test('step desconocido es invalido', () => {
    const r = validateStepCompletion('paso_fake', {});
    expect(r.valid).toBe(false);
  });
});

// ─── saveOnboarding + getOnboarding ──────────────────────────────────────────
describe('saveOnboarding + getOnboarding', () => {
  test('round-trip exitoso', async () => {
    const db = makeMockDb();
    setDb(db);
    const r = buildOnboardingRecord(UID, { status: 'in_progress', currentStep: 'business_info' });
    const savedId = await saveOnboarding(UID, r);
    expect(savedId).toBe(r.onboardingId);
    const loaded = await getOnboarding(UID);
    expect(loaded.status).toBe('in_progress');
    expect(loaded.currentStep).toBe('business_info');
  });
  test('getOnboarding retorna null si no existe', async () => {
    setDb(makeMockDb());
    const loaded = await getOnboarding(UID);
    expect(loaded).toBeNull();
  });
  test('saveOnboarding con throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    const r = buildOnboardingRecord(UID);
    await expect(saveOnboarding(UID, r)).rejects.toThrow('set error');
  });
  test('getOnboarding con throwGet retorna null', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const loaded = await getOnboarding(UID);
    expect(loaded).toBeNull();
  });
});

// ─── advanceStep ─────────────────────────────────────────────────────────────
describe('advanceStep', () => {
  test('avanza de welcome a business_info', async () => {
    const db = makeMockDb();
    setDb(db);
    const r = await advanceStep(UID, 'welcome', { acknowledged: true });
    expect(r.step).toBe('welcome');
    expect(r.nextStep).toBe('business_info');
    expect(r.status).toBe('in_progress');
    expect(r.completedSteps).toContain('welcome');
  });
  test('avanza whatsapp_setup con connected=true', async () => {
    const initStored = {};
    initStored[UID.slice(0,8) + '_onboarding'] = {
      completedSteps: ['welcome', 'business_info'],
      currentStep: 'whatsapp_setup',
    };
    setDb(makeMockDb({ stored: initStored }));
    const r = await advanceStep(UID, 'whatsapp_setup', { connected: true });
    expect(r.nextStep).toBe('catalog_setup');
  });
  test('whatsapp_setup con connected=false lanza error', async () => {
    setDb(makeMockDb());
    await expect(advanceStep(UID, 'whatsapp_setup', { connected: false }))
      .rejects.toThrow('step no completado');
  });
  test('go_live completa el onboarding (status=completed)', async () => {
    const initStored = {};
    initStored[UID.slice(0,8) + '_onboarding'] = {
      completedSteps: ONBOARDING_STEPS.slice(0, -1),
      currentStep: 'go_live',
    };
    setDb(makeMockDb({ stored: initStored }));
    const r = await advanceStep(UID, 'go_live', {});
    expect(r.status).toBe('completed');
    expect(r.nextStep).toBeNull();
  });
  test('step invalido lanza error', async () => {
    setDb(makeMockDb());
    await expect(advanceStep(UID, 'paso_fake', {})).rejects.toThrow('step invalido');
  });
  test('throwSet en advanceStep lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    await expect(advanceStep(UID, 'welcome', {})).rejects.toThrow('set error');
  });
  test('completedSteps acumula pasos sin duplicar', async () => {
    const initStored = {};
    initStored[UID.slice(0,8) + '_onboarding'] = { completedSteps: ['welcome'] };
    setDb(makeMockDb({ stored: initStored }));
    const r = await advanceStep(UID, 'welcome', { acknowledged: true });
    expect(r.completedSteps.filter(s => s === 'welcome').length).toBe(1);
  });
});

// ─── buildOnboardingText ──────────────────────────────────────────────────────
describe('buildOnboardingText', () => {
  test('retorna mensaje si record es null', () => {
    expect(buildOnboardingText(null)).toContain('no iniciado');
  });
  test('incluye progreso y estado', () => {
    const r = buildOnboardingRecord(UID, {
      status: 'in_progress',
      currentStep: 'catalog_setup',
      completedSteps: ['welcome', 'business_info', 'whatsapp_setup'],
    });
    const text = buildOnboardingText(r);
    expect(text).toContain('in_progress');
    expect(text).toContain('catalog_setup');
    expect(text).toContain('%');
  });
  test('incluye nombre del negocio si existe', () => {
    const r = buildOnboardingRecord(UID, {
      businessInfo: { name: 'CorteStyle', type: 'salud_belleza' },
    });
    const text = buildOnboardingText(r);
    expect(text).toContain('CorteStyle');
  });
  test('indica whatsapp conectado', () => {
    const r = buildOnboardingRecord(UID, { whatsappConnected: true });
    const text = buildOnboardingText(r);
    expect(text).toContain('WhatsApp conectado');
  });
});

// ─── buildWelcomeMessage ──────────────────────────────────────────────────────
describe('buildWelcomeMessage', () => {
  test('incluye nombre del negocio', () => {
    const msg = buildWelcomeMessage('CorteStyle');
    expect(msg).toContain('CorteStyle');
  });
  test('sin nombre usa placeholder', () => {
    const msg = buildWelcomeMessage(null);
    expect(msg).toContain('tu negocio');
  });
  test('menciona whatsapp y catalogo', () => {
    const msg = buildWelcomeMessage('X');
    expect(msg.toLowerCase()).toContain('whatsapp');
    expect(msg.toLowerCase()).toContain('cat');
  });
  test('tiene largo razonable', () => {
    const msg = buildWelcomeMessage('TestBiz');
    expect(msg.length).toBeGreaterThan(50);
  });
});
