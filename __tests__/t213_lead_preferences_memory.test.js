'use strict';

const {
  isValidPreferenceType, savePreference, getPreference,
  getAllPreferences, deletePreference, buildPreferenceContextHint,
  PREFERENCE_TYPES, MAX_PREFERENCES_PER_LEAD, PREFERENCE_TTL_DAYS,
  __setFirestoreForTests,
} = require('../core/lead_preferences_memory');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';

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

describe('PREFERENCE_TYPES / consts', () => {
  test('tiene tipos comunes', () => {
    expect(PREFERENCE_TYPES).toContain('language');
    expect(PREFERENCE_TYPES).toContain('tone');
    expect(PREFERENCE_TYPES).toContain('budget');
  });
  test('es frozen', () => {
    expect(() => { PREFERENCE_TYPES.push('secreto'); }).toThrow();
  });
  test('MAX_PREFERENCES_PER_LEAD y PREFERENCE_TTL_DAYS definidos', () => {
    expect(MAX_PREFERENCES_PER_LEAD).toBeGreaterThan(0);
    expect(PREFERENCE_TTL_DAYS).toBeGreaterThan(0);
  });
});

describe('isValidPreferenceType', () => {
  test('true para tipos validos', () => {
    expect(isValidPreferenceType('language')).toBe(true);
    expect(isValidPreferenceType('budget')).toBe(true);
  });
  test('false para tipo invalido', () => {
    expect(isValidPreferenceType('secreto')).toBe(false);
  });
});

describe('savePreference', () => {
  test('lanza si uid undefined', async () => {
    await expect(savePreference(undefined, PHONE, 'language', 'es')).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(savePreference(UID, undefined, 'language', 'es')).rejects.toThrow('phone requerido');
  });
  test('lanza si type invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(savePreference(UID, PHONE, 'secreto', 'val')).rejects.toThrow('type invalido');
  });
  test('lanza si value undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(savePreference(UID, PHONE, 'language', undefined)).rejects.toThrow('value requerido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(savePreference(UID, PHONE, 'language', 'es')).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(savePreference(UID, PHONE, 'language', 'es')).rejects.toThrow('set error');
  });
});

describe('getPreference', () => {
  test('lanza si uid undefined', async () => {
    await expect(getPreference(undefined, PHONE, 'language')).rejects.toThrow('uid requerido');
  });
  test('retorna null si no hay datos', async () => {
    __setFirestoreForTests(makeMockDb());
    const v = await getPreference(UID, PHONE, 'language');
    expect(v).toBeNull();
  });
  test('retorna valor guardado', async () => {
    const now = new Date().toISOString();
    __setFirestoreForTests(makeMockDb({ existingData: { language: { value: 'es', updatedAt: now } } }));
    const v = await getPreference(UID, PHONE, 'language');
    expect(v).toBe('es');
  });
  test('fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const v = await getPreference(UID, PHONE, 'language');
    expect(v).toBeNull();
  });
});

describe('getAllPreferences', () => {
  test('lanza si uid undefined', async () => {
    await expect(getAllPreferences(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('retorna objeto vacio si no hay datos', async () => {
    __setFirestoreForTests(makeMockDb());
    const prefs = await getAllPreferences(UID, PHONE);
    expect(prefs).toEqual({});
  });
  test('retorna preferencias vigentes', async () => {
    const now = new Date().toISOString();
    __setFirestoreForTests(makeMockDb({ existingData: {
      language: { value: 'es', updatedAt: now },
      budget: { value: '500', updatedAt: now },
    }}));
    const prefs = await getAllPreferences(UID, PHONE);
    expect(prefs.language).toBe('es');
    expect(prefs.budget).toBe('500');
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const prefs = await getAllPreferences(UID, PHONE);
    expect(prefs).toEqual({});
  });
});

describe('buildPreferenceContextHint', () => {
  test('retorna string vacio si prefs vacio', () => {
    expect(buildPreferenceContextHint({})).toBe('');
  });
  test('incluye idioma y tono', () => {
    const hint = buildPreferenceContextHint({ language: 'es', tone: 'formal' });
    expect(hint).toContain('es');
    expect(hint).toContain('formal');
  });
  test('incluye presupuesto si definido', () => {
    const hint = buildPreferenceContextHint({ budget: '$500' });
    expect(hint).toContain('$500');
  });
  test('retorna string vacio si prefs undefined', () => {
    expect(buildPreferenceContextHint(undefined)).toBe('');
  });
});
