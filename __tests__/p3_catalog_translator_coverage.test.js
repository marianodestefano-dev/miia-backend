'use strict';

const {
  translateTexts, translateCatalogItem, translateCatalog,
  __setFirestoreForTests, __setTranslateClientForTests,
  SUPPORTED_LANGUAGES,
} = require('../core/catalog_translator');

function makeMockDb({ items = [], cachedExists = false, cachedData = null, throwCatalog = false, throwCache = false, throwSet = false } = {}) {
  const catalogGet = throwCatalog
    ? jest.fn().mockRejectedValue(new Error('catalog db error'))
    : jest.fn().mockResolvedValue({ forEach: fn => items.map((item, i) => ({ id: 'item' + i, data: () => item })).forEach(fn) });

  const cacheGet = throwCache
    ? jest.fn().mockRejectedValue(new Error('cache db error'))
    : jest.fn().mockResolvedValue({
        exists: cachedExists,
        data: () => cachedExists ? (cachedData || { items: [], cachedAt: new Date().toISOString() }) : null,
      });

  const cacheSet = throwSet
    ? jest.fn().mockRejectedValue(new Error('set error'))
    : jest.fn().mockResolvedValue({});

  return {
    collection: (name) => {
      if (name === 'catalog_translations') {
        return { doc: () => ({ get: cacheGet, set: cacheSet }) };
      }
      return {
        doc: () => ({
          collection: (sub) => {
            if (sub === 'catalog') return { get: catalogGet };
            return { doc: () => ({ get: cacheGet, set: cacheSet }) };
          },
        }),
      };
    },
  };
}

beforeEach(() => {
  __setFirestoreForTests(null);
  __setTranslateClientForTests(null);
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  __setFirestoreForTests(null);
  __setTranslateClientForTests(null);
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  jest.restoreAllMocks();
});

describe('P3 -- catalog_translator branches sin cubrir', () => {
  test('_getCatalogItems lanza error -> retorna [] (lines 148-149)', async () => {
    __setFirestoreForTests(makeMockDb({ throwCatalog: true }));
    __setTranslateClientForTests(async (texts) => texts);
    process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const result = await translateCatalog('uid1', 'en');
    expect(result).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('leyendo catalogo'));
  });

  test('_getCachedTranslation lanza error -> retorna null y continua (line 165)', async () => {
    const items = [{ name: 'Producto', description: 'Desc', category: 'Cat' }];
    __setFirestoreForTests(makeMockDb({ items, throwCache: true }));
    __setTranslateClientForTests(async (texts) => texts.map(t => t + '_en'));
    process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const result = await translateCatalog('uid1', 'en');
    expect(Array.isArray(result)).toBe(true);
  });

  test('_saveCachedTranslation lanza error -> se loguea pero no falla (line 135)', async () => {
    const items = [{ name: 'Producto', description: 'Desc', category: 'Cat' }];
    __setFirestoreForTests(makeMockDb({ items, throwSet: true }));
    __setTranslateClientForTests(async (texts) => texts.map(t => t + '_en'));
    process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const result = await translateCatalog('uid1', 'en');
    expect(Array.isArray(result)).toBe(true);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('guardando cache'));
  });

  test('_defaultTranslate via fetch mock (lines 65-74) -- respuesta valida', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        data: { translations: [{ translatedText: 'Product' }, { translatedText: 'Desc EN' }] },
      }),
    });
    global.fetch = mockFetch;
    __setTranslateClientForTests(null);
    process.env.GOOGLE_TRANSLATE_API_KEY = 'test-api-key';
    const result = await translateTexts(['Producto', 'Descripcion'], 'en');
    expect(result).toEqual(['Product', 'Desc EN']);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('translation.googleapis.com'),
      expect.any(Object)
    );
    delete global.fetch;
  });

  test('_defaultTranslate respuesta invalida (sin data) -> throw (line 73)', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({ error: 'invalid key' }),
    });
    global.fetch = mockFetch;
    __setTranslateClientForTests(null);
    process.env.GOOGLE_TRANSLATE_API_KEY = 'bad-key';
    const result = await translateTexts(['Hola'], 'en');
    expect(result).toEqual(['Hola']);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error traduciendo chunk'));
    delete global.fetch;
  });

  test('translateCatalog con items y translate client que falla -> push item original (lines 129-130)', async () => {
    const items = [{ name: 'Prod', description: 'Desc', category: 'Cat' }];
    __setFirestoreForTests(makeMockDb({ items }));
    __setTranslateClientForTests(async () => { throw new Error('translate fail'); });
    process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const result = await translateCatalog('uid1', 'en');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
  });
});
