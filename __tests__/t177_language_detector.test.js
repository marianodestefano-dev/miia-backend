'use strict';

const {
  detectLanguage, saveContactLanguage, getContactLanguage,
  detectAndSaveLanguage, getResponseLanguage,
  SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, CONFIDENCE_THRESHOLD,
  __setFirestoreForTests,
} = require('../core/language_detector');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';

function makeMockDb({ throwGet = false, throwSet = false, storedLang = null } = {}) {
  const contactDoc = {
    set: async (data, opts) => { if (throwSet) throw new Error('set error'); },
    get: async () => {
      if (throwGet) throw new Error('get error');
      if (storedLang) return { exists: true, data: () => ({ language: storedLang }) };
      return { exists: false, data: () => null };
    },
  };
  const contactLangColl = {
    doc: () => contactDoc,
  };
  const tenantDoc = {
    collection: () => contactLangColl,
  };
  const tenantsColl = {
    doc: () => tenantDoc,
  };
  return { collection: () => tenantsColl };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('SUPPORTED_LANGUAGES y constants', () => {
  test('incluye es, en, pt', () => {
    expect(SUPPORTED_LANGUAGES).toContain('es');
    expect(SUPPORTED_LANGUAGES).toContain('en');
    expect(SUPPORTED_LANGUAGES).toContain('pt');
  });
  test('es frozen', () => {
    expect(() => { SUPPORTED_LANGUAGES.push('xx'); }).toThrow();
  });
  test('DEFAULT_LANGUAGE es es', () => {
    expect(DEFAULT_LANGUAGE).toBe('es');
  });
  test('CONFIDENCE_THRESHOLD entre 0 y 1', () => {
    expect(CONFIDENCE_THRESHOLD).toBeGreaterThan(0);
    expect(CONFIDENCE_THRESHOLD).toBeLessThan(1);
  });
});

describe('detectLanguage', () => {
  test('lanza si text no es string', () => {
    expect(() => detectLanguage(null)).toThrow('text requerido');
    expect(() => detectLanguage(123)).toThrow('text requerido');
  });
  test('retorna default para texto muy corto', () => {
    const r = detectLanguage('hola');
    expect(r.language).toBe(DEFAULT_LANGUAGE);
    expect(r.confidence).toBe(0);
  });
  test('detecta espanol', () => {
    const r = detectLanguage('hola como estas buenas tardes quiero saber el precio');
    expect(r.language).toBe('es');
    expect(r.confidence).toBeGreaterThan(0);
  });
  test('detecta ingles', () => {
    const r = detectLanguage('hello how are you good morning what is the price please');
    expect(r.language).toBe('en');
    expect(r.confidence).toBeGreaterThan(0);
  });
  test('retorna scores para idiomas detectados', () => {
    const r = detectLanguage('hola como estas buenas tardes quiero saber el precio por favor');
    expect(typeof r.scores).toBe('object');
    expect(r.scores.es).toBeGreaterThan(0);
  });
  test('retorna default si confianza baja', () => {
    const r = detectLanguage('xyz abc def ghi jkl mno pqr stu');
    expect(r.language).toBe(DEFAULT_LANGUAGE);
  });
});

describe('saveContactLanguage', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveContactLanguage(undefined, PHONE, 'es')).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(saveContactLanguage(UID, undefined, 'es')).rejects.toThrow('phone requerido');
  });
  test('lanza si language undefined', async () => {
    await expect(saveContactLanguage(UID, PHONE, undefined)).rejects.toThrow('language requerido');
  });
  test('lanza si idioma no soportado', async () => {
    await expect(saveContactLanguage(UID, PHONE, 'xx')).rejects.toThrow('idioma no soportado');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveContactLanguage(UID, PHONE, 'en')).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(saveContactLanguage(UID, PHONE, 'en')).rejects.toThrow('set error');
  });
});


describe('getContactLanguage', () => {
  test('lanza si uid undefined', async () => {
    await expect(getContactLanguage(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(getContactLanguage(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('retorna DEFAULT si no hay idioma guardado', async () => {
    __setFirestoreForTests(makeMockDb());
    const lang = await getContactLanguage(UID, PHONE);
    expect(lang).toBe(DEFAULT_LANGUAGE);
  });
  test('retorna idioma guardado', async () => {
    __setFirestoreForTests(makeMockDb({ storedLang: 'en' }));
    const lang = await getContactLanguage(UID, PHONE);
    expect(lang).toBe('en');
  });
  test('fail-open retorna default si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const lang = await getContactLanguage(UID, PHONE);
    expect(lang).toBe(DEFAULT_LANGUAGE);
  });
});

describe('detectAndSaveLanguage', () => {
  test('lanza si uid undefined', async () => {
    await expect(detectAndSaveLanguage(undefined, PHONE, 'hola')).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(detectAndSaveLanguage(UID, undefined, 'hola')).rejects.toThrow('phone requerido');
  });
  test('lanza si message no es string', async () => {
    await expect(detectAndSaveLanguage(UID, PHONE, null)).rejects.toThrow('message requerido');
  });
  test('retorna language y confidence', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await detectAndSaveLanguage(UID, PHONE, 'hola como estas buenas tardes quiero precio');
    expect(r.language).toBeDefined();
    expect(typeof r.confidence).toBe('number');
  });
  test('saved=true si confianza alta', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await detectAndSaveLanguage(UID, PHONE, 'hola como estas buenas tardes quiero saber el precio por favor necesito ayuda');
    expect(r).toHaveProperty('saved');
  });
  test('saved=false si confianza baja', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await detectAndSaveLanguage(UID, PHONE, 'xyz abc def ghi jkl mno pqr stu');
    expect(r.saved).toBe(false);
  });
});

describe('getResponseLanguage', () => {
  test('lanza si uid undefined', async () => {
    await expect(getResponseLanguage(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(getResponseLanguage(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('usa mensaje actual si confianza alta', async () => {
    __setFirestoreForTests(makeMockDb({ storedLang: 'es' }));
    const lang = await getResponseLanguage(UID, PHONE, 'hello how are you good morning what is the price please');
    expect(lang).toBe('en');
  });
  test('usa idioma guardado si mensaje no es claro', async () => {
    __setFirestoreForTests(makeMockDb({ storedLang: 'pt' }));
    const lang = await getResponseLanguage(UID, PHONE, 'ok');
    expect(lang).toBe('pt');
  });
  test('retorna default si sin mensaje ni guardado', async () => {
    __setFirestoreForTests(makeMockDb());
    const lang = await getResponseLanguage(UID, PHONE);
    expect(lang).toBe(DEFAULT_LANGUAGE);
  });
});
