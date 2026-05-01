'use strict';

const {
  validatePersona, mergeWithDefault, savePersona, getPersona,
  resetToDefault, buildPersonaPromptHint,
  DEFAULT_PERSONA, ALLOWED_STYLES, MAX_FIELD_LENGTH,
  __setFirestoreForTests,
} = require('../core/miia_persona_config');

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

describe('DEFAULT_PERSONA / ALLOWED_STYLES', () => {
  test('DEFAULT_PERSONA tiene name MIIA', () => {
    expect(DEFAULT_PERSONA.name).toBe('MIIA');
  });
  test('DEFAULT_PERSONA es frozen', () => {
    expect(() => { DEFAULT_PERSONA.name = 'otro'; }).toThrow();
  });
  test('ALLOWED_STYLES contiene friendly formal', () => {
    expect(ALLOWED_STYLES).toContain('friendly');
    expect(ALLOWED_STYLES).toContain('formal');
  });
  test('ALLOWED_STYLES es frozen', () => {
    expect(() => { ALLOWED_STYLES.push('agresivo'); }).toThrow();
  });
});

describe('validatePersona', () => {
  test('retorna invalid si no es objeto', () => {
    expect(validatePersona('no')).toEqual(expect.objectContaining({ valid: false }));
  });
  test('valido para objeto vacio', () => {
    expect(validatePersona({}).valid).toBe(true);
  });
  test('valido con nombre correcto', () => {
    expect(validatePersona({ name: 'Sofia' }).valid).toBe(true);
  });
  test('invalido con name vacio', () => {
    expect(validatePersona({ name: '' }).valid).toBe(false);
  });
  test('invalido con style desconocido', () => {
    expect(validatePersona({ style: 'robot' }).valid).toBe(false);
  });
  test('invalido con greeting muy largo', () => {
    expect(validatePersona({ greeting: 'a'.repeat(MAX_FIELD_LENGTH + 1) }).valid).toBe(false);
  });
  test('valido con greeting null', () => {
    expect(validatePersona({ greeting: null }).valid).toBe(true);
  });
});

describe('mergeWithDefault', () => {
  test('merge con nombre custom', () => {
    const p = mergeWithDefault({ name: 'Luna' });
    expect(p.name).toBe('Luna');
    expect(p.style).toBe(DEFAULT_PERSONA.style);
  });
  test('merge con todos los campos', () => {
    const p = mergeWithDefault({ name: 'Sofia', style: 'formal', hideAI: true });
    expect(p.name).toBe('Sofia');
    expect(p.style).toBe('formal');
    expect(p.hideAI).toBe(true);
  });
});

describe('savePersona', () => {
  test('lanza si uid undefined', async () => {
    await expect(savePersona(undefined, {})).rejects.toThrow('uid requerido');
  });
  test('lanza si persona undefined', async () => {
    await expect(savePersona(UID, undefined)).rejects.toThrow('persona requerido');
  });
  test('lanza si persona invalida', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(savePersona(UID, { name: '' })).rejects.toThrow('persona invalida');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(savePersona(UID, { name: 'Sofia', style: 'friendly' })).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(savePersona(UID, { name: 'Sofia' })).rejects.toThrow('set error');
  });
});

describe('getPersona', () => {
  test('lanza si uid undefined', async () => {
    await expect(getPersona(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna DEFAULT si no hay guardado', async () => {
    __setFirestoreForTests(makeMockDb());
    const p = await getPersona(UID);
    expect(p.name).toBe('MIIA');
  });
  test('retorna persona guardada', async () => {
    __setFirestoreForTests(makeMockDb({ existingData: { name: 'Luna', style: 'formal' } }));
    const p = await getPersona(UID);
    expect(p.name).toBe('Luna');
    expect(p.style).toBe('formal');
  });
  test('fail-open retorna DEFAULT si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const p = await getPersona(UID);
    expect(p.name).toBe('MIIA');
  });
});

describe('buildPersonaPromptHint', () => {
  test('incluye nombre en el hint', () => {
    const hint = buildPersonaPromptHint({ name: 'Sofia', style: 'friendly' });
    expect(hint).toContain('Sofia');
  });
  test('incluye estilo en el hint', () => {
    const hint = buildPersonaPromptHint({ style: 'formal' });
    expect(hint).toContain('formal');
  });
  test('incluye hideAI si activo', () => {
    const hint = buildPersonaPromptHint({ hideAI: true });
    expect(hint).toContain('No menciones');
  });
  test('no incluye hideAI si false', () => {
    const hint = buildPersonaPromptHint({ hideAI: false });
    expect(hint).not.toContain('No menciones');
  });
  test('retorna string vacio si persona undefined', () => {
    expect(buildPersonaPromptHint(undefined)).toBe('');
  });
});
