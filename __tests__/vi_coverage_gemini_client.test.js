'use strict';

const gc = require('../ai/gemini_client');
const fetchMock = jest.fn();

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  gc.__setFetchForTests(fetchMock);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  gc.__setFetchForTests(null);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function okResp(text, grounding) {
  const data = {
    candidates: [{
      content: { parts: text ? [{ text }] : [] },
      ...(grounding && { groundingMetadata: grounding }),
    }],
  };
  return { ok: true, status: 200, json: jest.fn().mockResolvedValue(data), text: jest.fn().mockResolvedValue('') };
}
function errResp(status, body) {
  return { ok: false, status, json: jest.fn().mockResolvedValue({}), text: jest.fn().mockResolvedValue(body || 'err') };
}
function abortErr() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }

describe('callGemini — opts y model', () => {
  test('sin opts => DEFAULT_MODEL (branch opts.model falsy)', async () => {
    fetchMock.mockResolvedValue(okResp('hi'));
    const r = await gc.callGemini('key', 'prompt');
    expect(r).toBe('hi');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('gemini-2.5-flash'), expect.any(Object));
  });
  test('opts.model => usa ese model (branch opts.model truthy)', async () => {
    fetchMock.mockResolvedValue(okResp('hi'));
    await gc.callGemini('key', 'prompt', { model: 'gemini-pro' });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('gemini-pro'), expect.any(Object));
  });
  test('opts.retries=0 => usa 0 (branch opts.retries ?? MAX_RETRIES con 0)', async () => {
    fetchMock.mockResolvedValue(okResp('hi'));
    expect(await gc.callGemini('key', 'prompt', { retries: 0 })).toBe('hi');
  });
  test('temperature/topP/topK set => en genConfig (branch != null truthy x3)', async () => {
    fetchMock.mockResolvedValue(okResp('hi'));
    await gc.callGemini('key', 'p', { temperature: 0.5, topP: 0.9, topK: 40 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig.temperature).toBe(0.5);
    expect(body.generationConfig.topP).toBe(0.9);
    expect(body.generationConfig.topK).toBe(40);
  });
  test('thinkingBudget > 0 => thinkingConfig + log (branch truthy)', async () => {
    fetchMock.mockResolvedValue(okResp('hi'));
    await gc.callGemini('key', 'p', { thinkingBudget: 1000 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(1000);
  });
  test('thinkingBudget = 0 => no thinkingConfig (branch > 0 false)', async () => {
    fetchMock.mockResolvedValue(okResp('hi'));
    await gc.callGemini('key', 'p', { thinkingBudget: 0 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig).toBeUndefined();
  });
  test('enableSearch => tools en payload + isHeavyQuery (branch enableSearch truthy)', async () => {
    fetchMock.mockResolvedValue(okResp('hi'));
    await gc.callGemini('key', 'p', { enableSearch: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toBeDefined();
  });
  test('opts.timeout custom => usa ese timeout (branch opts.timeout truthy)', async () => {
    fetchMock.mockResolvedValue(okResp('hi'));
    await gc.callGemini('key', 'p', { timeout: 1000 });
    expect(fetchMock).toHaveBeenCalled();
  });
  test('isHeavyQuery por thinkingBudget => FETCH_TIMEOUT_HEAVY_MS (branch isHeavyQuery via thinking)', async () => {
    fetchMock.mockResolvedValue(okResp('hi'));
    await gc.callGemini('key', 'p', { thinkingBudget: 100 });
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('callGemini — extractText branches', () => {
  test('partes con texto => join text (branch text truthy)', async () => {
    fetchMock.mockResolvedValue(okResp('hello world'));
    expect(await gc.callGemini('k', 'p')).toBe('hello world');
  });
  test('sin texto en parts => throw No text (branch !text)', async () => {
    fetchMock.mockResolvedValue(okResp(null));
    await expect(gc.callGemini('k', 'p', { retries: 0 })).rejects.toThrow('No text in Gemini response');
  });
  test('data sin parts => || [] default branch', async () => {
    const data = { candidates: [{ content: {} }] };
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: jest.fn().mockResolvedValue(data), text: jest.fn().mockResolvedValue('') });
    await expect(gc.callGemini('k', 'p', { retries: 0 })).rejects.toThrow('No text in Gemini response');
  });
  test('grounding con webSearchQueries => log Busquedas (branch length truthy)', async () => {
    const g = { webSearchQueries: ['test query'], groundingChunks: [] };
    fetchMock.mockResolvedValue(okResp('res', g));
    await gc.callGemini('k', 'p');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Búsquedas'));
  });
  test('grounding chunk con title => usa title (branch web.title truthy)', async () => {
    const g = { groundingChunks: [{ web: { title: 'My Title', uri: 'http://x.com' } }] };
    fetchMock.mockResolvedValue(okResp('res', g));
    await gc.callGemini('k', 'p');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Fuentes'));
  });
  test('grounding chunk sin title, con uri => usa uri (branch title falsy, uri truthy)', async () => {
    const g = { groundingChunks: [{ web: { uri: 'http://x.com' } }] };
    fetchMock.mockResolvedValue(okResp('res', g));
    await gc.callGemini('k', 'p');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Fuentes'));
  });
  test('grounding chunk sin title ni uri => unknown (branch ambos falsy)', async () => {
    const g = { groundingChunks: [{ web: {} }] };
    fetchMock.mockResolvedValue(okResp('res', g));
    await gc.callGemini('k', 'p');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('unknown'));
  });
});

describe('callGemini — retry HTTP branches', () => {
  test('503 + attempt < retries => retry (branch isRetryable && attempt<retries truthy)', async () => {
    fetchMock.mockResolvedValueOnce(errResp(503)).mockResolvedValue(okResp('ok'));
    const p = gc.callGemini('k', 'p', { retries: 2 });
    await jest.runAllTimersAsync();
    expect(await p).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  test('429 + attempt < retries => QUOTA-EXHAUST log (branch status===429 en retry)', async () => {
    fetchMock.mockResolvedValueOnce(errResp(429)).mockResolvedValue(okResp('ok'));
    const p = gc.callGemini('k', 'p', { retries: 2 });
    await jest.runAllTimersAsync();
    await p;
    expect(console.error).toHaveBeenCalledWith('[V2-ALERT][QUOTA-EXHAUST]', expect.any(Object));
  });
  test('503 exhausted => throw Gemini API error (branch isRetryable false last attempt)', async () => {
    fetchMock.mockResolvedValue(errResp(503, 'service unavailable'));
    const p = gc.callGemini('k', 'p', { retries: 1 });
    const check = expect(p).rejects.toThrow('Gemini API error: 503');
    await jest.runAllTimersAsync();
    await check;
  });
  test('429 exhausted => QUOTA-EXHAUST final + throw (branch status===429 retries_exhausted)', async () => {
    fetchMock.mockResolvedValue(errResp(429, 'quota'));
    const p = gc.callGemini('k', 'p', { retries: 1 });
    const check = expect(p).rejects.toThrow('Gemini API error');
    await jest.runAllTimersAsync();
    await check;
    expect(console.error).toHaveBeenCalledWith('[V2-ALERT][QUOTA-EXHAUST]', expect.objectContaining({ retries_exhausted: true }));
  });
  test('400 con retries=0 => throw Gemini API error (branch !isRetryable)', async () => {
    fetchMock.mockResolvedValue(errResp(400, 'bad req'));
    await expect(gc.callGemini('k', 'p', { retries: 0 })).rejects.toThrow('Gemini API error: 400');
  });
  test('400 con retries>0 => re-throw via err.message.includes (branch Gemini API error re-throw)', async () => {
    fetchMock.mockResolvedValue(errResp(400, 'bad req'));
    const p = gc.callGemini('k', 'p', { retries: 2 });
    const check = expect(p).rejects.toThrow('Gemini API error: 400');
    await jest.runAllTimersAsync();
    await check;
  });
  test('RETRY_DELAYS[3] || 45000 => fallback delay (branch RETRY_DELAYS[attempt] falsy)', async () => {
    fetchMock
      .mockResolvedValueOnce(errResp(503))
      .mockResolvedValueOnce(errResp(503))
      .mockResolvedValueOnce(errResp(503))
      .mockResolvedValueOnce(errResp(503))
      .mockResolvedValue(okResp('ok'));
    const p = gc.callGemini('k', 'p', { retries: 4 });
    await jest.runAllTimersAsync();
    expect(await p).toBe('ok');
  });
});

describe('callGemini — AbortError branches', () => {
  test('AbortError + attempt < retries => retry (branch attempt<retries en AbortError)', async () => {
    fetchMock.mockRejectedValueOnce(abortErr()).mockResolvedValue(okResp('ok'));
    const p = gc.callGemini('k', 'p', { retries: 1 });
    await jest.runAllTimersAsync();
    expect(await p).toBe('ok');
  });
  test('AbortError + attempt === retries => throw timeout (branch attempt<retries false)', async () => {
    fetchMock.mockRejectedValue(abortErr());
    const p = gc.callGemini('k', 'p', { retries: 1 });
    const check = expect(p).rejects.toThrow('Gemini timeout');
    await jest.runAllTimersAsync();
    await check;
  });
  test('AbortError con retries=4 => RETRY_DELAYS[3] || 45000 fallback (branch falsy delay)', async () => {
    fetchMock
      .mockRejectedValueOnce(abortErr())
      .mockRejectedValueOnce(abortErr())
      .mockRejectedValueOnce(abortErr())
      .mockRejectedValueOnce(abortErr())
      .mockResolvedValue(okResp('ok'));
    const p = gc.callGemini('k', 'p', { retries: 4 });
    await jest.runAllTimersAsync();
    expect(await p).toBe('ok');
  });
});

describe('callGemini — network error branches', () => {
  test('error generico + attempt < retries => retry (branch generic network retry)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network failure')).mockResolvedValue(okResp('ok'));
    const p = gc.callGemini('k', 'p', { retries: 1 });
    await jest.runAllTimersAsync();
    expect(await p).toBe('ok');
  });
  test('error generico + attempt === retries => throw (branch attempt===retries truthy)', async () => {
    fetchMock.mockRejectedValue(new Error('network failure'));
    const p = gc.callGemini('k', 'p', { retries: 1 });
    const check = expect(p).rejects.toThrow('network failure');
    await jest.runAllTimersAsync();
    await check;
  });
});

describe('callGeminiChat', () => {
  test('success basico — roles user/assistant mapeados (branch role===assistant truthy)', async () => {
    fetchMock.mockResolvedValue(okResp('chat reply'));
    const msgs = [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'back' }];
    const r = await gc.callGeminiChat('key', msgs, 'system');
    expect(r).toBe('chat reply');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.contents[0].role).toBe('user');
    expect(body.contents[1].role).toBe('model');
    expect(body.systemInstruction.parts[0].text).toBe('system');
  });
  test('opts.model => usa ese model (branch model truthy)', async () => {
    fetchMock.mockResolvedValue(okResp('r'));
    await gc.callGeminiChat('k', [{ role: 'user', content: 'hi' }], 'sys', { model: 'gemini-pro' });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('gemini-pro'), expect.any(Object));
  });
  test('temperature/topP/topK/thinkingBudget => genConfig (branch != null truthy)', async () => {
    fetchMock.mockResolvedValue(okResp('r'));
    await gc.callGeminiChat('k', [{ role: 'user', content: 'hi' }], 'sys', { temperature: 0.7, topP: 0.8, topK: 30, thinkingBudget: 500 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig.temperature).toBe(0.7);
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(500);
  });
  test('sin opts genConfig => sin generationConfig (branch Object.keys > 0 false)', async () => {
    fetchMock.mockResolvedValue(okResp('r'));
    await gc.callGeminiChat('k', [{ role: 'user', content: 'hi' }], 'sys');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig).toBeUndefined();
  });
  test('opts.timeout custom (branch opts.timeout truthy)', async () => {
    fetchMock.mockResolvedValue(okResp('r'));
    await gc.callGeminiChat('k', [{ role: 'user', content: 'hi' }], 'sys', { timeout: 1000 });
    expect(fetchMock).toHaveBeenCalled();
  });
  test('!response.ok => return null (branch !response.ok truthy)', async () => {
    fetchMock.mockResolvedValue(errResp(500));
    const r = await gc.callGeminiChat('k', [{ role: 'user', content: 'hi' }], 'sys');
    expect(r).toBeNull();
  });
  test('!text en data => return null (branch !text truthy)', async () => {
    fetchMock.mockResolvedValue(okResp(null));
    const r = await gc.callGeminiChat('k', [{ role: 'user', content: 'hi' }], 'sys');
    expect(r).toBeNull();
  });
  test('AbortError => return null (branch error.name === AbortError)', async () => {
    fetchMock.mockRejectedValue(abortErr());
    const p = gc.callGeminiChat('k', [{ role: 'user', content: 'hi' }], 'sys');
    await jest.runAllTimersAsync();
    expect(await p).toBeNull();
  });
  test('otro error => return null (branch error.name !== AbortError)', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    const p = gc.callGeminiChat('k', [{ role: 'user', content: 'hi' }], 'sys');
    await jest.runAllTimersAsync();
    expect(await p).toBeNull();
  });
});
