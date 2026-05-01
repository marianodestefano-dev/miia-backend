'use strict';

const {
  translateTexts, translateCatalogItem, translateCatalog,
  invalidateTranslationCache,
  SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, TRANSLATABLE_FIELDS,
  __setFirestoreForTests, __setTranslateClientForTests,
} = require('../core/catalog_translator');

const UID = 'testUid1234567890';

function makeMockDb({ items = [], cachedTranslation = null, throwSet = false } = {}) {
  const catalogColl = {
    get: async () => {
      const docs = items.map((item, i) => ({ id: 'item' + i, data: () => item }));
      return { forEach: fn => docs.forEach(fn) };
    },
  };
  const cacheDoc = {
    get: async () => {
      if (cachedTranslation) {
        return { exists: true, data: () => ({ items: cachedTranslation, cachedAt: new Date().toISOString() }) };
      }
      return { exists: false, data: () => null };
    },
    set: async (data) => { if (throwSet) throw new Error('set error'); },
  };
  return {
    collection: (name) => {
      if (name === 'catalog_translations') return { doc: () => cacheDoc };
      return {
        doc: (uid) => ({
          collection: (sub) => {
            if (sub === 'catalog') return catalogColl;
            return { doc: () => cacheDoc };
          },
        }),
      };
    },
  };
}

function makeTranslateClient(responseTexts) {
  return async (texts, lang, key, signal) => responseTexts.slice(0, texts.length);
}

beforeEach(() => {
  __setFirestoreForTests(null);
  __setTranslateClientForTests(null);
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
});
afterEach(() => {
  __setFirestoreForTests(null);
  __setTranslateClientForTests(null);
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
});

describe('TRANSLATABLE_FIELDS y constants', () => {
  test('incluye name, description, category', () => {
    expect(TRANSLATABLE_FIELDS).toContain('name');
    expect(TRANSLATABLE_FIELDS).toContain('description');
    expect(TRANSLATABLE_FIELDS).toContain('category');
  });
  test('es frozen', () => {
    expect(() => { TRANSLATABLE_FIELDS.push('xxx'); }).toThrow();
  });
  test('SUPPORTED_LANGUAGES es frozen', () => {
    expect(() => { SUPPORTED_LANGUAGES.push('xx'); }).toThrow();
  });
});

describe('translateTexts', () => {
  test('lanza si texts no es array', async () => {
    await expect(translateTexts('texto', 'en')).rejects.toThrow('debe ser array');
  });
  test('lanza si targetLanguage undefined', async () => {
    await expect(translateTexts(['hola'], undefined)).rejects.toThrow('targetLanguage requerido');
  });
  test('lanza si idioma no soportado', async () => {
    await expect(translateTexts(['hola'], 'xx')).rejects.toThrow('idioma no soportado');
  });
  test('retorna array vacio si texts es vacio', async () => {
    const r = await translateTexts([], 'en');
    expect(r).toEqual([]);
  });
  test('retorna originales si sin API key', async () => {
    const r = await translateTexts(['hola'], 'en');
    expect(r).toEqual(['hola']);
  });
  test('traduce con cliente inyectado', async () => {
    process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    __setTranslateClientForTests(makeTranslateClient(['hello']));
    const r = await translateTexts(['hola'], 'en');
    expect(r).toEqual(['hello']);
  });
  test('fallback al original si cliente falla', async () => {
    process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    __setTranslateClientForTests(async () => { throw new Error('network'); });
    const r = await translateTexts(['hola'], 'en');
    expect(r).toEqual(['hola']);
  });
});


describe('translateCatalogItem', () => {
  test('lanza si item undefined', async () => {
    await expect(translateCatalogItem(null, 'en')).rejects.toThrow('item requerido');
  });
  test('lanza si targetLanguage undefined', async () => {
    await expect(translateCatalogItem({ name: 'test' }, undefined)).rejects.toThrow('targetLanguage requerido');
  });
  test('lanza si idioma no soportado', async () => {
    await expect(translateCatalogItem({ name: 'test' }, 'xx')).rejects.toThrow('idioma no soportado');
  });
  test('retorna copia sin cambios si es DEFAULT_LANGUAGE', async () => {
    const item = { name: 'Remera', description: 'Bonita' };
    const r = await translateCatalogItem(item, DEFAULT_LANGUAGE);
    expect(r.name).toBe('Remera');
    expect(r._translatedTo).toBeUndefined();
  });
  test('traduce campos con cliente inyectado', async () => {
    process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    __setTranslateClientForTests(makeTranslateClient(['T-Shirt', 'Beautiful', 'Clothing']));
    const item = { name: 'Remera', description: 'Bonita', category: 'Ropa' };
    const r = await translateCatalogItem(item, 'en');
    expect(r.name).toBe('T-Shirt');
    expect(r._translatedTo).toBe('en');
  });
  test('no muta el item original', async () => {
    process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    __setTranslateClientForTests(makeTranslateClient(['T-Shirt']));
    const item = { name: 'Remera' };
    const r = await translateCatalogItem(item, 'en');
    expect(item.name).toBe('Remera');
    expect(r.name).toBe('T-Shirt');
  });
  test('retorna original si sin campos traducibles', async () => {
    const item = { price: 100, sku: 'ABC123' };
    const r = await translateCatalogItem(item, 'en');
    expect(r.price).toBe(100);
  });
});

describe('translateCatalog', () => {
  test('lanza si uid undefined', async () => {
    await expect(translateCatalog(undefined, 'en')).rejects.toThrow('uid requerido');
  });
  test('lanza si targetLanguage undefined', async () => {
    await expect(translateCatalog(UID, undefined)).rejects.toThrow('targetLanguage requerido');
  });
  test('lanza si idioma no soportado', async () => {
    await expect(translateCatalog(UID, 'xx')).rejects.toThrow('idioma no soportado');
  });
  test('retorna array vacio si catalogo vacio', async () => {
    __setFirestoreForTests(makeMockDb({ items: [] }));
    const r = await translateCatalog(UID, 'en');
    expect(r).toEqual([]);
  });
  test('retorna cache si existe y es reciente', async () => {
    const cached = [{ name: 'T-Shirt', _translatedTo: 'en' }];
    __setFirestoreForTests(makeMockDb({ cachedTranslation: cached }));
    const r = await translateCatalog(UID, 'en');
    expect(r).toEqual(cached);
  });
  test('traduce items si sin cache', async () => {
    process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    __setTranslateClientForTests(makeTranslateClient(['T-Shirt', 'Beautiful']));
    __setFirestoreForTests(makeMockDb({ items: [{ name: 'Remera', description: 'Bonita' }] }));
    const r = await translateCatalog(UID, 'en');
    expect(r.length).toBe(1);
  });
});

describe('invalidateTranslationCache', () => {
  test('lanza si uid undefined', async () => {
    await expect(invalidateTranslationCache(undefined)).rejects.toThrow('uid requerido');
  });
  test('invalida idioma especifico sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(invalidateTranslationCache(UID, 'en')).resolves.toBeUndefined();
  });
  test('invalida todos los idiomas sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(invalidateTranslationCache(UID)).resolves.toBeUndefined();
  });
});
