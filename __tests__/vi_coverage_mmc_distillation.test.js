'use strict';

function makeChainable(docs) {
  const chain = {
    collection: jest.fn(),
    doc: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    get: jest.fn().mockResolvedValue({ docs: docs || [] }),
  };
  chain.collection.mockReturnValue(chain);
  chain.doc.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

function loadMod(appsLength, docs) {
  jest.resetModules();
  const chain = makeChainable(docs);
  const adminMock = {
    apps: { length: appsLength || 0 },
    firestore: jest.fn().mockReturnValue(chain),
    initializeApp: jest.fn(),
    credential: { cert: jest.fn().mockReturnValue({}) },
  };
  const distillerMock = { runNightlyDistillation: jest.fn() };
  const aiGwMock = { smartCall: jest.fn(), CONTEXTS: { GENERAL: 'general' } };
  jest.doMock('firebase-admin', () => adminMock);
  jest.doMock('../core/mmc/episode_distiller', () => distillerMock);
  jest.doMock('../ai/ai_gateway', () => aiGwMock);
  jest.doMock('dotenv', () => ({ config: jest.fn() }));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const mod = require('../scripts/run_mmc_nightly_distillation');
  return { mod, adminMock, distillerMock, aiGwMock };
}

let savedEnv;
beforeEach(() => {
  savedEnv = {
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
  };
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  jest.restoreAllMocks();
});

describe('MIIA_CENTER_UID', () => {
  test('es el UID correcto de MIIA CENTER', () => {
    const { mod } = loadMod();
    expect(mod.MIIA_CENTER_UID).toBe('A5pMESWlfmPWCoCPRbwy85EzUzy2');
  });
});

describe('_makeGeminiClientForDistillation', () => {
  test('result.text truthy => retorna text (branch || falsy false)', async () => {
    const { mod, aiGwMock } = loadMod();
    aiGwMock.smartCall.mockResolvedValue({ text: 'hello ai' });
    const client = mod._makeGeminiClientForDistillation();
    const r = await client.generateContent({ prompt: 'test', signal: null });
    expect(r.text).toBe('hello ai');
    expect(aiGwMock.smartCall).toHaveBeenCalledWith('general', 'test', {}, { enableSearch: false, signal: null });
  });
  test('result=null => text= (branch result?.text falsy)', async () => {
    const { mod, aiGwMock } = loadMod();
    aiGwMock.smartCall.mockResolvedValue(null);
    const client = mod._makeGeminiClientForDistillation();
    const r = await client.generateContent({ prompt: 'test', signal: null });
    expect(r.text).toBe('');
  });
  test('result.text= => text= (branch text string falsy)', async () => {
    const { mod, aiGwMock } = loadMod();
    aiGwMock.smartCall.mockResolvedValue({ text: '' });
    const client = mod._makeGeminiClientForDistillation();
    const r = await client.generateContent({ prompt: 'test', signal: null });
    expect(r.text).toBe('');
  });
});

describe('_fetchClosedPending — _firestoreInit branches', () => {
  test('apps.length > 0 => early return firestore (branch truthy)', async () => {
    const { mod, adminMock } = loadMod(1);
    const result = await mod._fetchClosedPending('uid1', 10);
    expect(Array.isArray(result)).toBe(true);
    expect(adminMock.initializeApp).not.toHaveBeenCalled();
  });
  test('apps.length = 0 + missing PROJECT_ID => throw (branch falsy + !vars truthy)', async () => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    const { mod } = loadMod(0);
    await expect(mod._fetchClosedPending('uid1', 10)).rejects.toThrow('FIREBASE_* env vars missing');
  });
  test('apps.length = 0 + FIREBASE_PRIVATE_KEY undefined => ||  branch', async () => {
    process.env.FIREBASE_PROJECT_ID = 'proj';
    process.env.FIREBASE_CLIENT_EMAIL = 'e@test.com';
    delete process.env.FIREBASE_PRIVATE_KEY;
    const { mod } = loadMod(0);
    await expect(mod._fetchClosedPending('uid1', 10)).rejects.toThrow('FIREBASE_* env vars missing');
  });
  test('apps.length = 0 + valid env => initializeApp + firestore (branch falsy + !vars false)', async () => {
    process.env.FIREBASE_PROJECT_ID = 'proj';
    process.env.FIREBASE_CLIENT_EMAIL = 'e@test.com';
    process.env.FIREBASE_PRIVATE_KEY = 'key';
    const { mod, adminMock } = loadMod(0);
    const result = await mod._fetchClosedPending('uid1', 10);
    expect(adminMock.initializeApp).toHaveBeenCalled();
    expect(Array.isArray(result)).toBe(true);
  });
  test('filter !e.summary: incluye sin summary, excluye con summary (ambos branches)', async () => {
    const docs = [
      { data: () => ({ summary: null }) },
      { data: () => ({ summary: 'ya distilado' }) },
    ];
    const { mod } = loadMod(1, docs);
    const result = await mod._fetchClosedPending('uid1', 10);
    expect(result.length).toBe(1);
    expect(result[0].summary).toBeNull();
  });
});

describe('_main', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('success sin errors (branch errors.length === 0)', async () => {
    const { mod, distillerMock } = loadMod(1);
    distillerMock.runNightlyDistillation.mockResolvedValue({ processed: 5, errors: [] });
    await mod._main();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('done processed=5 errors=0'));
    expect(console.error).not.toHaveBeenCalled();
  });
  test('success con errors (branch errors.length > 0)', async () => {
    const { mod, distillerMock } = loadMod(1);
    distillerMock.runNightlyDistillation.mockResolvedValue({ processed: 2, errors: ['err1', 'err2'] });
    await mod._main();
    expect(console.error).toHaveBeenCalledWith('[V2-ALERT][MMC-NIGHTLY-ERRORS]', expect.objectContaining({ errors_count: 2 }));
  });
  test('catch: error con stack (branch e.stack ||  truthy)', async () => {
    const { mod, distillerMock } = loadMod(1);
    const err = new Error('fatal error');
    distillerMock.runNightlyDistillation.mockRejectedValue(err);
    await mod._main();
    expect(console.error).toHaveBeenCalledWith('[V2-ALERT][MMC-NIGHTLY-FATAL]', expect.objectContaining({ error: 'fatal error' }));
  });
  test('catch: error sin stack (branch e.stack ||  falsy => )', async () => {
    const { mod, distillerMock } = loadMod(1);
    const err = new Error('fatal no stack');
    err.stack = undefined;
    distillerMock.runNightlyDistillation.mockRejectedValue(err);
    await mod._main();
    expect(console.error).toHaveBeenCalledWith('[V2-ALERT][MMC-NIGHTLY-FATAL]', expect.any(Object));
  });
});

describe('_main — getEpisodesFn callback', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('distiller llama getEpisodesFn => cubre arrow function L103', async () => {
    const { mod, distillerMock } = loadMod(1);
    distillerMock.runNightlyDistillation.mockImplementation(async (uid, gemini, opts) => {
      const episodes = await opts.getEpisodesFn(uid);
      return { processed: episodes.length, errors: [] };
    });
    await mod._main();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('done processed='));
  });
});
