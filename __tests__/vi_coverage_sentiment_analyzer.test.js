'use strict';

/**
 * VI-BACKEND-COVERAGE: sentiment_analyzer.js — 100% branches
 */

const { analyzeSentiment, analyzeConversation, SENTIMENTS, __setFirestoreForTests } = require('../core/sentiment_analyzer');

// ── SENTIMENTS ────────────────────────────────────────────────────────────────

describe('SENTIMENTS', () => {
  test('es un array frozen con los 4 valores', () => {
    expect(SENTIMENTS).toContain('positive');
    expect(SENTIMENTS).toContain('neutral');
    expect(SENTIMENTS).toContain('negative');
    expect(SENTIMENTS).toContain('urgent');
    expect(() => { SENTIMENTS.push('x'); }).toThrow();
  });
});

// ── analyzeSentiment ──────────────────────────────────────────────────────────

describe('analyzeSentiment', () => {
  test('null/undefined → neutral score=0', () => {
    expect(analyzeSentiment(null)).toEqual({ sentiment: 'neutral', score: 0, signals: [] });
    expect(analyzeSentiment('')).toEqual({ sentiment: 'neutral', score: 0, signals: [] });
    expect(analyzeSentiment(undefined)).toEqual({ sentiment: 'neutral', score: 0, signals: [] });
  });

  test('texto sin señales → neutral', () => {
    const r = analyzeSentiment('hola cómo estás');
    expect(r.sentiment).toBe('neutral');
    expect(r.score).toBe(0);
    expect(r.signals).toHaveLength(0);
  });

  test('palabra urgente → urgent score=-10', () => {
    const r = analyzeSentiment('necesito ayuda urgente ahora');
    expect(r.sentiment).toBe('urgent');
    expect(r.score).toBe(-10);
    expect(r.signals.length).toBeGreaterThan(0);
  });

  test('urgente tiene prioridad sobre negativo', () => {
    const r = analyzeSentiment('que terrible problema urgente');
    expect(r.sentiment).toBe('urgent');
  });

  test('palabra negativa → negative score negativo', () => {
    const r = analyzeSentiment('esto es terrible, tengo una queja');
    expect(r.sentiment).toBe('negative');
    expect(r.score).toBeLessThan(0);
    expect(r.signals.length).toBeGreaterThan(0);
  });

  test('palabra positiva → positive score positivo', () => {
    const r = analyzeSentiment('gracias, todo excelente');
    expect(r.sentiment).toBe('positive');
    expect(r.score).toBeGreaterThan(0);
    expect(r.signals.length).toBeGreaterThan(0);
  });
});

// ── analyzeConversation ───────────────────────────────────────────────────────

function makeDb(messages, exists = true) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: () => Promise.resolve({
              exists,
              data: () => ({ messages }),
            }),
          }),
        }),
      }),
    }),
  };
}

describe('analyzeConversation', () => {
  test('uid o phone faltante → throw', async () => {
    await expect(analyzeConversation('', '+57')).rejects.toThrow('uid and phone required');
    await expect(analyzeConversation('uid', '')).rejects.toThrow('uid and phone required');
    await expect(analyzeConversation(null, null)).rejects.toThrow('uid and phone required');
  });

  test('snap no existe → overall=neutral, 0 mensajes', async () => {
    __setFirestoreForTests(makeDb([], false));
    const r = await analyzeConversation('uid-1', '+57001');
    expect(r.overall).toBe('neutral');
    expect(r.messageCount).toBe(0);
  });

  test('snap sin mensajes → neutral', async () => {
    __setFirestoreForTests(makeDb([]));
    const r = await analyzeConversation('uid-2', '+57002');
    expect(r.overall).toBe('neutral');
    expect(r.analyses).toHaveLength(0);
  });

  test('mensajes con urgente → overall=urgent', async () => {
    __setFirestoreForTests(makeDb([
      { role: 'lead', content: 'urgente por favor' },
    ]));
    const r = await analyzeConversation('uid-3', '+57003');
    expect(r.overall).toBe('urgent');
    expect(r.messageCount).toBe(1);
  });

  test('mensajes con negativo (sin urgente) → overall=negative', async () => {
    __setFirestoreForTests(makeDb([
      { role: 'lead', content: 'esto es terrible' },
      { role: 'miia', content: 'lamento eso' },
    ]));
    const r = await analyzeConversation('uid-4', '+57004');
    expect(r.overall).toBe('negative');
    expect(r.messageCount).toBe(1); // solo filtra role=lead
  });

  test('mayoría positivos → overall=positive', async () => {
    __setFirestoreForTests(makeDb([
      { role: 'lead', content: 'gracias excelente' },
      { role: 'lead', content: 'perfecto genial' },
      { role: 'lead', content: 'hola' },
    ]));
    const r = await analyzeConversation('uid-5', '+57005');
    expect(r.overall).toBe('positive');
  });

  test('snap.data sin campo messages → usa [] default', async () => {
    const db = {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: () => ({
              get: () => Promise.resolve({ exists: true, data: () => ({}) }),
            }),
          }),
        }),
      }),
    };
    __setFirestoreForTests(db);
    const r = await analyzeConversation('uid-6', '+57006');
    expect(r.messageCount).toBe(0);
    expect(r.overall).toBe('neutral');
  });
});

// ── getDb() firebase fallback ─────────────────────────────────────────────────

describe('getDb() fallback a config/firebase', () => {
  test('sin _db → usa config/firebase virtual', async () => {
    jest.resetModules();
    jest.doMock('../config/firebase', () => ({
      db: {
        collection: () => ({
          doc: () => ({
            collection: () => ({
              doc: () => ({
                get: () => Promise.resolve({ exists: false, data: () => ({}) }),
              }),
            }),
          }),
        }),
      },
    }), { virtual: true });
    const sa = require('../core/sentiment_analyzer');
    const r = await sa.analyzeConversation('uid-fb', '+57000');
    expect(r.overall).toBe('neutral');
    jest.dontMock('../config/firebase');
  });
});
