'use strict';

const {
  getFlags, isEnabled, setFlags, clearCache,
  ALL_FLAGS, GLOBAL_DEFAULTS, __setFirestoreForTests
} = require('../core/feature_flags');

const UID = 'testUid1234567890abcdef';

function makeMockDb({ data = null, throwGet = false, throwSet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => {
          if (throwGet) throw new Error('firestore read error');
          if (data === null) return { exists: false };
          return { exists: true, data: () => data };
        },
        set: async (d, opts) => {
          if (throwSet) throw new Error('firestore write error');
        },
      }),
    }),
  };
}

beforeEach(() => { clearCache(); __setFirestoreForTests(null); });
afterEach(() => { clearCache(); __setFirestoreForTests(null); });

describe('ALL_FLAGS y GLOBAL_DEFAULTS', () => {
  test('ALL_FLAGS es array frozen con 10 flags', () => {
    expect(Array.isArray(ALL_FLAGS)).toBe(true);
    expect(ALL_FLAGS.length).toBe(10);
    expect(() => { ALL_FLAGS.push('x'); }).toThrow();
  });
  test('GLOBAL_DEFAULTS tiene los mismos flags que ALL_FLAGS', () => {
    for (const flag of ALL_FLAGS) {
      expect(GLOBAL_DEFAULTS).toHaveProperty(flag);
      expect(typeof GLOBAL_DEFAULTS[flag]).toBe('boolean');
    }
    expect(Object.keys(GLOBAL_DEFAULTS).length).toBe(ALL_FLAGS.length);
  });
  test('GLOBAL_DEFAULTS es frozen', () => {
    expect(() => { GLOBAL_DEFAULTS.broadcasts_enabled = false; }).toThrow();
  });
  test('defaults: tts=false, ai_v2=false, broadcasts=true, onboarding_v2=false', () => {
    expect(GLOBAL_DEFAULTS.tts_enabled).toBe(false);
    expect(GLOBAL_DEFAULTS.ai_v2_enabled).toBe(false);
    expect(GLOBAL_DEFAULTS.broadcasts_enabled).toBe(true);
    expect(GLOBAL_DEFAULTS.webhooks_enabled).toBe(true);
    expect(GLOBAL_DEFAULTS.onboarding_v2_enabled).toBe(false);
  });
});

describe('getFlags â€” validacion', () => {
  test('lanza si uid undefined', async () => {
    await expect(getFlags(undefined)).rejects.toThrow('uid requerido');
  });
  test('lanza si uid vacio', async () => {
    await expect(getFlags('')).rejects.toThrow('uid requerido');
  });
});

describe('getFlags â€” sin overrides', () => {
  test('retorna GLOBAL_DEFAULTS si no existe doc', async () => {
    __setFirestoreForTests(makeMockDb());
    const flags = await getFlags(UID);
    expect(flags).toEqual({ ...GLOBAL_DEFAULTS });
  });
  test('retorna GLOBAL_DEFAULTS con doc vacio', async () => {
    __setFirestoreForTests(makeMockDb({ data: {} }));
    const flags = await getFlags(UID);
    expect(flags).toEqual({ ...GLOBAL_DEFAULTS });
  });
});

describe('getFlags â€” con overrides', () => {
  test('override parcial cambia solo los flags especificados', async () => {
    __setFirestoreForTests(makeMockDb({ data: { tts_enabled: true, ai_v2_enabled: true } }));
    const flags = await getFlags(UID);
    expect(flags.tts_enabled).toBe(true);
    expect(flags.ai_v2_enabled).toBe(true);
    expect(flags.broadcasts_enabled).toBe(GLOBAL_DEFAULTS.broadcasts_enabled);
  });
  test('override completo invierte todos los flags', async () => {
    const overrides = {};
    for (const f of ALL_FLAGS) overrides[f] = !GLOBAL_DEFAULTS[f];
    __setFirestoreForTests(makeMockDb({ data: overrides }));
    const flags = await getFlags(UID);
    for (const f of ALL_FLAGS) expect(flags[f]).toBe(!GLOBAL_DEFAULTS[f]);
  });
  test('coerce a boolean desde string', async () => {
    __setFirestoreForTests(makeMockDb({ data: { tts_enabled: 'true' } }));
    const flags = await getFlags(UID);
    expect(typeof flags.tts_enabled).toBe('boolean');
    expect(flags.tts_enabled).toBe(true);
  });
});

describe('getFlags â€” fail-open', () => {
  test('retorna GLOBAL_DEFAULTS si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const flags = await getFlags(UID);
    expect(flags).toEqual({ ...GLOBAL_DEFAULTS });
  });
});

describe('getFlags â€” cache', () => {
  test('segunda llamada usa cache sin ir a Firestore', async () => {
    let calls = 0;
    __setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => { calls++; return { exists: false }; }, set: async () => {} }) }) });
    const now = Date.now();
    await getFlags(UID, now);
    await getFlags(UID, now + 1000);
    expect(calls).toBe(1);
  });
  test('cache expirado va a Firestore de nuevo', async () => {
    let calls = 0;
    __setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => { calls++; return { exists: false }; }, set: async () => {} }) }) });
    const TTL = 5 * 60 * 1000;
    const now = Date.now();
    await getFlags(UID, now);
    await getFlags(UID, now + TTL + 1);
    expect(calls).toBe(2);
  });
  test('clearCache(uid) fuerza re-fetch', async () => {
    let calls = 0;
    __setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => { calls++; return { exists: false }; }, set: async () => {} }) }) });
    const now = Date.now();
    await getFlags(UID, now);
    clearCache(UID);
    await getFlags(UID, now + 100);
    expect(calls).toBe(2);
  });
});

describe('isEnabled â€” validacion', () => {
  test('lanza si uid undefined', async () => {
    await expect(isEnabled(undefined, 'tts_enabled')).rejects.toThrow('uid requerido');
  });
  test('lanza si flag invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(isEnabled(UID, 'flag_inexistente')).rejects.toThrow('flag invalido');
  });
  test('false para tts_enabled por default', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await isEnabled(UID, 'tts_enabled')).toBe(false);
  });
  test('true para broadcasts_enabled por default', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await isEnabled(UID, 'broadcasts_enabled')).toBe(true);
  });
  test('retorna override de Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ data: { tts_enabled: true } }));
    expect(await isEnabled(UID, 'tts_enabled')).toBe(true);
  });
});

describe('setFlags â€” validacion', () => {
  test('lanza si uid undefined', async () => {
    await expect(setFlags(undefined, {})).rejects.toThrow('uid requerido');
  });
  test('lanza si updates null', async () => {
    await expect(setFlags(UID, null)).rejects.toThrow('updates requerido');
  });
  test('lanza si flag invalido en updates', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(setFlags(UID, { flag_invalido: true })).rejects.toThrow('flags invalidos');
  });
  test('acepta flags validos sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(setFlags(UID, { tts_enabled: true })).resolves.toBeUndefined();
  });
  test('coerce a boolean al guardar', async () => {
    let saved = null;
    __setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => ({ exists: false }), set: async (d) => { saved = d; } }) }) });
    await setFlags(UID, { tts_enabled: 1, ai_v2_enabled: 0 });
    expect(saved.tts_enabled).toBe(true);
    expect(saved.ai_v2_enabled).toBe(false);
  });
  test('invalida cache al guardar', async () => {
    let calls = 0;
    __setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => { calls++; return { exists: false }; }, set: async () => {} }) }) });
    const now = Date.now();
    await getFlags(UID, now);
    await setFlags(UID, { tts_enabled: true });
    await getFlags(UID, now + 100);
    expect(calls).toBe(2);
  });
  test('lanza si Firestore falla al guardar', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(setFlags(UID, { tts_enabled: true })).rejects.toThrow('firestore write error');
  });
});

describe('clearCache global', () => {
  test('clearCache sin uid limpia toda la cache', async () => {
    let calls = 0;
    __setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => { calls++; return { exists: false }; }, set: async () => {} }) }) });
    const now = Date.now();
    await getFlags(UID, now);
    await getFlags(UID + '2', now);
    clearCache();
    await getFlags(UID, now + 100);
    await getFlags(UID + '2', now + 100);
    expect(calls).toBe(4);
  });
});
