'use strict';
const { callWithFallback, callModel, MODELS, FALLBACK_STATUSES, TIMEOUT_MS, __setFetchForTests } = require('../core/gemini_fallback');

const FAKE_API_KEY = 'test_key_123';
const BODY = { contents: [{ role: 'user', parts: [{ text: 'hola' }] }] };

afterEach(() => { __setFetchForTests(null); });

describe('MODELS y constantes', () => {
  test('PRIMARY=gemini-2.5-flash, SECONDARY=gemini-1.5-flash', () => {
    expect(MODELS.PRIMARY).toBe('gemini-2.5-flash');
    expect(MODELS.SECONDARY).toBe('gemini-1.5-flash');
  });
  test('FALLBACK_STATUSES incluye 429, 503', () => {
    expect(FALLBACK_STATUSES.has(429)).toBe(true);
    expect(FALLBACK_STATUSES.has(503)).toBe(true);
    expect(FALLBACK_STATUSES.has(200)).toBe(false);
  });
  test('TIMEOUT_MS = 45000', () => {
    expect(TIMEOUT_MS).toBe(45000);
  });
});

describe('callWithFallback — validacion', () => {
  test('lanza error si apiKey vacia', async () => {
    await expect(callWithFallback('', BODY)).rejects.toThrow('apiKey requerida');
  });
  test('lanza error si body sin contents', async () => {
    await expect(callWithFallback(FAKE_API_KEY, {})).rejects.toThrow('body.contents requerido');
  });
});

describe('callWithFallback — primary ok', () => {
  test('retorna data del primary si responde 200', async () => {
    __setFetchForTests(async () => ({
      ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    }));
    const r = await callWithFallback(FAKE_API_KEY, BODY);
    expect(r.usedFallback).toBe(false);
    expect(r.modelUsed).toBe(MODELS.PRIMARY);
    expect(r.data.candidates).toBeDefined();
  });
});

describe('callWithFallback — fallback', () => {
  test('usa secondary si primary retorna 503', async () => {
    let callCount = 0;
    __setFetchForTests(async (url) => {
      callCount++;
      if (url.includes(MODELS.PRIMARY)) {
        return { ok: false, status: 503, json: async () => ({ error: 'overloaded' }) };
      }
      return { ok: true, status: 200, json: async () => ({ candidates: [] }) };
    });
    const r = await callWithFallback(FAKE_API_KEY, BODY);
    expect(r.usedFallback).toBe(true);
    expect(r.modelUsed).toBe(MODELS.SECONDARY);
    expect(callCount).toBe(2);
  });

  test('usa secondary si primary retorna 429', async () => {
    __setFetchForTests(async (url) => {
      if (url.includes(MODELS.PRIMARY)) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ candidates: [] }) };
    });
    const r = await callWithFallback(FAKE_API_KEY, BODY);
    expect(r.usedFallback).toBe(true);
  });

  test('lanza error si secondary tambien falla', async () => {
    __setFetchForTests(async () => ({
      ok: false, status: 503, json: async () => ({ error: 'down' })
    }));
    await expect(callWithFallback(FAKE_API_KEY, BODY)).rejects.toThrow('fallback también falló');
  });

  test('NO hace fallback para error 400 (bad request)', async () => {
    __setFetchForTests(async () => ({
      ok: false, status: 400, json: async () => ({ error: 'bad request' })
    }));
    await expect(callWithFallback(FAKE_API_KEY, BODY)).rejects.toThrow('primary error 400');
  });

  test('hace fallback si primary timeout (status 408)', async () => {
    let callCount = 0;
    __setFetchForTests(async (url) => {
      callCount++;
      if (url.includes(MODELS.PRIMARY)) {
        const err = new Error('aborted'); err.name = 'AbortError';
        throw err;
      }
      return { ok: true, status: 200, json: async () => ({ candidates: [] }) };
    });
    const r = await callWithFallback(FAKE_API_KEY, BODY);
    expect(r.usedFallback).toBe(true);
  });

  test('respeta modelos custom en opts', async () => {
    let calledModels = [];
    __setFetchForTests(async (url) => {
      if (url.includes('custom-primary')) { calledModels.push('primary'); return { ok: false, status: 503, json: async () => ({}) }; }
      if (url.includes('custom-secondary')) { calledModels.push('secondary'); return { ok: true, status: 200, json: async () => ({}) }; }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const r = await callWithFallback(FAKE_API_KEY, BODY, { primaryModel: 'custom-primary', secondaryModel: 'custom-secondary' });
    expect(calledModels).toContain('primary');
    expect(calledModels).toContain('secondary');
    expect(r.usedFallback).toBe(true);
  });
});
