'use strict';

// MMC.1
describe('MMC.1 episodic_memory', () => {
  const em = require('../core/episodic_memory');
  let mockSet, mockGet, mockDelete;
  function makeDb(existsData) {
    mockSet = jest.fn().mockResolvedValue(undefined);
    mockDelete = jest.fn().mockResolvedValue(undefined);
    mockGet = jest.fn().mockResolvedValue({ exists: !!existsData, data: () => existsData });
    const md = jest.fn().mockReturnValue({ get: mockGet, set: mockSet, delete: mockDelete });
    const mc = jest.fn().mockReturnValue({ doc: md });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    const moc = jest.fn().mockReturnValue({ doc: mod });
    em.__setFirestoreForTests({ collection: moc });
  }
  afterEach(() => { em.__setFirestoreForTests(null); jest.clearAllMocks(); });

  test('crea doc si no existe', async () => {
    makeDb(null);
    const r = await em.initEpisodicMemory('u1', '+573');
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ uid: 'u1', contact_phone: '+573', key_facts: [], interaction_count: 0 });
  });

  test('idempotente si doc existe', async () => {
    makeDb({ uid: 'u1', contact_phone: '+573', key_facts: [], interaction_count: 3 });
    const r = await em.initEpisodicMemory('u1', '+573');
    expect(mockSet).not.toHaveBeenCalled();
    expect(r.interaction_count).toBe(3);
  });

  test('uid null => error', async () => {
    await expect(em.initEpisodicMemory(null, '+573')).rejects.toThrow();
  });

  test('schema correcto: schema_version tags sentiment_history', async () => {
    makeDb(null);
    const r = await em.initEpisodicMemory('u1', '+573');
    expect(r.schema_version).toBe(em.SCHEMA_VERSION);
    expect(r.tags).toEqual([]);
    expect(r.sentiment_history).toEqual([]);
  });

  test('appendKeyFacts: agrega y hace merge', async () => {
    makeDb({ key_facts: [{ fact: 'd1', confidence: 'high', learned_at: 'x' }] });
    const ok = await em.appendKeyFacts('u1', '+573', [{ fact: 'd2', confidence: 'medium' }]);
    expect(ok).toBe(true);
    expect(mockSet.mock.calls[0][0].key_facts).toHaveLength(2);
    expect(mockSet.mock.calls[0][1]).toEqual({ merge: true });
  });

  test('appendKeyFacts: max 20, elimina viejos', async () => {
    const old = Array.from({ length: 20 }, (_, i) => ({ fact: 'f'+i, confidence: 'high', learned_at: 'x' }));
    makeDb({ key_facts: old });
    await em.appendKeyFacts('u1', '+573', [{ fact: 'nuevo', confidence: 'high' }]);
    const kf = mockSet.mock.calls[0][0].key_facts;
    expect(kf).toHaveLength(20);
    expect(kf[19].fact).toBe('nuevo');
  });

  test('getEpisodicMemory: retorna data', async () => {
    makeDb({ key_facts: [{ fact: 'x', confidence: 'high' }] });
    const r = await em.getEpisodicMemory('u1', '+573');
    expect(r.key_facts).toHaveLength(1);
  });

  test('getEpisodicMemory: null si no existe', async () => {
    makeDb(null);
    expect(await em.getEpisodicMemory('u1', '+573')).toBeNull();
  });

  test('deleteEpisodicMemory: llama delete', async () => {
    makeDb({});
    expect(await em.deleteEpisodicMemory('u1', '+573')).toBe(true);
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });
});

// MMC.2
describe('MMC.2 fact_extractor', () => {
  const { extractKeyFacts, __setFetchForTests } = require('../core/fact_extractor');
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
  afterEach(() => { __setFetchForTests(null); jest.restoreAllMocks(); });

  function geminiOk(text) {
    __setFetchForTests(jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text }] } }] }),
    }));
  }

  test('Gemini retorna JSON valido => facts extraidos', async () => {
    geminiOk('[{"fact": "Tiene hijo", "confidence": "high"}, {"fact": "Es medico", "confidence": "medium"}]');
    const facts = await extractKeyFacts('key', [{ role: 'user', content: 'hola' }]);
    expect(facts).toHaveLength(2);
    expect(facts[0].fact).toBe('Tiene hijo');
  });

  test('Gemini retorna [] => []', async () => {
    geminiOk('[]');
    expect(await extractKeyFacts('key', [{ role: 'user', content: 'x' }])).toEqual([]);
  });

  test('Gemini falla => [] silencioso', async () => {
    __setFetchForTests(jest.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('err') }));
    expect(await extractKeyFacts('key', [{ role: 'user', content: 'x' }])).toEqual([]);
  });

  test('conversation vacia => []', async () => {
    expect(await extractKeyFacts('key', [])).toEqual([]);
  });

  test('apiKey null => []', async () => {
    expect(await extractKeyFacts(null, [{ role: 'user', content: 'x' }])).toEqual([]);
  });

  test('max 5 facts', async () => {
    const many = JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ fact: 'f'+i, confidence: 'high' })));
    geminiOk(many);
    const facts = await extractKeyFacts('key', [{ role: 'user', content: 'x' }]);
    expect(facts).toHaveLength(5);
  });

  test('confidence invalida se filtra', async () => {
    geminiOk('[{"fact": "dato", "confidence": "very_high"}]');
    expect(await extractKeyFacts('key', [{ role: 'user', content: 'x' }])).toEqual([]);
  });
});

// MMC.3
describe('MMC.3 memory_injector', () => {
  const { buildMemoryContext } = require('../core/memory_injector');
  const em = require('../core/episodic_memory');
  afterEach(() => { em.__setFirestoreForTests(null); jest.clearAllMocks(); });

  function mockMem(kf) {
    const mg = jest.fn().mockResolvedValue({ exists: !!kf, data: () => kf ? { key_facts: kf } : null });
    const md = jest.fn().mockReturnValue({ get: mg });
    const mc = jest.fn().mockReturnValue({ doc: md });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    const moc = jest.fn().mockReturnValue({ doc: mod });
    em.__setFirestoreForTests({ collection: moc });
  }

  test('con facts high => string con facts', async () => {
    mockMem([{ fact: 'Hijo', confidence: 'high' }, { fact: 'Medico', confidence: 'high' }]);
    const ctx = await buildMemoryContext('u1', '+573');
    expect(ctx).toContain('Hijo');
    expect(ctx).toMatch(/^Sobre este contacto recuerdo:/);
  });

  test('solo medium => null', async () => {
    mockMem([{ fact: 'algo', confidence: 'medium' }]);
    expect(await buildMemoryContext('u1', '+573')).toBeNull();
  });

  test('sin memoria => null', async () => {
    mockMem(null);
    expect(await buildMemoryContext('u1', '+573')).toBeNull();
  });

  test('uid null => null', async () => {
    expect(await buildMemoryContext(null, '+573')).toBeNull();
  });

  test('max 3 facts inyectados', async () => {
    const kf = Array.from({ length: 5 }, (_, i) => ({ fact: 'fact'+i, confidence: 'high' }));
    mockMem(kf);
    const ctx = await buildMemoryContext('u1', '+573');
    const count = (ctx.match(/fact\d/g) || []).length;
    expect(count).toBe(3);
  });
});

// MMC.4
describe('MMC.4 memory routes', () => {
  const express = require('express');
  const request = require('supertest');
  const em = require('../core/episodic_memory');
  const createRoutes = require('../routes/memory');

  function makeApp(actingUid, mem) {
    const mg = jest.fn().mockResolvedValue({ exists: !!mem, data: () => mem });
    const mdel = jest.fn().mockResolvedValue(undefined);
    const md = jest.fn().mockReturnValue({ get: mg, delete: mdel });
    const mc = jest.fn().mockReturnValue({ doc: md });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    const moc = jest.fn().mockReturnValue({ doc: mod });
    em.__setFirestoreForTests({ collection: moc });
    const app = express();
    app.use((req, res, next) => { req.user = { uid: actingUid }; next(); });
    app.use('/api/owner', createRoutes({ requireAuth: (req, res, next) => next() }));
    return app;
  }
  afterEach(() => { em.__setFirestoreForTests(null); jest.clearAllMocks(); });

  test('GET memory-report propio OK => 200', async () => {
    const mem = { key_facts: [{ fact: 'x', confidence: 'high' }], interaction_count: 5, last_interaction: 'ts', sentiment_history: [] };
    const res = await request(makeApp('u1', mem)).get('/api/owner/memory-report?uid=u1&contact=%2B57');
    expect(res.status).toBe(200);
    expect(res.body.interaction_count).toBe(5);
  });

  test('GET memory-report otro uid => 403', async () => {
    const res = await request(makeApp('other', {})).get('/api/owner/memory-report?uid=u1&contact=%2B57');
    expect(res.status).toBe(403);
  });

  test('GET memory-report sin uid => 400', async () => {
    const res = await request(makeApp('u1', {})).get('/api/owner/memory-report?contact=%2B57');
    expect(res.status).toBe(400);
  });

  test('GET memory-report no existe => 404', async () => {
    const res = await request(makeApp('u1', null)).get('/api/owner/memory-report?uid=u1&contact=%2B57');
    expect(res.status).toBe(404);
  });

  test('DELETE memory propio OK => 200', async () => {
    const res = await request(makeApp('u1', {})).delete('/api/owner/memory?uid=u1&contact=%2B57');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('DELETE memory otro uid => 403', async () => {
    const res = await request(makeApp('other', {})).delete('/api/owner/memory?uid=u1&contact=%2B57');
    expect(res.status).toBe(403);
  });
});
