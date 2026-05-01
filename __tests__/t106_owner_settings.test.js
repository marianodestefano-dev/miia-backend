'use strict';
const { getSettings, updateSettings, ALLOWED_SETTINGS, DEFAULTS, __setFirestoreForTests } = require('../core/owner_settings');

function makeMockDb({ settings=null, throwGet=false, throwSet=false }={}) {
  let store = settings ? { settings } : null;
  return {
    collection: () => ({
      doc: () => ({
        get: async () => {
          if (throwGet) throw new Error('get error');
          if (store) return { exists: true, data: () => store };
          return { exists: false };
        },
        set: async (data, opts) => {
          if (throwSet) throw new Error('set error');
          if (opts && opts.merge) {
            store = store || {};
            store.settings = Object.assign({}, (store.settings || {}), data.settings);
          } else {
            store = data;
          }
        }
      })
    })
  };
}

afterEach(() => { __setFirestoreForTests(null); });

describe('ALLOWED_SETTINGS y DEFAULTS', () => {
  test('tiene las keys esperadas', () => {
    expect('language' in ALLOWED_SETTINGS).toBe(true);
    expect('aiEnabled' in ALLOWED_SETTINGS).toBe(true);
    expect('timezone' in ALLOWED_SETTINGS).toBe(true);
    expect(DEFAULTS.language).toBe('es');
    expect(DEFAULTS.aiEnabled).toBe(true);
  });
  test('ALLOWED_SETTINGS y DEFAULTS son frozen', () => {
    expect(() => { ALLOWED_SETTINGS.newKey = 'string'; }).toThrow();
    expect(() => { DEFAULTS.language = 'en'; }).toThrow();
  });
});

describe('getSettings', () => {
  test('lanza error si uid vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getSettings('')).rejects.toThrow('uid requerido');
  });
  test('retorna DEFAULTS si no hay settings guardados', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getSettings('uid1');
    expect(r.settings.language).toBe(DEFAULTS.language);
    expect(r.settings.aiEnabled).toBe(DEFAULTS.aiEnabled);
  });
  test('merge settings guardados con defaults', async () => {
    __setFirestoreForTests(makeMockDb({ settings: { language: 'en', aiEnabled: false } }));
    const r = await getSettings('uid1');
    expect(r.settings.language).toBe('en'); // sobreescrito
    expect(r.settings.timezone).toBe(DEFAULTS.timezone); // default
    expect(r.settings.aiEnabled).toBe(false); // sobreescrito
  });
  test('no incluye keys no permitidas en el resultado', async () => {
    __setFirestoreForTests(makeMockDb({ settings: { language: 'es', hackKey: 'malicious' } }));
    const r = await getSettings('uid1');
    expect('hackKey' in r.settings).toBe(false);
  });
  test('retorna defaults si Firestore falla (fail-open)', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getSettings('uid1');
    expect(r.settings.language).toBe(DEFAULTS.language);
    expect(r.error).toBeDefined();
  });
});

describe('updateSettings', () => {
  test('lanza error si uid vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateSettings('', { language: 'en' })).rejects.toThrow('uid requerido');
  });
  test('lanza error si updates es array', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateSettings('uid1', ['lang'])).rejects.toThrow('objeto');
  });
  test('lanza error si key no esta en ALLOWED_SETTINGS', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateSettings('uid1', { hackKey: 'val' })).rejects.toThrow('no permitida');
  });
  test('lanza error si tipo incorrecto', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateSettings('uid1', { aiEnabled: 'yes' })).rejects.toThrow('debe ser boolean');
  });
  test('actualiza correctamente y retorna updatedKeys', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await updateSettings('uid1', { language: 'pt', aiEnabled: false });
    expect(r.updatedKeys).toContain('language');
    expect(r.updatedKeys).toContain('aiEnabled');
    expect(r).toHaveProperty('updatedAt');
  });
  test('lanza error si no hay settings validos para actualizar', async () => {
    __setFirestoreForTests(makeMockDb());
    // sin updates
    await expect(updateSettings('uid1', {})).rejects.toThrow('No hay settings válidos');
  });
});
