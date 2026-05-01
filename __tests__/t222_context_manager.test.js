'use strict';

const {
  isValidMode, isValidRestriction, validateContextConfig,
  setContext, getContext, buildContextPrompt, isTopicAllowed,
  CONTEXT_MODES, CONTEXT_RESTRICTIONS, DEFAULT_CONTEXT,
  __setFirestoreForTests,
} = require('../core/context_manager');

const UID = 'testUid1234567890';

function makeMockDb({ existingData = null, throwGet = false, throwSet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              if (!existingData) return { exists: false, data: () => ({}) };
              return { exists: true, data: () => existingData };
            },
            set: async () => { if (throwSet) throw new Error('set error'); },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('CONTEXT_MODES / CONTEXT_RESTRICTIONS / DEFAULT_CONTEXT', () => {
  test('tiene modos comunes', () => {
    expect(CONTEXT_MODES).toContain('auto');
    expect(CONTEXT_MODES).toContain('sales');
    expect(CONTEXT_MODES).toContain('support');
    expect(CONTEXT_MODES).toContain('ooo');
  });
  test('CONTEXT_MODES es frozen', () => {
    expect(() => { CONTEXT_MODES.push('hacker'); }).toThrow();
  });
  test('tiene restricciones comunes', () => {
    expect(CONTEXT_RESTRICTIONS).toContain('no_pricing');
    expect(CONTEXT_RESTRICTIONS).toContain('human_only');
  });
  test('DEFAULT_CONTEXT tiene modo auto', () => {
    expect(DEFAULT_CONTEXT.mode).toBe('auto');
  });
});

describe('isValidMode / isValidRestriction', () => {
  test('true para modo valido', () => {
    expect(isValidMode('sales')).toBe(true);
    expect(isValidMode('ooo')).toBe(true);
  });
  test('false para modo invalido', () => {
    expect(isValidMode('robot_attack')).toBe(false);
  });
  test('true para restriccion valida', () => {
    expect(isValidRestriction('no_pricing')).toBe(true);
  });
  test('false para restriccion invalida', () => {
    expect(isValidRestriction('permitir_todo')).toBe(false);
  });
});

describe('validateContextConfig', () => {
  test('invalido si no es objeto', () => {
    expect(validateContextConfig('no')).toMatchObject({ valid: false });
  });
  test('valido para objeto vacio', () => {
    expect(validateContextConfig({}).valid).toBe(true);
  });
  test('invalido con mode desconocido', () => {
    expect(validateContextConfig({ mode: 'hackeo' }).valid).toBe(false);
  });
  test('invalido con restriction desconocida', () => {
    expect(validateContextConfig({ restrictions: ['permitir_todo'] }).valid).toBe(false);
  });
  test('valido con modo y restricciones correctas', () => {
    expect(validateContextConfig({ mode: 'sales', restrictions: ['no_pricing'] }).valid).toBe(true);
  });
  test('invalido con restrictions no array', () => {
    expect(validateContextConfig({ restrictions: 'no_pricing' }).valid).toBe(false);
  });
});

describe('setContext', () => {
  test('lanza si uid undefined', async () => {
    await expect(setContext(undefined, {})).rejects.toThrow('uid requerido');
  });
  test('lanza si config invalida', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(setContext(UID, { mode: 'hacker' })).rejects.toThrow('config invalida');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(setContext(UID, { mode: 'sales' })).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(setContext(UID, { mode: 'sales' })).rejects.toThrow('set error');
  });
});

describe('getContext', () => {
  test('lanza si uid undefined', async () => {
    await expect(getContext(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna DEFAULT si no hay datos', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getContext(UID);
    expect(r.mode).toBe('auto');
  });
  test('retorna contexto guardado', async () => {
    __setFirestoreForTests(makeMockDb({ existingData: { mode: 'support', restrictions: ['no_pricing'] } }));
    const r = await getContext(UID);
    expect(r.mode).toBe('support');
  });
  test('retorna DEFAULT si contexto expirado', async () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    __setFirestoreForTests(makeMockDb({ existingData: { mode: 'ooo', expiresAt: past } }));
    const r = await getContext(UID);
    expect(r.mode).toBe('auto');
  });
  test('fail-open retorna DEFAULT si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getContext(UID);
    expect(r.mode).toBe('auto');
  });
});

describe('buildContextPrompt', () => {
  test('retorna string vacio si config undefined', () => {
    expect(buildContextPrompt(undefined)).toBe('');
  });
  test('incluye modo activo', () => {
    const p = buildContextPrompt({ mode: 'sales' });
    expect(p).toContain('sales');
  });
  test('incluye restricciones', () => {
    const p = buildContextPrompt({ mode: 'support', restrictions: ['no_pricing', 'no_catalog'] });
    expect(p).toContain('no_pricing');
    expect(p).toContain('no_catalog');
  });
  test('incluye custom system prompt', () => {
    const p = buildContextPrompt({ customSystemPrompt: 'Eres un experto en finanzas.' });
    expect(p).toContain('finanzas');
  });
  test('no incluye modo si es auto', () => {
    const p = buildContextPrompt({ mode: 'auto' });
    expect(p).not.toContain('auto');
  });
});

describe('isTopicAllowed', () => {
  test('permite todo si no hay config', () => {
    expect(isTopicAllowed('pricing', undefined)).toBe(true);
  });
  test('bloquea topic en blockedTopics', () => {
    expect(isTopicAllowed('pricing', { blockedTopics: ['pricing'] })).toBe(false);
  });
  test('permite topic no bloqueado', () => {
    expect(isTopicAllowed('delivery', { blockedTopics: ['pricing'] })).toBe(true);
  });
  test('bloquea topic no en allowedTopics', () => {
    expect(isTopicAllowed('pricing', { allowedTopics: ['delivery'] })).toBe(false);
  });
  test('permite topic en allowedTopics', () => {
    expect(isTopicAllowed('delivery', { allowedTopics: ['delivery', 'hours'] })).toBe(true);
  });
});
