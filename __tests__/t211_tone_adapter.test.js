'use strict';

const {
  getDefaultTone, isValidTone, getToneProfile, applyTone,
  saveTonePreference, getTonePreference,
  TONE_PROFILES, CONTACT_TYPE_TONES, DEFAULT_TONE,
  __setFirestoreForTests,
} = require('../core/tone_adapter');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';

function makeMockDb({ existingTone = null, throwGet = false, throwSet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              if (!existingTone) return { exists: false, data: () => ({}) };
              return { exists: true, data: () => ({ tone: existingTone }) };
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

describe('TONE_PROFILES / CONTACT_TYPE_TONES / DEFAULT_TONE', () => {
  test('tiene perfiles friendly formal casual', () => {
    expect(TONE_PROFILES.friendly).toBeDefined();
    expect(TONE_PROFILES.formal).toBeDefined();
    expect(TONE_PROFILES.casual).toBeDefined();
  });
  test('TONE_PROFILES es frozen', () => {
    expect(() => { TONE_PROFILES.nuevo = {}; }).toThrow();
  });
  test('CONTACT_TYPE_TONES mapea tipos comunes', () => {
    expect(CONTACT_TYPE_TONES.vip).toBeDefined();
    expect(CONTACT_TYPE_TONES.lead).toBeDefined();
    expect(CONTACT_TYPE_TONES.enterprise).toBeDefined();
  });
  test('DEFAULT_TONE es friendly', () => {
    expect(DEFAULT_TONE).toBe('friendly');
  });
});

describe('getDefaultTone', () => {
  test('retorna tono correcto para vip', () => {
    expect(getDefaultTone('vip')).toBe('warm');
  });
  test('retorna tono correcto para enterprise', () => {
    expect(getDefaultTone('enterprise')).toBe('formal');
  });
  test('fallback a DEFAULT_TONE para tipo desconocido', () => {
    expect(getDefaultTone('extraterrestrial')).toBe(DEFAULT_TONE);
  });
});

describe('isValidTone', () => {
  test('true para tonos validos', () => {
    expect(isValidTone('formal')).toBe(true);
    expect(isValidTone('friendly')).toBe(true);
  });
  test('false para tono invalido', () => {
    expect(isValidTone('agresivo')).toBe(false);
  });
});

describe('getToneProfile', () => {
  test('retorna perfil correcto', () => {
    const p = getToneProfile('formal');
    expect(p.style).toBe('usted');
    expect(p.emojiLevel).toBe(0);
  });
  test('fallback a friendly para tono desconocido', () => {
    const p = getToneProfile('unknown_tone');
    expect(p).toEqual(TONE_PROFILES[DEFAULT_TONE]);
  });
});

describe('applyTone', () => {
  test('lanza si message undefined', () => {
    expect(() => applyTone(undefined, 'friendly')).toThrow('message requerido');
  });
  test('retorna mensaje sin modificar por default', () => {
    const result = applyTone('Hola amigo', 'friendly');
    expect(result).toBe('Hola amigo');
  });
  test('agrega saludo si addGreeting', () => {
    const result = applyTone('como estas?', 'friendly', { addGreeting: true });
    expect(result).toContain('Hola');
    expect(result).toContain('como estas?');
  });
  test('agrega cierre si addClosing', () => {
    const result = applyTone('El pedido llega manana', 'formal', { addClosing: true });
    expect(result).toContain('El pedido llega manana');
    expect(result).toContain('disposicion');
  });
});

describe('saveTonePreference', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveTonePreference(undefined, PHONE, 'friendly')).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(saveTonePreference(UID, undefined, 'friendly')).rejects.toThrow('phone requerido');
  });
  test('lanza si tone invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveTonePreference(UID, PHONE, 'grosero')).rejects.toThrow('tone invalido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveTonePreference(UID, PHONE, 'formal')).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(saveTonePreference(UID, PHONE, 'formal')).rejects.toThrow('set error');
  });
});

describe('getTonePreference', () => {
  test('lanza si uid undefined', async () => {
    await expect(getTonePreference(undefined, PHONE, 'lead')).rejects.toThrow('uid requerido');
  });
  test('retorna tono guardado si existe', async () => {
    __setFirestoreForTests(makeMockDb({ existingTone: 'formal' }));
    const t = await getTonePreference(UID, PHONE, 'lead');
    expect(t).toBe('formal');
  });
  test('retorna tono default segun contactType si no hay guardado', async () => {
    __setFirestoreForTests(makeMockDb());
    const t = await getTonePreference(UID, PHONE, 'enterprise');
    expect(t).toBe('formal');
  });
  test('fail-open retorna default si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const t = await getTonePreference(UID, PHONE, 'lead');
    expect(t).toBe(getDefaultTone('lead'));
  });
});
