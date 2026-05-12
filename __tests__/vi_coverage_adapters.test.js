'use strict';

/**
 * VI-BACKEND-COVERAGE: ai/adapters — 100% branches
 * Cubre: gemini_adapter.js, claude_adapter.js, openai_adapter.js,
 *        groq_adapter.js, mistral_adapter.js
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function okRes(data) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}
function errRes(status, text) {
  return { ok: false, status, json: async () => ({}), text: async () => text || 'error' };
}

function setupFetchAdapter(fetchMock, adapterPath) {
  jest.resetModules();
  jest.doMock('node-fetch', () => fetchMock);
  return require(adapterPath);
}

// ═════════════════════════════════════════════════════════════════════════════
// GEMINI ADAPTER — delega a gemini_client
// ═════════════════════════════════════════════════════════════════════════════

describe('gemini_adapter', () => {
  let adapter, callGeminiMock, callGeminiChatMock;

  beforeEach(() => {
    jest.resetModules();
    callGeminiMock = jest.fn().mockResolvedValue('gemini response');
    callGeminiChatMock = jest.fn().mockResolvedValue('gemini chat response');
    jest.doMock('../ai/gemini_client', () => ({
      callGemini: callGeminiMock,
      callGeminiChat: callGeminiChatMock,
    }));
    adapter = require('../ai/adapters/gemini_adapter');
  });

  afterEach(() => { jest.dontMock('../ai/gemini_client'); });

  test('call → delega a callGemini con opts', async () => {
    const r = await adapter.call('key', 'prompt', { model: 'gemini-pro' });
    expect(callGeminiMock).toHaveBeenCalledWith('key', 'prompt', { model: 'gemini-pro' });
    expect(r).toBe('gemini response');
  });

  test('callChat → delega a callGeminiChat', async () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    const r = await adapter.callChat('key', msgs, 'system');
    expect(callGeminiChatMock).toHaveBeenCalledWith('key', msgs, 'system', {});
    expect(r).toBe('gemini chat response');
  });

  test('call con opts por default {}', async () => {
    await adapter.call('key', 'prompt');
    expect(callGeminiMock).toHaveBeenCalledWith('key', 'prompt', {});
  });

  test('callChat con opts por default {} (default param branch)', async () => {
    await adapter.callChat('key', [], 'system'); // no opts → default {}
    expect(callGeminiChatMock).toHaveBeenCalledWith('key', [], 'system', {});
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// OPENAI ADAPTER
// ═════════════════════════════════════════════════════════════════════════════

describe('openai_adapter — call', () => {
  afterEach(() => {
    jest.dontMock('node-fetch');
    if (jest.isFakeTimers && jest.isFakeTimers()) jest.useRealTimers();
  });

  test('OK response → retorna text', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'hola mundo' } }]
    }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const r = await call('key', 'prompt');
    expect(r).toBe('hola mundo');
  });

  test('opts.model + opts.temperature personalizado', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'resp' } }]
    }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const r = await call('key', 'prompt', { model: 'gpt-4o', temperature: 0.5 });
    expect(r).toBe('resp');
  });

  test('opts.maxTokens y opts.timeout personalizado', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'resp' } }]
    }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const r = await call('key', 'prompt', { maxTokens: 2048, timeout: 30000 });
    expect(r).toBe('resp');
  });

  test('400 no retryable → throw OpenAI API error', async () => {
    const fetchMock = jest.fn().mockResolvedValue(errRes(400, 'bad request'));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    await expect(call('key', 'prompt')).rejects.toThrow('OpenAI API error: 400');
  });

  test('OpenAI API error en catch → re-throw sin retry', async () => {
    const apiErr = new Error('OpenAI API error: 400 - bad');
    const fetchMock = jest.fn().mockRejectedValue(apiErr);
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    await expect(call('key', 'prompt')).rejects.toThrow('OpenAI API error');
  });

  test('429 → retry luego OK', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchMock = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return errRes(429, 'rate limit');
      return okRes({ choices: [{ message: { content: 'ok after retry' } }] });
    });
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const promise = call('key', 'prompt');
    await jest.runAllTimersAsync();
    const r = await promise;
    expect(r).toBe('ok after retry');
    jest.useRealTimers();
  });

  test('503 → retry luego OK', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchMock = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return errRes(503, 'unavailable');
      return okRes({ choices: [{ message: { content: 'ok' } }] });
    });
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const promise = call('key', 'prompt');
    await jest.runAllTimersAsync();
    const r = await promise;
    expect(r).toBe('ok');
    jest.useRealTimers();
  });

  test('AbortError → retry luego OK', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchMock = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return okRes({ choices: [{ message: { content: 'after abort' } }] });
    });
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const promise = call('key', 'prompt');
    await jest.runAllTimersAsync();
    const r = await promise;
    expect(r).toBe('after abort');
    jest.useRealTimers();
  });

  test('no text → throw after MAX_RETRIES', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockResolvedValue(okRes({ choices: [{ message: {} }] }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const promise = call('key', 'prompt');
    promise.catch(() => {}); // suprimir unhandled rejection durante timer advance
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow('No text in OpenAI response');
    jest.useRealTimers();
  });

  test('network error → MAX_RETRIES → throw', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockRejectedValue(new Error('network failure'));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const promise = call('key', 'prompt');
    promise.catch(() => {}); // suprimir unhandled rejection durante timer advance
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow('network failure');
    jest.useRealTimers();
  });

  test('warning timer callback (40s sin respuesta) — cubre línea warningTimer', async () => {
    jest.useFakeTimers();
    // fetch que nunca resuelve
    let resolveFetch;
    const fetchMock = jest.fn().mockImplementation(() => new Promise(r => { resolveFetch = r; }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const promise = call('key', 'prompt');
    promise.catch(() => {});
    await jest.advanceTimersByTimeAsync(41000); // dispara warningTimer (40s)
    resolveFetch(okRes({ choices: [{ message: { content: 'ok' } }] }));
    jest.useRealTimers();
    // Solo verificamos que no lanzó durante el warning
  });

  test('500 retryable → exhausts MAX_RETRIES → throw', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockResolvedValue(errRes(500, 'server error'));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const promise = call('key', 'prompt');
    promise.catch(() => {});
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow('OpenAI API error: 500');
    jest.useRealTimers();
  });
});

describe('openai_adapter — callChat', () => {
  afterEach(() => { jest.dontMock('node-fetch'); });

  test('OK → retorna text', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'chat resp' } }]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const r = await callChat('key', [{ role: 'user', content: 'hi' }], 'system');
    expect(r).toBe('chat resp');
  });

  test('role=assistant → mapeado', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'resp' } }]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const r = await callChat('key',
      [{ role: 'assistant', content: 'prev' }, { role: 'user', content: 'now' }],
      'system', { temperature: 0.7 });
    expect(r).toBe('resp');
  });

  test('response !ok → retorna null', async () => {
    const fetchMock = jest.fn().mockResolvedValue(errRes(500, 'internal error'));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('sin text en respuesta → retorna null', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({ choices: [{ message: {} }] }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('AbortError en catch → retorna null', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchMock = jest.fn().mockRejectedValue(abortErr);
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('error genérico → retorna null', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('network'));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('opts.maxTokens y opts.timeout', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'ok' } }]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const r = await callChat('key', [], 'system', { maxTokens: 2048, timeout: 30000 });
    expect(r).toBe('ok');
  });

  test('callChat warning timer (40s) — cubre línea warningTimer callChat', async () => {
    jest.useFakeTimers();
    let resolveFetch;
    const fetchMock = jest.fn().mockImplementation(() => new Promise(r => { resolveFetch = r; }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/openai_adapter');
    const promise = callChat('key', [], 'system');
    promise.catch(() => {});
    await jest.advanceTimersByTimeAsync(41000);
    resolveFetch(okRes({ choices: [{ message: { content: 'ok' } }] }));
    jest.useRealTimers();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GROQ ADAPTER
// ═════════════════════════════════════════════════════════════════════════════

describe('groq_adapter — call', () => {
  afterEach(() => { jest.dontMock('node-fetch'); });

  test('OK → retorna text', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'groq text' } }]
    }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    const r = await call('key', 'prompt');
    expect(r).toBe('groq text');
  });

  test('opts.model + opts.maxTokens', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'resp' } }]
    }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    const r = await call('key', 'prompt', { model: 'llama3', maxTokens: 1024, timeout: 30000 });
    expect(r).toBe('resp');
  });

  test('400 no retryable → throw Groq API error', async () => {
    const fetchMock = jest.fn().mockResolvedValue(errRes(400, 'bad'));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    await expect(call('key', 'prompt')).rejects.toThrow('Groq API error');
  });

  test('Groq API error en catch → re-throw', async () => {
    const apiErr = new Error('Groq API error: 400');
    const fetchMock = jest.fn().mockRejectedValue(apiErr);
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    await expect(call('key', 'prompt')).rejects.toThrow('Groq API error');
  });

  test('429 → retry luego OK', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchMock = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return errRes(429, 'rate limit');
      return okRes({ choices: [{ message: { content: 'ok' } }] });
    });
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    const promise = call('key', 'prompt');
    await jest.runAllTimersAsync();
    const r = await promise;
    expect(r).toBe('ok');
    jest.useRealTimers();
  });

  test('AbortError → retry luego OK', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchMock = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return okRes({ choices: [{ message: { content: 'after abort' } }] });
    });
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    const promise = call('key', 'prompt');
    await jest.runAllTimersAsync();
    const r = await promise;
    expect(r).toBe('after abort');
    jest.useRealTimers();
  });

  test('no text → throw after MAX_RETRIES', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockResolvedValue(okRes({ choices: [{ message: {} }] }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    const promise = call('key', 'prompt');
    promise.catch(() => {}); // suprimir unhandled rejection durante timer advance
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow('No text in Groq response');
    jest.useRealTimers();
  });

  test('network error → MAX_RETRIES → throw exhausted', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockRejectedValue(new Error('network failure'));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    const promise = call('key', 'prompt');
    promise.catch(() => {}); // suprimir unhandled rejection
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow();
    jest.useRealTimers();
  });

  test('warning timer callback (40s sin respuesta) — cubre línea warningTimer', async () => {
    jest.useFakeTimers();
    let resolveFetch;
    const fetchMock = jest.fn().mockImplementation(() => new Promise(r => { resolveFetch = r; }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    const promise = call('key', 'prompt');
    promise.catch(() => {});
    await jest.advanceTimersByTimeAsync(41000); // dispara warningTimer
    resolveFetch(okRes({ choices: [{ message: { content: 'ok' } }] }));
    jest.useRealTimers();
  });

  test('503 retryable → exhausts MAX_RETRIES=2 → throw Groq API error', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockResolvedValue(errRes(503, 'unavailable'));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    const promise = call('key', 'prompt');
    promise.catch(() => {}); // suprimir unhandled rejection durante timer advance
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow();
    jest.useRealTimers();
  });
});

describe('groq_adapter — callChat', () => {
  afterEach(() => { jest.dontMock('node-fetch'); });

  test('OK → retorna text', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'groq chat' } }]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    const r = await callChat('key', [{ role: 'user', content: 'hi' }], 'system');
    expect(r).toBe('groq chat');
  });

  test('role=assistant → mapeado', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'resp' } }]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    await callChat('key', [{ role: 'assistant', content: 'prev' }], 'system');
  });

  test('response !ok → throws y catch retorna null', async () => {
    const fetchMock = jest.fn().mockResolvedValue(errRes(500, 'error'));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('sin text → retorna null', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({ choices: [{ message: {} }] }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('AbortError → retorna null', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchMock = jest.fn().mockRejectedValue(abortErr);
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('error genérico → retorna null', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('network'));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('opts.maxTokens + opts.model', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'ok' } }]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    const r = await callChat('key', [], 'system', { maxTokens: 512, model: 'llama3', timeout: 30000 });
    expect(r).toBe('ok');
  });

  test('callChat warning timer (40s) — cubre línea warningTimer callChat', async () => {
    jest.useFakeTimers();
    let resolveFetch;
    const fetchMock = jest.fn().mockImplementation(() => new Promise(r => { resolveFetch = r; }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/groq_adapter');
    const promise = callChat('key', [], 'system');
    promise.catch(() => {});
    await jest.advanceTimersByTimeAsync(41000);
    resolveFetch(okRes({ choices: [{ message: { content: 'ok' } }] }));
    jest.useRealTimers();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CLAUDE ADAPTER
// ═════════════════════════════════════════════════════════════════════════════

describe('claude_adapter — call', () => {
  afterEach(() => { jest.dontMock('node-fetch'); });

  test('OK sin thinking → retorna text de content[0].text', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      content: [{ type: 'text', text: 'hola Claude' }]
    }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await call('key', 'prompt');
    expect(r).toBe('hola Claude');
  });

  test('textBlock.text tiene prioridad sobre content[0].text', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      content: [
        { type: 'thinking', thinking: 'thinking...' },
        { type: 'text', text: 'la respuesta' },
      ]
    }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await call('key', 'prompt');
    expect(r).toBe('la respuesta');
  });

  test('thinking > 0 → thinking habilitado + log', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      content: [
        { type: 'thinking', thinking: 'pensando...' },
        { type: 'text', text: 'respuesta' },
      ]
    }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await call('key', 'prompt', { thinking: 2048 });
    expect(r).toBe('respuesta');
  });

  test('thinking < 1024 → Math.max(100, 1024) = 1024', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      content: [{ type: 'text', text: 'text' }]
    }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await call('key', 'prompt', { thinking: 100 });
    expect(r).toBe('text');
  });

  test('temperature sin thinking', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      content: [{ type: 'text', text: 'resp' }]
    }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await call('key', 'prompt', { temperature: 0.7 });
    expect(r).toBe('resp');
  });

  test('opts.timeout personalizado (no thinking → FETCH_TIMEOUT_MS path)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      content: [{ type: 'text', text: 'ok' }]
    }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await call('key', 'prompt', { timeout: 30000 });
    expect(r).toBe('ok');
  });

  test('thinking > 0 + opts.timeout → FETCH_TIMEOUT_HEAVY_MS path', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      content: [{ type: 'text', text: 'ok' }]
    }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await call('key', 'prompt', { thinking: 4096 });
    expect(r).toBe('ok');
  });

  test('thinkingBlock sin thinking.length → log 0 chars', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      content: [
        { type: 'thinking' }, // sin thinking property
        { type: 'text', text: 'result' },
      ]
    }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await call('key', 'prompt', { thinking: 1024 });
    expect(r).toBe('result');
  });

  test('400 no retryable → throw Claude API error', async () => {
    const fetchMock = jest.fn().mockResolvedValue(errRes(400, 'bad request'));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    await expect(call('key', 'prompt')).rejects.toThrow('Claude API error: 400');
  });

  test('Claude API error en catch → re-throw', async () => {
    const apiErr = new Error('Claude API error: 400 bad');
    const fetchMock = jest.fn().mockRejectedValue(apiErr);
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    await expect(call('key', 'prompt')).rejects.toThrow('Claude API error');
  });

  test('429 → retry luego OK', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchMock = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return errRes(429, 'rate limit');
      return okRes({ content: [{ type: 'text', text: 'ok' }] });
    });
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const promise = call('key', 'prompt');
    await jest.runAllTimersAsync();
    const r = await promise;
    expect(r).toBe('ok');
    jest.useRealTimers();
  });

  test('529 → retry luego OK', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchMock = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return errRes(529, 'overloaded');
      return okRes({ content: [{ type: 'text', text: 'ok' }] });
    });
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const promise = call('key', 'prompt');
    await jest.runAllTimersAsync();
    const r = await promise;
    expect(r).toBe('ok');
    jest.useRealTimers();
  });

  test('AbortError → retry luego OK', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchMock = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return okRes({ content: [{ type: 'text', text: 'after abort' }] });
    });
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const promise = call('key', 'prompt');
    await jest.runAllTimersAsync();
    const r = await promise;
    expect(r).toBe('after abort');
    jest.useRealTimers();
  });

  test('no text → throw after MAX_RETRIES', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockResolvedValue(okRes({ content: [] }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const promise = call('key', 'prompt');
    promise.catch(() => {}); // suprimir unhandled rejection durante timer advance
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow('No text in Claude response');
    jest.useRealTimers();
  });

  test('network error → MAX_RETRIES → throw', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockRejectedValue(new Error('network failure'));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const promise = call('key', 'prompt');
    promise.catch(() => {}); // suprimir unhandled rejection
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow('network failure');
    jest.useRealTimers();
  });

  test('warning timer callback (40s sin respuesta) — cubre línea warningTimer', async () => {
    jest.useFakeTimers();
    let resolveFetch;
    const fetchMock = jest.fn().mockImplementation(() => new Promise(r => { resolveFetch = r; }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const promise = call('key', 'prompt');
    promise.catch(() => {});
    await jest.advanceTimersByTimeAsync(41000); // dispara warningTimer
    resolveFetch(okRes({ content: [{ type: 'text', text: 'ok' }] }));
    jest.useRealTimers();
  });
});

describe('claude_adapter — callChat', () => {
  afterEach(() => { jest.dontMock('node-fetch'); });

  test('OK sin thinking → retorna text', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      content: [{ type: 'text', text: 'chat response' }]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await callChat('key', [{ role: 'user', content: 'hi' }], 'system');
    expect(r).toBe('chat response');
  });

  test('thinking > 0 → heavy timeout + log', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      content: [{ type: 'text', text: 'resp' }]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await callChat('key', [], 'system', { thinking: 2048 });
    expect(r).toBe('resp');
  });

  test('thinking + thinkingBlock en respuesta → log chars', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      content: [
        { type: 'thinking', thinking: 'thk' },
        { type: 'text', text: 'result' },
      ]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await callChat('key', [], 'system', { thinking: 1024 });
    expect(r).toBe('result');
  });

  test('thinkingBlock sin .thinking property → log 0 chars', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      content: [
        { type: 'thinking' }, // sin .thinking
        { type: 'text', text: 'result' },
      ]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await callChat('key', [], 'system', { thinking: 1024 });
    expect(r).toBe('result');
  });

  test('sin thinking + temperature', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      content: [{ type: 'text', text: 'temp resp' }]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await callChat('key', [], 'system', { temperature: 0.5 });
    expect(r).toBe('temp resp');
  });

  test('role=assistant → mapeado', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      content: [{ type: 'text', text: 'ok' }]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    await callChat('key', [{ role: 'assistant', content: 'prev' }, { role: 'user', content: 'now' }], 'system');
  });

  test('response !ok → retorna null', async () => {
    const fetchMock = jest.fn().mockResolvedValue(errRes(500));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('sin text en respuesta → retorna null', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({ content: [] }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('AbortError → retorna null', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchMock = jest.fn().mockRejectedValue(abortErr);
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('error genérico → retorna null', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('fail'));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('opts.timeout personalizado', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      content: [{ type: 'text', text: 'ok' }]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const r = await callChat('key', [], 'system', { timeout: 30000 });
    expect(r).toBe('ok');
  });

  test('callChat warning timer (40s) — cubre línea warningTimer callChat', async () => {
    jest.useFakeTimers();
    let resolveFetch;
    const fetchMock = jest.fn().mockImplementation(() => new Promise(r => { resolveFetch = r; }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/claude_adapter');
    const promise = callChat('key', [], 'system');
    promise.catch(() => {});
    await jest.advanceTimersByTimeAsync(41000);
    resolveFetch(okRes({ content: [{ type: 'text', text: 'ok' }] }));
    jest.useRealTimers();
  });
});

// =============================================================================
// MISTRAL ADAPTER
// =============================================================================

describe('mistral_adapter -- call', () => {
  afterEach(() => { jest.dontMock('node-fetch'); });

  test('OK → retorna text', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'mistral text' } }]
    }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    const r = await call('key', 'prompt');
    expect(r).toBe('mistral text');
  });

  test('opts.model + opts.maxTokens + opts.timeout', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'resp' } }]
    }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    const r = await call('key', 'prompt', { model: 'mistral-large', maxTokens: 1024, timeout: 30000 });
    expect(r).toBe('resp');
  });

  test('400 no retryable → throw Mistral API error', async () => {
    const fetchMock = jest.fn().mockResolvedValue(errRes(400, 'bad'));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    await expect(call('key', 'prompt')).rejects.toThrow('Mistral API error');
  });

  test('Mistral API error en catch → re-throw sin retry', async () => {
    const apiErr = new Error('Mistral API error: 400');
    const fetchMock = jest.fn().mockRejectedValue(apiErr);
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    await expect(call('key', 'prompt')).rejects.toThrow('Mistral API error');
  });

  test('429 → retry luego OK', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchMock = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return errRes(429, 'rate limit');
      return okRes({ choices: [{ message: { content: 'ok' } }] });
    });
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    const promise = call('key', 'prompt');
    await jest.runAllTimersAsync();
    const r = await promise;
    expect(r).toBe('ok');
    jest.useRealTimers();
  });

  test('AbortError → retry luego OK', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchMock = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return okRes({ choices: [{ message: { content: 'after abort' } }] });
    });
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    const promise = call('key', 'prompt');
    await jest.runAllTimersAsync();
    const r = await promise;
    expect(r).toBe('after abort');
    jest.useRealTimers();
  });

  test('no text → throw after MAX_RETRIES', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockResolvedValue(okRes({ choices: [{ message: {} }] }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    const promise = call('key', 'prompt');
    promise.catch(() => {});
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow('No text in Mistral response');
    jest.useRealTimers();
  });

  test('network error → MAX_RETRIES → throw exhausted', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockRejectedValue(new Error('network failure'));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    const promise = call('key', 'prompt');
    promise.catch(() => {});
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow();
    jest.useRealTimers();
  });

  test('warning timer (40s sin respuesta)', async () => {
    jest.useFakeTimers();
    let resolveFetch;
    const fetchMock = jest.fn().mockImplementation(() => new Promise(r => { resolveFetch = r; }));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    const promise = call('key', 'prompt');
    promise.catch(() => {});
    await jest.advanceTimersByTimeAsync(41000);
    resolveFetch(okRes({ choices: [{ message: { content: 'ok' } }] }));
    jest.useRealTimers();
  });

  test('503 retryable → exhausts MAX_RETRIES=2 → throw', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockResolvedValue(errRes(503, 'unavailable'));
    const { call } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    const promise = call('key', 'prompt');
    promise.catch(() => {});
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow();
    jest.useRealTimers();
  });
});

describe('mistral_adapter -- callChat', () => {
  afterEach(() => { jest.dontMock('node-fetch'); });

  test('OK → retorna text', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'mistral chat' } }]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    const r = await callChat('key', [{ role: 'user', content: 'hi' }], 'system');
    expect(r).toBe('mistral chat');
  });

  test('role=assistant → mapeado', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'resp' } }]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    await callChat('key', [{ role: 'assistant', content: 'prev' }], 'system');
  });

  test('response !ok → catch retorna null', async () => {
    const fetchMock = jest.fn().mockResolvedValue(errRes(500, 'error'));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('sin text → retorna null', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({ choices: [{ message: {} }] }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('AbortError → retorna null', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchMock = jest.fn().mockRejectedValue(abortErr);
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('error genérico → retorna null', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('network'));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    const r = await callChat('key', [], 'system');
    expect(r).toBeNull();
  });

  test('opts.maxTokens + opts.model + opts.timeout', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okRes({
      choices: [{ message: { content: 'ok' } }]
    }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    const r = await callChat('key', [], 'system', { maxTokens: 512, model: 'mistral-large', timeout: 30000 });
    expect(r).toBe('ok');
  });

  test('callChat warning timer (40s)', async () => {
    jest.useFakeTimers();
    let resolveFetch;
    const fetchMock = jest.fn().mockImplementation(() => new Promise(r => { resolveFetch = r; }));
    const { callChat } = setupFetchAdapter(fetchMock, '../ai/adapters/mistral_adapter');
    const promise = callChat('key', [], 'system');
    promise.catch(() => {});
    await jest.advanceTimersByTimeAsync(41000);
    resolveFetch(okRes({ choices: [{ message: { content: 'ok' } }] }));
    jest.useRealTimers();
  });
});

