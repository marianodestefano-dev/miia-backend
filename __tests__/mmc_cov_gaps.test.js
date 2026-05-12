'use strict';

/**
 * COV gaps — MMC.1-4 branch coverage complement
 */

const express = require('express');
const request = require('supertest');
const em = require('../core/episodic_memory');
const { extractKeyFacts, __setFetchForTests } = require('../core/fact_extractor');
const createMemoryRoutes = require('../routes/memory');

jest.spyOn(console, 'warn').mockImplementation(() => {});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDb(existsData) {
  const mockSet = jest.fn().mockResolvedValue(undefined);
  const mockDelete = jest.fn().mockResolvedValue(undefined);
  const mockGet = jest.fn().mockResolvedValue({ exists: !!existsData, data: () => existsData });
  const md = jest.fn().mockReturnValue({ get: mockGet, set: mockSet, delete: mockDelete });
  const mc = jest.fn().mockReturnValue({ doc: md });
  const mod = jest.fn().mockReturnValue({ collection: mc });
  const moc = jest.fn().mockReturnValue({ doc: mod });
  em.__setFirestoreForTests({ collection: moc });
  return { mockSet, mockGet, mockDelete };
}

function makeDbThrows() {
  const mockGet = jest.fn().mockRejectedValue(new Error('Firestore error'));
  const md = jest.fn().mockReturnValue({ get: mockGet, set: jest.fn().mockRejectedValue(new Error('Firestore error')), delete: jest.fn().mockRejectedValue(new Error('Firestore error')) });
  const mc = jest.fn().mockReturnValue({ doc: md });
  const mod = jest.fn().mockReturnValue({ collection: mc });
  const moc = jest.fn().mockReturnValue({ doc: mod });
  em.__setFirestoreForTests({ collection: moc });
}

afterEach(() => { em.__setFirestoreForTests(null); __setFetchForTests(null); jest.clearAllMocks(); });

// ── MMC.1 episodic_memory branch gaps ────────────────────────────────────────
describe('MMC.1 episodic_memory COV gaps', () => {
  test('appendKeyFacts: phone null => false', async () => {
    makeDb({});
    expect(await em.appendKeyFacts('u1', null, [{ fact: 'x' }])).toBe(false);
  });

  test('appendKeyFacts: facts no es array => false', async () => {
    makeDb({});
    expect(await em.appendKeyFacts('u1', '+57', 'not-array')).toBe(false);
  });

  test('appendKeyFacts: facts vacio => false', async () => {
    makeDb({});
    expect(await em.appendKeyFacts('u1', '+57', [])).toBe(false);
  });

  test('appendKeyFacts: doc no existe => existing=[]', async () => {
    const { mockSet } = makeDb(null); // doc does not exist
    await em.appendKeyFacts('u1', '+57', [{ fact: 'nuevo', confidence: 'high' }]);
    expect(mockSet.mock.calls[0][0].key_facts).toHaveLength(1);
  });

  test('appendKeyFacts: uid null => false', async () => {
    makeDb({});
    expect(await em.appendKeyFacts(null, '+57', [{ fact: 'x' }])).toBe(false);
  });

  test('getEpisodicMemory: phone null => null', async () => {
    expect(await em.getEpisodicMemory('u1', null)).toBeNull();
  });

  test('deleteEpisodicMemory: phone null => false', async () => {
    expect(await em.deleteEpisodicMemory('u1', null)).toBe(false);
  });

  test('deleteEpisodicMemory: uid null => false', async () => {
    expect(await em.deleteEpisodicMemory(null, '+57')).toBe(false);
  });
});

// ── MMC.2 fact_extractor branch gaps ─────────────────────────────────────────
describe('MMC.2 fact_extractor COV gaps', () => {
  function geminiOk(text) {
    __setFetchForTests(jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text }] } }] }),
    }));
  }

  test('conversation con role assistant => label MIIA (branch false)', async () => {
    geminiOk('[{"fact": "dato", "confidence": "high"}]');
    const facts = await extractKeyFacts('key', [
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'hola' },
    ]);
    expect(Array.isArray(facts)).toBe(true);
  });

  test('Gemini retorna objeto JSON (no array) => []', async () => {
    geminiOk('{"fact": "solo un objeto"}');
    const facts = await extractKeyFacts('key', [{ role: 'user', content: 'x' }]);
    expect(facts).toEqual([]);
  });
});

// ── MMC.4 memory routes branch gaps ──────────────────────────────────────────
describe('MMC.4 memory routes COV gaps', () => {
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
    app.use('/api/owner', createMemoryRoutes({ requireAuth: (req, res, next) => next() }));
    return app;
  }

  function makeAppThrows(actingUid) {
    const mg = jest.fn().mockRejectedValue(new Error('DB error'));
    const mdel = jest.fn().mockRejectedValue(new Error('DB error'));
    const md = jest.fn().mockReturnValue({ get: mg, delete: mdel });
    const mc = jest.fn().mockReturnValue({ doc: md });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    const moc = jest.fn().mockReturnValue({ doc: mod });
    em.__setFirestoreForTests({ collection: moc });
    const app = express();
    app.use((req, res, next) => { req.user = { uid: actingUid }; next(); });
    app.use('/api/owner', createMemoryRoutes({ requireAuth: (req, res, next) => next() }));
    return app;
  }

  test('GET memory-report con sentiment_history => sentiment_avg calculado', async () => {
    const mem = {
      key_facts: [{ fact: 'x', confidence: 'high' }],
      interaction_count: 3,
      last_interaction: 'ts',
      sentiment_history: [{ score: 0.8 }, { score: 0.6 }],
    };
    const res = await request(makeApp('u1', mem)).get('/api/owner/memory-report?uid=u1&contact=%2B57');
    expect(res.status).toBe(200);
    expect(res.body.sentiment_avg).toBeCloseTo(0.7);
  });

  test('GET memory-report Firestore throws => 500', async () => {
    const res = await request(makeAppThrows('u1')).get('/api/owner/memory-report?uid=u1&contact=%2B57');
    expect(res.status).toBe(500);
  });

  test('DELETE memory Firestore throws => 500', async () => {
    const res = await request(makeAppThrows('u1')).delete('/api/owner/memory?uid=u1&contact=%2B57');
    expect(res.status).toBe(500);
  });

  test('DELETE memory sin uid => 400', async () => {
    const res = await request(makeApp('u1', {})).delete('/api/owner/memory?contact=%2B57');
    expect(res.status).toBe(400);
  });
});


// ── Additional branch gaps ────────────────────────────────────────────────────

describe('MMC.1 episodic_memory: key_facts fallback branch', () => {
  test('appendKeyFacts: doc existe pero sin key_facts => existing=[]', async () => {
    // doc.data() returns {} (no key_facts field) -> doc.data().key_facts is undefined -> || []
    const mockSet = jest.fn().mockResolvedValue(undefined);
    const mockGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({}) });
    const md = jest.fn().mockReturnValue({ get: mockGet, set: mockSet });
    const mc = jest.fn().mockReturnValue({ doc: md });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    const moc = jest.fn().mockReturnValue({ doc: mod });
    em.__setFirestoreForTests({ collection: moc });
    await em.appendKeyFacts('u1', '+57', [{ fact: 'primer hecho', confidence: 'high' }]);
    expect(mockSet.mock.calls[0][0].key_facts).toHaveLength(1);
  });
});

describe('MMC.2 fact_extractor: extra branches', () => {
  function geminiOk(text) {
    __setFetchForTests(jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text }] } }] }),
    }));
  }

  test('conversation con content null => usa string vacio', async () => {
    // Hits m.content || '' when content is null
    geminiOk('[{"fact": "algo", "confidence": "high"}]');
    const facts = await extractKeyFacts('key', [{ role: 'user', content: null }]);
    expect(Array.isArray(facts)).toBe(true);
  });

  test('extractKeyFacts con opts que tiene model y uid', async () => {
    // Covers (opts && opts.model) true branch and opts && opts.uid true branch
    geminiOk('[{"fact": "test", "confidence": "high"}]');
    const facts = await extractKeyFacts('key', [{ role: 'user', content: 'hola' }], { model: 'gemini-1.5-pro', uid: 'u1' });
    expect(facts).toHaveLength(1);
  });
});

describe('MMC.4 memory routes: extra branches', () => {
  test('createMemoryRoutes sin opts => usa default requireAuth', () => {
    // Covers (opts && opts.requireAuth) || default branch
    const routes = createMemoryRoutes();
    expect(routes).toBeDefined();
  });

  test('GET memory-report sin sentiment_history => sentiment_avg=null', async () => {
    // memory.sentiment_history || [] when sentiment_history is missing
    const em2 = require('../core/episodic_memory');
    const mem = {
      key_facts: [{ fact: 'x', confidence: 'high' }],
      interaction_count: 2,
      last_interaction: 'ts',
      // no sentiment_history
    };
    const mg = jest.fn().mockResolvedValue({ exists: true, data: () => mem });
    const md = jest.fn().mockReturnValue({ get: mg });
    const mc = jest.fn().mockReturnValue({ doc: md });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    const moc = jest.fn().mockReturnValue({ doc: mod });
    em2.__setFirestoreForTests({ collection: moc });
    const app = require('express')();
    app.use((req, res, next) => { req.user = { uid: 'u1' }; next(); });
    app.use('/api/owner', createMemoryRoutes({ requireAuth: (req, res, next) => next() }));
    const res = await require('supertest')(app).get('/api/owner/memory-report?uid=u1&contact=%2B57');
    expect(res.status).toBe(200);
    expect(res.body.sentiment_avg).toBeNull();
    em2.__setFirestoreForTests(null);
  });

  test('GET memory-report con h.score=0 => incluido en promedio', async () => {
    // h.score || 0 when score is 0 (falsy number)
    const em2 = require('../core/episodic_memory');
    const mem = {
      key_facts: [],
      interaction_count: 0,
      last_interaction: null,
      sentiment_history: [{ score: 0 }, { score: 0.5 }],
    };
    const mg = jest.fn().mockResolvedValue({ exists: true, data: () => mem });
    const md = jest.fn().mockReturnValue({ get: mg });
    const mc = jest.fn().mockReturnValue({ doc: md });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    const moc = jest.fn().mockReturnValue({ doc: mod });
    em2.__setFirestoreForTests({ collection: moc });
    const app = require('express')();
    app.use((req, res, next) => { req.user = { uid: 'u1' }; next(); });
    app.use('/api/owner', createMemoryRoutes({ requireAuth: (req, res, next) => next() }));
    const res = await require('supertest')(app).get('/api/owner/memory-report?uid=u1&contact=%2B57');
    expect(res.status).toBe(200);
    expect(res.body.sentiment_avg).toBeCloseTo(0.25);
    em2.__setFirestoreForTests(null);
  });
});


describe('MMC.4 memory routes: key_facts/interaction_count/last_interaction falsy branches', () => {
  test('GET memory-report con campos opcionales faltantes => usa defaults', async () => {
    // Covers key_facts || [] (false), interaction_count || 0 (false), last_interaction || null (false)
    const em2 = require('../core/episodic_memory');
    const mem = {
      // no key_facts, no interaction_count, no last_interaction, no sentiment_history
    };
    const mg = jest.fn().mockResolvedValue({ exists: true, data: () => mem });
    const md = jest.fn().mockReturnValue({ get: mg });
    const mc = jest.fn().mockReturnValue({ doc: md });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    const moc = jest.fn().mockReturnValue({ doc: mod });
    em2.__setFirestoreForTests({ collection: moc });
    const app = require('express')();
    app.use((req, res, next) => { req.user = { uid: 'u1' }; next(); });
    app.use('/api/owner', createMemoryRoutes({ requireAuth: (req, res, next) => next() }));
    const res = await require('supertest')(app).get('/api/owner/memory-report?uid=u1&contact=%2B57');
    expect(res.status).toBe(200);
    expect(res.body.key_facts).toEqual([]);
    expect(res.body.interaction_count).toBe(0);
    expect(res.body.last_interaction).toBeNull();
    expect(res.body.sentiment_avg).toBeNull();
    em2.__setFirestoreForTests(null);
  });
});
