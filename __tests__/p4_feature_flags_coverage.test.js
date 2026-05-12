'use strict';

let ff;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
  ff = require('../core/feature_flags');
  ff.clearCache();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  // Limpiar env flags
  ['MIIA_MODO_DEPORTE_ENABLED','PISO3_CATALOGO_ENABLED','PISO3_AUDIO_IN_ENABLED','PISO3_AUDIO_OUT_ENABLED'].forEach(k => delete process.env[k]);
});
afterEach(() => {
  ff.__setFirestoreForTests(null);
  ff.clearCache();
  jest.restoreAllMocks();
  ['MIIA_MODO_DEPORTE_ENABLED','PISO3_CATALOGO_ENABLED','PISO3_AUDIO_IN_ENABLED','PISO3_AUDIO_OUT_ENABLED'].forEach(k => delete process.env[k]);
});

function makeDb({ exists = false, data = null, throwGet = false, throwSet = false } = {}) {
  return {
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({
        get: throwGet
          ? jest.fn().mockRejectedValue(new Error('db error'))
          : jest.fn().mockResolvedValue({ exists, data: () => data }),
        set: throwSet
          ? jest.fn().mockRejectedValue(new Error('set error'))
          : jest.fn().mockResolvedValue({}),
      }),
    }),
  };
}

describe('P4 -- feature_flags (env section) branches', () => {
  test('isFlagEnabled: nombre null -> false', () => {
    expect(ff.isFlagEnabled(null)).toBe(false);
  });

  test('isFlagEnabled: nombre no string -> false', () => {
    expect(ff.isFlagEnabled(123)).toBe(false);
  });

  test('isFlagEnabled: nombre desconocido -> false', () => {
    expect(ff.isFlagEnabled('UNKNOWN_FLAG_XYZ')).toBe(false);
  });

  test('isFlagEnabled: env no seteado -> false', () => {
    expect(ff.isFlagEnabled('MIIA_MODO_DEPORTE_ENABLED')).toBe(false);
  });

  test('isFlagEnabled: env = 1 -> true', () => {
    process.env.MIIA_MODO_DEPORTE_ENABLED = '1';
    expect(ff.isFlagEnabled('MIIA_MODO_DEPORTE_ENABLED')).toBe(true);
  });

  test('isFlagEnabled: env = true -> true', () => {
    process.env.PISO3_CATALOGO_ENABLED = 'true';
    expect(ff.isFlagEnabled('PISO3_CATALOGO_ENABLED')).toBe(true);
  });

  test('isFlagEnabled: env = on -> true', () => {
    process.env.PISO3_AUDIO_IN_ENABLED = 'on';
    expect(ff.isFlagEnabled('PISO3_AUDIO_IN_ENABLED')).toBe(true);
  });

  test('isFlagEnabled: env = yes -> true', () => {
    process.env.PISO3_AUDIO_OUT_ENABLED = 'yes';
    expect(ff.isFlagEnabled('PISO3_AUDIO_OUT_ENABLED')).toBe(true);
  });

  test('isFlagEnabled: env = no -> false', () => {
    process.env.MIIA_MODO_DEPORTE_ENABLED = 'no';
    expect(ff.isFlagEnabled('MIIA_MODO_DEPORTE_ENABLED')).toBe(false);
  });

  test('getAllFlags: retorna objeto con todas las flags', () => {
    const flags = ff.getAllFlags();
    expect(flags).toHaveProperty('MIIA_MODO_DEPORTE_ENABLED');
    expect(flags).toHaveProperty('PISO3_CATALOGO_ENABLED');
  });

  test('logFlagsState: con logger que tiene .info -> llama info', () => {
    const logger = { info: jest.fn() };
    ff.logFlagsState(logger);
    expect(logger.info).toHaveBeenCalled();
  });

  test('logFlagsState: sin logger -> no lanza', () => {
    expect(() => ff.logFlagsState(null)).not.toThrow();
    expect(() => ff.logFlagsState({ })).not.toThrow();
  });
});

describe('P4 -- feature_flags (legacy Firestore) branches', () => {
  test('getFlags: uid faltante -> throw', async () => {
    ff.__setFirestoreForTests(makeDb());
    await expect(ff.getFlags(null)).rejects.toThrow('uid requerido');
  });

  test('getFlags: doc no existe -> GLOBAL_DEFAULTS', async () => {
    ff.__setFirestoreForTests(makeDb({ exists: false }));
    const flags = await ff.getFlags('uid1');
    expect(flags.tts_enabled).toBe(false);
    expect(flags.broadcasts_enabled).toBe(true);
  });

  test('getFlags: doc existe con overrides booleanos -> aplica', async () => {
    ff.__setFirestoreForTests(makeDb({ exists: true, data: { tts_enabled: true, broadcasts_enabled: false } }));
    const flags = await ff.getFlags('uid1');
    expect(flags.tts_enabled).toBe(true);
    expect(flags.broadcasts_enabled).toBe(false);
  });

  test('getFlags: doc existe con override string "1" -> _coerceBool true', async () => {
    ff.__setFirestoreForTests(makeDb({ exists: true, data: { ai_v2_enabled: '1' } }));
    const flags = await ff.getFlags('uid1');
    expect(flags.ai_v2_enabled).toBe(true);
  });

  test('getFlags: doc existe con override numero -> _coerceBool', async () => {
    ff.__setFirestoreForTests(makeDb({ exists: true, data: { sla_enabled: 0 } }));
    const flags = await ff.getFlags('uid1');
    expect(flags.sla_enabled).toBe(false);
  });

  test('getFlags: cache hit antes de TTL -> no llama db segunda vez', async () => {
    const db = makeDb({ exists: false });
    ff.__setFirestoreForTests(db);
    const now = Date.now();
    await ff.getFlags('uid_cache', now);
    await ff.getFlags('uid_cache', now + 1000);
    expect(db.collection).toHaveBeenCalledTimes(1);
  });

  test('getFlags: Firestore lanza -> fail-open con defaults', async () => {
    ff.__setFirestoreForTests(makeDb({ throwGet: true }));
    const flags = await ff.getFlags('uid1');
    expect(flags.tts_enabled).toBe(false);
  });

  test('isEnabled: uid faltante -> throw', async () => {
    ff.__setFirestoreForTests(makeDb());
    await expect(ff.isEnabled(null, 'tts_enabled')).rejects.toThrow('uid requerido');
  });

  test('isEnabled: flag invalido -> throw', async () => {
    ff.__setFirestoreForTests(makeDb());
    await expect(ff.isEnabled('uid1', 'unknown_flag')).rejects.toThrow('flag invalido');
  });

  test('isEnabled: flag valido y desactivado -> false', async () => {
    ff.__setFirestoreForTests(makeDb({ exists: false }));
    expect(await ff.isEnabled('uid1', 'tts_enabled')).toBe(false);
  });

  test('setFlags: uid faltante -> throw', async () => {
    ff.__setFirestoreForTests(makeDb());
    await expect(ff.setFlags(null, {})).rejects.toThrow('uid requerido');
  });

  test('setFlags: updates null -> throw', async () => {
    ff.__setFirestoreForTests(makeDb());
    await expect(ff.setFlags('uid1', null)).rejects.toThrow('updates requerido');
  });

  test('setFlags: flag invalido en updates -> throw', async () => {
    ff.__setFirestoreForTests(makeDb());
    await expect(ff.setFlags('uid1', { unknown_flag: true })).rejects.toThrow('flags invalidos');
  });

  test('setFlags: flags validos -> guarda y limpia cache', async () => {
    const db = makeDb();
    ff.__setFirestoreForTests(db);
    await ff.setFlags('uid1', { tts_enabled: true, broadcasts_enabled: false });
    expect(db.collection).toHaveBeenCalledWith('feature_flags');
  });
});
