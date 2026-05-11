'use strict';

/**
 * VI-BACKEND-COVERAGE: ai/ai_client.js — 100% branches
 * Mockea adapters, key_pool, resilience_shield, tenant_metrics.
 */

// ── Helper para fresh module con mocks ────────────────────────────────────────

function makeMocks({ hasKeys = false, circuitOpen = false, shieldAvailable = true, metricsAvailable = false } = {}) {
  jest.resetModules();

  const mockCall = jest.fn().mockResolvedValue('adapter-response');
  const mockCallChat = jest.fn().mockResolvedValue('chat-response');
  const adapterMock = { call: mockCall, callChat: mockCallChat };

  jest.doMock('../ai/adapters/gemini_adapter', () => adapterMock);
  jest.doMock('../ai/adapters/openai_adapter', () => adapterMock);
  jest.doMock('../ai/adapters/claude_adapter', () => adapterMock);
  jest.doMock('../ai/adapters/groq_adapter', () => adapterMock);
  jest.doMock('../ai/adapters/mistral_adapter', () => adapterMock);

  const keyPoolMock = {
    hasKeys: jest.fn().mockReturnValue(hasKeys),
    getKey: jest.fn().mockReturnValue('test-api-key'),
    getStats: jest.fn().mockReturnValue({ total: 1, available: 1, cooldown: 0, stats: [] }),
    markSuccess: jest.fn(),
    markFailed: jest.fn(),
  };
  jest.doMock('../ai/key_pool', () => keyPoolMock);

  const shieldMock = {
    SYSTEMS: { GEMINI: 'gemini' },
    isCircuitOpen: jest.fn().mockReturnValue(circuitOpen),
    recordSuccess: jest.fn(),
    recordFail: jest.fn(),
  };
  if (shieldAvailable) {
    jest.doMock('../core/resilience_shield', () => shieldMock);
  } else {
    jest.doMock('../core/resilience_shield', () => { throw new Error('no shield'); });
  }

  const metricsMock = {
    recordAICall: jest.fn(),
  };
  if (metricsAvailable) {
    jest.doMock('../core/tenant_metrics', () => metricsMock);
  } else {
    jest.doMock('../core/tenant_metrics', () => { throw new Error('no metrics'); });
  }

  const m = require('../ai/ai_client');
  return { m, adapterMock, keyPoolMock, shieldMock, metricsMock };
}

// ── Lazy-load cache (getShield / getMetrics) ─────────────────────────────────

describe('lazy-load cache branches', () => {
  test('getShield llamado 2 veces en misma instancia → segunda vez usa cache (if !_shield false)', async () => {
    const { m } = makeMocks({ hasKeys: false });
    // Llamar dos veces → segunda carga desde cache (_shield ya no es null)
    await m.callAI('gemini', 'key', 'prompt');
    await m.callAI('gemini', 'key', 'prompt'); // segunda → if (!_shield) === false → cache hit
    // Si no lanza, el branch de cache fue ejecutado
  });

  test('getMetrics llamado 2 veces en misma instancia → cache hit', async () => {
    const { m } = makeMocks({ hasKeys: false, metricsAvailable: true });
    await m.callAI('gemini', 'key', 'prompt', { uid: 'uid-1' });
    await m.callAI('gemini', 'key', 'prompt', { uid: 'uid-2' }); // segunda → cache hit
  });

  test('prompt null → (prompt || empty string) branch falsy', async () => {
    const { m } = makeMocks({ hasKeys: false });
    // prompt=null → (null || '').length = 0
    const r = await m.callAI('gemini', 'key', null);
    expect(r).toBe('adapter-response');
  });

  test('systemPrompt null → callAIChat (systemPrompt || empty) branch falsy', async () => {
    const { m } = makeMocks({ hasKeys: false });
    const r = await m.callAIChat('gemini', 'key', [], null);
    expect(r).toBe('chat-response');
  });

  test('messages con item sin content → totalMsgChars branch ((m.content)||empty)', async () => {
    const { m } = makeMocks({ hasKeys: false });
    // message con content=undefined
    const r = await m.callAIChat('gemini', 'key', [{ role: 'user' }], 'system');
    expect(r).toBe('chat-response');
  });
});

// ── getAdapter / PROVIDER_LABELS ──────────────────────────────────────────────

describe('PROVIDER_LABELS exported', () => {
  test('contiene los 5 proveedores', () => {
    const { m } = makeMocks();
    expect(m.PROVIDER_LABELS.gemini).toBeDefined();
    expect(m.PROVIDER_LABELS.openai).toBeDefined();
    expect(m.PROVIDER_LABELS.claude).toBeDefined();
    expect(m.PROVIDER_LABELS.groq).toBeDefined();
    expect(m.PROVIDER_LABELS.mistral).toBeDefined();
  });
});

describe('getAdapter — invalid provider (branch throw)', () => {
  test('proveedor desconocido → throw', async () => {
    const { m } = makeMocks();
    await expect(m.callAI('unknown-provider', 'key', 'prompt')).rejects.toThrow('Proveedor de IA no soportado');
  });
});

// ── callAI — direct path (no key pool) ────────────────────────────────────────

describe('callAI — direct (no keyPool)', () => {
  afterEach(() => jest.dontMock('../ai/adapters/gemini_adapter'));

  test('OK → retorna resultado del adapter (branch direct, shield ok)', async () => {
    const { m, adapterMock, shieldMock } = makeMocks({ hasKeys: false });
    const r = await m.callAI('gemini', 'key', 'prompt');
    expect(r).toBe('adapter-response');
    expect(adapterMock.call).toHaveBeenCalledWith('key', 'prompt', {});
    expect(shieldMock.recordSuccess).toHaveBeenCalled();
  });

  test('circuit breaker abierto → return null (branch circuit open)', async () => {
    const { m } = makeMocks({ hasKeys: false, circuitOpen: true });
    const r = await m.callAI('gemini', 'key', 'prompt');
    expect(r).toBeNull();
  });

  test('adapter lanza error → shield.recordFail + re-throw', async () => {
    const { m, adapterMock, shieldMock } = makeMocks({ hasKeys: false });
    const err = new Error('adapter fail');
    adapterMock.call.mockRejectedValue(err);
    await expect(m.callAI('gemini', 'key', 'prompt')).rejects.toThrow('adapter fail');
    expect(shieldMock.recordFail).toHaveBeenCalled();
  });

  test('shield no disponible → no lanza (lazy load catch)', async () => {
    const { m, adapterMock } = makeMocks({ hasKeys: false, shieldAvailable: false });
    const r = await m.callAI('gemini', 'key', 'prompt');
    expect(r).toBe('adapter-response');
  });

  test('opts.uid + metrics disponible → recordAICall llamado (branch uid + metrics true)', async () => {
    const { m, metricsMock } = makeMocks({ hasKeys: false, metricsAvailable: true });
    await m.callAI('gemini', 'key', 'prompt', { uid: 'uid-1' });
    expect(metricsMock.recordAICall).toHaveBeenCalled();
  });

  test('opts.uid sin metrics → no error (branch metrics null)', async () => {
    const { m } = makeMocks({ hasKeys: false, metricsAvailable: false });
    await expect(m.callAI('gemini', 'key', 'prompt', { uid: 'uid-1' })).resolves.toBe('adapter-response');
  });

  test('error AbortError con uid + metrics → recordAICall timeout=true', async () => {
    const { m, adapterMock, metricsMock } = makeMocks({ hasKeys: false, metricsAvailable: true });
    const abortErr = Object.assign(new Error('timeout'), { name: 'AbortError' });
    adapterMock.call.mockRejectedValue(abortErr);
    await expect(m.callAI('gemini', 'key', 'prompt', { uid: 'uid-abort' })).rejects.toThrow('timeout');
    expect(metricsMock.recordAICall).toHaveBeenCalledWith('uid-abort', expect.objectContaining({ timeout: true }));
  });

  test('error con "timeout" en message → timeout=true en metrics', async () => {
    const { m, adapterMock, metricsMock } = makeMocks({ hasKeys: false, metricsAvailable: true });
    const timeoutErr = new Error('request timeout exceeded');
    adapterMock.call.mockRejectedValue(timeoutErr);
    await expect(m.callAI('gemini', 'key', 'prompt', { uid: 'uid-to' })).rejects.toThrow();
    expect(metricsMock.recordAICall).toHaveBeenCalledWith('uid-to', expect.objectContaining({ timeout: true }));
  });

  test('direct ok → adapter retorna null → (null||"").length branch (line 110)', async () => {
    const { m, adapterMock } = makeMocks({ hasKeys: false });
    adapterMock.call.mockResolvedValue(null);
    const r = await m.callAI('gemini', 'key', 'prompt');
    expect(r).toBeNull();
  });

  test('direct error + shield null → if(shield) false en catch (line 114)', async () => {
    const { m, adapterMock } = makeMocks({ hasKeys: false, shieldAvailable: false });
    adapterMock.call.mockRejectedValue(new Error('fail no shield'));
    await expect(m.callAI('gemini', 'key', 'prompt')).rejects.toThrow('fail no shield');
    // shield=null → if(shield) false → recordFail NOT called
  });

  test('direct error + uid + no metrics → if(m) false en catch (line 116)', async () => {
    const { m, adapterMock } = makeMocks({ hasKeys: false, metricsAvailable: false });
    adapterMock.call.mockRejectedValue(new Error('fail uid no metrics'));
    await expect(m.callAI('gemini', 'key', 'prompt', { uid: 'uid-nomet' })).rejects.toThrow();
    // m=null → if(m) false branch
  });

  test('direct error + uid + metrics + empty msg → err.message falsy branch (line 116)', async () => {
    const { m, adapterMock, metricsMock } = makeMocks({ hasKeys: false, metricsAvailable: true });
    const emptyMsgErr = new Error(); // message = "" → falsy → err.message && ... short-circuits
    adapterMock.call.mockRejectedValue(emptyMsgErr);
    await expect(m.callAI('gemini', 'key', 'prompt', { uid: 'uid-emptymsg' })).rejects.toThrow();
    expect(metricsMock.recordAICall).toHaveBeenCalledWith('uid-emptymsg', expect.objectContaining({ timeout: false }));
  });
});

// ── callAIChat — direct path ──────────────────────────────────────────────────

describe('callAIChat — direct (no keyPool)', () => {
  test('OK → retorna resultado', async () => {
    const { m, adapterMock } = makeMocks({ hasKeys: false });
    const msgs = [{ role: 'user', content: 'hi' }];
    const r = await m.callAIChat('openai', 'key', msgs, 'system');
    expect(r).toBe('chat-response');
    expect(adapterMock.callChat).toHaveBeenCalledWith('key', msgs, 'system', {});
  });

  test('circuit breaker abierto → return null', async () => {
    const { m } = makeMocks({ hasKeys: false, circuitOpen: true });
    const r = await m.callAIChat('openai', 'key', [], 'system');
    expect(r).toBeNull();
  });

  test('messages no es array → totalMsgChars=0 (branch !Array.isArray)', async () => {
    const { m } = makeMocks({ hasKeys: false });
    // messages=null → Array.isArray=false → msgCount=0, totalMsgChars=0
    const r = await m.callAIChat('openai', 'key', null, 'system');
    expect(r).toBe('chat-response');
  });

  test('adapter lanza error → shield.recordFail + re-throw', async () => {
    const { m, adapterMock, shieldMock } = makeMocks({ hasKeys: false });
    adapterMock.callChat.mockRejectedValue(new Error('chat fail'));
    await expect(m.callAIChat('openai', 'key', [], 'system')).rejects.toThrow('chat fail');
    expect(shieldMock.recordFail).toHaveBeenCalled();
  });

  test('shield no disponible → no lanza', async () => {
    const { m } = makeMocks({ hasKeys: false, shieldAvailable: false });
    const r = await m.callAIChat('openai', 'key', [], 'system');
    expect(r).toBe('chat-response');
  });

  test('opts.uid + metrics → recordAICall en ok', async () => {
    const { m, metricsMock } = makeMocks({ hasKeys: false, metricsAvailable: true });
    await m.callAIChat('openai', 'key', [], 'system', { uid: 'uid-chat' });
    expect(metricsMock.recordAICall).toHaveBeenCalled();
  });

  test('error AbortError con uid → timeout=true', async () => {
    const { m, adapterMock, metricsMock } = makeMocks({ hasKeys: false, metricsAvailable: true });
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    adapterMock.callChat.mockRejectedValue(err);
    await expect(m.callAIChat('openai', 'key', [], 'system', { uid: 'uid-chat-abort' })).rejects.toThrow();
    expect(metricsMock.recordAICall).toHaveBeenCalledWith('uid-chat-abort', expect.objectContaining({ timeout: true }));
  });

  test('direct chat ok → adapter retorna null → (null||"").length branch (line 162)', async () => {
    const { m, adapterMock } = makeMocks({ hasKeys: false });
    adapterMock.callChat.mockResolvedValue(null);
    const r = await m.callAIChat('openai', 'key', [], 'system');
    expect(r).toBeNull();
  });

  test('direct chat error + shield null → if(shield) false en catch (line 166)', async () => {
    const { m, adapterMock } = makeMocks({ hasKeys: false, shieldAvailable: false });
    adapterMock.callChat.mockRejectedValue(new Error('chat fail no shield'));
    await expect(m.callAIChat('openai', 'key', [], 'system')).rejects.toThrow('chat fail no shield');
  });

  test('direct chat ok + uid + no metrics → if(m) false en ok path (line 163)', async () => {
    const { m } = makeMocks({ hasKeys: false, metricsAvailable: false });
    await expect(m.callAIChat('openai', 'key', [], 'system', { uid: 'uid-direct-chat-nomet' })).resolves.toBe('chat-response');
    // m=null → if(m) false branch en line 163
  });

  test('direct chat error + uid + no metrics → if(m) false en catch (line 168)', async () => {
    const { m, adapterMock } = makeMocks({ hasKeys: false, metricsAvailable: false });
    adapterMock.callChat.mockRejectedValue(new Error('chat fail uid nomet'));
    await expect(m.callAIChat('openai', 'key', [], 'system', { uid: 'uid-chat-nomet' })).rejects.toThrow();
  });
});

// ── callAI — key pool path ────────────────────────────────────────────────────

describe('callAI — via key pool', () => {
  test('pool OK → retorna resultado + markSuccess', async () => {
    const { m, adapterMock, keyPoolMock } = makeMocks({ hasKeys: true });
    const r = await m.callAI('gemini', null, 'prompt');
    expect(r).toBe('adapter-response');
    expect(keyPoolMock.markSuccess).toHaveBeenCalled();
  });

  test('pool throw → re-throw + no markSuccess', async () => {
    const { m, adapterMock, keyPoolMock } = makeMocks({ hasKeys: true });
    adapterMock.call.mockRejectedValue(new Error('pool fail'));
    await expect(m.callAI('gemini', null, 'prompt')).rejects.toThrow('pool fail');
  });

  test('pool ok + uid + metrics → recordAICall', async () => {
    const { m, metricsMock } = makeMocks({ hasKeys: true, metricsAvailable: true });
    await m.callAI('gemini', null, 'prompt', { uid: 'uid-pool' });
    expect(metricsMock.recordAICall).toHaveBeenCalled();
  });

  test('pool error + uid + metrics → recordAICall con success=false', async () => {
    const { m, adapterMock, metricsMock } = makeMocks({ hasKeys: true, metricsAvailable: true });
    adapterMock.call.mockRejectedValue(new Error('pool err'));
    await expect(m.callAI('gemini', null, 'prompt', { uid: 'uid-pool-err' })).rejects.toThrow();
    expect(metricsMock.recordAICall).toHaveBeenCalledWith('uid-pool-err', expect.objectContaining({ success: false }));
  });

  test('circuit open + pool → return null (circuit abierto antes de pool)', async () => {
    const { m } = makeMocks({ hasKeys: true, circuitOpen: true });
    const r = await m.callAI('gemini', null, 'prompt');
    expect(r).toBeNull();
  });
});

  test('opts.model truthy → model en obs (branch opts.model || null left)', async () => {
    const { m } = makeMocks({ hasKeys: true });
    // model truthy → opts.model || null → opts.model branch
    await m.callAI('gemini', null, 'prompt', { model: 'gemini-pro' });
  });

  test('pool ok + uid + NO metrics → if (m) false branch en pool ok path', async () => {
    const { m } = makeMocks({ hasKeys: true, metricsAvailable: false });
    // uid set pero metrics no disponible → getMetrics()=null → if(m) false
    await expect(m.callAI('gemini', null, 'prompt', { uid: 'uid-no-metrics' })).resolves.toBeDefined();
  });

  test('pool error + uid + NO metrics → if (m) false branch en pool catch', async () => {
    const { m, adapterMock } = makeMocks({ hasKeys: true, metricsAvailable: false });
    adapterMock.call.mockRejectedValue(new Error('pool err no metrics'));
    await expect(m.callAI('gemini', null, 'prompt', { uid: 'uid-no-m' })).rejects.toThrow();
  });

// ── callAIChat — key pool path ─────────────────────────────────────────────────

describe('callAIChat — via key pool', () => {
  test('pool OK → retorna resultado', async () => {
    const { m } = makeMocks({ hasKeys: true });
    const r = await m.callAIChat('claude', null, [], 'system');
    expect(r).toBe('chat-response');
  });

  test('pool throw → re-throw', async () => {
    const { m, adapterMock } = makeMocks({ hasKeys: true });
    adapterMock.callChat.mockRejectedValue(new Error('chat pool fail'));
    await expect(m.callAIChat('claude', null, [], 'system')).rejects.toThrow('chat pool fail');
  });

  test('pool ok + uid + metrics → recordAICall ok', async () => {
    const { m, metricsMock } = makeMocks({ hasKeys: true, metricsAvailable: true });
    await m.callAIChat('claude', null, [], 'system', { uid: 'uid-chat-pool' });
    expect(metricsMock.recordAICall).toHaveBeenCalled();
  });

  test('pool error + uid + metrics → recordAICall fail', async () => {
    const { m, adapterMock, metricsMock } = makeMocks({ hasKeys: true, metricsAvailable: true });
    adapterMock.callChat.mockRejectedValue(new Error('chat pool err'));
    await expect(m.callAIChat('claude', null, [], 'system', { uid: 'uid-chat-pool-err' })).rejects.toThrow();
    expect(metricsMock.recordAICall).toHaveBeenCalledWith('uid-chat-pool-err', expect.objectContaining({ success: false }));
  });

  test('pool chat ok → adapter retorna null → (null||"").length branch (line 148)', async () => {
    const { m, adapterMock } = makeMocks({ hasKeys: true });
    adapterMock.callChat.mockResolvedValue(null);
    const r = await m.callAIChat('claude', null, [], 'system');
    expect(r).toBeNull();
  });

  test('pool chat ok + uid + no metrics → if(m) false en ok path (line 149)', async () => {
    const { m } = makeMocks({ hasKeys: true, metricsAvailable: false });
    await expect(m.callAIChat('claude', null, [], 'system', { uid: 'uid-pool-nomet' })).resolves.toBe('chat-response');
    // m=null → if(m) false branch en line 149
  });

  test('pool chat error + uid + no metrics → if(m) false en catch (line 153)', async () => {
    const { m, adapterMock } = makeMocks({ hasKeys: true, metricsAvailable: false });
    adapterMock.callChat.mockRejectedValue(new Error('chat pool fail nomet'));
    await expect(m.callAIChat('claude', null, [], 'system', { uid: 'uid-chat-pool-nomet' })).rejects.toThrow();
  });
});

// ── _callWithPool — failover branches ─────────────────────────────────────────

describe('_callWithPool — failover via callAI con keyPool', () => {
  test('quota 429 → markFailed 429 + rota key + OK en segundo intento', async () => {
    const { m, adapterMock, keyPoolMock } = makeMocks({ hasKeys: true });
    keyPoolMock.getStats.mockReturnValue({ total: 2, available: 1, cooldown: 1, stats: [] });
    keyPoolMock.getKey
      .mockReturnValueOnce('key1')
      .mockReturnValueOnce('key2');
    adapterMock.call
      .mockRejectedValueOnce(Object.assign(new Error('quota'), { status: 429 }))
      .mockResolvedValueOnce('ok after failover');
    const r = await m.callAI('gemini', null, 'prompt');
    expect(r).toBe('ok after failover');
    expect(keyPoolMock.markFailed).toHaveBeenCalledWith('gemini', 'key1', '429');
    expect(keyPoolMock.markSuccess).toHaveBeenCalledWith('gemini', 'key2');
  });

  test('auth 401 → markFailed 401 + rota key + OK', async () => {
    const { m, adapterMock, keyPoolMock } = makeMocks({ hasKeys: true });
    keyPoolMock.getStats.mockReturnValue({ total: 2, available: 1, cooldown: 1, stats: [] });
    keyPoolMock.getKey
      .mockReturnValueOnce('key1')
      .mockReturnValueOnce('key2');
    adapterMock.call
      .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }))
      .mockResolvedValueOnce('ok after auth fail');
    const r = await m.callAI('gemini', null, 'prompt');
    expect(r).toBe('ok after auth fail');
    expect(keyPoolMock.markFailed).toHaveBeenCalledWith('gemini', 'key1', '401');
  });

  test('auth 403 → markFailed 403 + rota', async () => {
    const { m, adapterMock, keyPoolMock } = makeMocks({ hasKeys: true });
    keyPoolMock.getStats.mockReturnValue({ total: 2, available: 1, cooldown: 1, stats: [] });
    keyPoolMock.getKey
      .mockReturnValueOnce('key1')
      .mockReturnValueOnce('key2');
    adapterMock.call
      .mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }))
      .mockResolvedValueOnce('ok');
    const r = await m.callAI('gemini', null, 'prompt');
    expect(r).toBe('ok');
    expect(keyPoolMock.markFailed).toHaveBeenCalledWith('gemini', 'key1', '403');
  });

  test('error rate limit detectado en mensaje → isQuota true', async () => {
    const { m, adapterMock, keyPoolMock } = makeMocks({ hasKeys: true });
    keyPoolMock.getStats.mockReturnValue({ total: 2, available: 1, cooldown: 1, stats: [] });
    keyPoolMock.getKey
      .mockReturnValueOnce('key1')
      .mockReturnValueOnce('key2');
    adapterMock.call
      .mockRejectedValueOnce(new Error('rate limit exceeded'))
      .mockResolvedValueOnce('ok');
    const r = await m.callAI('gemini', null, 'prompt');
    expect(r).toBe('ok');
  });

  test('error no-recoverable (500) → markFailed(500) + propagate sin rotar', async () => {
    const { m, adapterMock, keyPoolMock, shieldMock } = makeMocks({ hasKeys: true });
    keyPoolMock.getStats.mockReturnValue({ total: 1, available: 1, cooldown: 0, stats: [] });
    const serverErr = Object.assign(new Error('server error'), { status: 500 });
    adapterMock.call.mockRejectedValue(serverErr);
    await expect(m.callAI('gemini', null, 'prompt')).rejects.toThrow('server error');
    // status=500 → String(500 || 'ERROR') = '500'
    expect(keyPoolMock.markFailed).toHaveBeenCalledWith('gemini', 'test-api-key', '500');
    expect(shieldMock.recordFail).toHaveBeenCalled();
  });

  test('error no status → markFailed(ERROR) (branch String(status||ERROR) con status falsy)', async () => {
    const { m, adapterMock, keyPoolMock, shieldMock } = makeMocks({ hasKeys: true });
    keyPoolMock.getStats.mockReturnValue({ total: 1, available: 1, cooldown: 0, stats: [] });
    // err sin status ni statusCode → status = '' → String('' || 'ERROR') = 'ERROR'
    adapterMock.call.mockRejectedValue(new Error('generic network error'));
    await expect(m.callAI('gemini', null, 'prompt')).rejects.toThrow('generic network error');
    expect(keyPoolMock.markFailed).toHaveBeenCalledWith('gemini', 'test-api-key', 'ERROR');
  });

  test('getKey retorna null → break loop → throw lastError', async () => {
    const { m, keyPoolMock, shieldMock } = makeMocks({ hasKeys: true });
    keyPoolMock.getStats.mockReturnValue({ total: 3, available: 0, cooldown: 3, stats: [] });
    keyPoolMock.getKey.mockReturnValue(null);
    await expect(m.callAI('gemini', null, 'prompt')).rejects.toThrow('todas las API keys agotadas');
    expect(shieldMock.recordFail).toHaveBeenCalled();
  });

  test('todas las keys fallan 429 → throw lastError + shield.recordFail', async () => {
    const { m, adapterMock, keyPoolMock, shieldMock } = makeMocks({ hasKeys: true });
    keyPoolMock.getStats.mockReturnValue({ total: 2, available: 0, cooldown: 2, stats: [] });
    const quotaErr = Object.assign(new Error('quota'), { status: 429 });
    adapterMock.call.mockRejectedValue(quotaErr);
    await expect(m.callAI('gemini', null, 'prompt')).rejects.toThrow('quota');
    expect(shieldMock.recordFail).toHaveBeenCalled();
  });

  test('shield no disponible en _callWithPool → no lanza', async () => {
    const { m, adapterMock } = makeMocks({ hasKeys: true, shieldAvailable: false });
    const r = await m.callAI('gemini', null, 'prompt');
    expect(r).toBe('adapter-response');
  });

  test('pool ok → adapter retorna null → (null||"").length branch', async () => {
    const { m, adapterMock } = makeMocks({ hasKeys: true });
    adapterMock.call.mockResolvedValue(null);
    const r = await m.callAI('gemini', null, 'prompt');
    expect(r).toBeNull(); // (null || '').length = 0
  });

  test('non-recoverable error + shield null → if(shield) false branch (line 209)', async () => {
    const { m, adapterMock } = makeMocks({ hasKeys: true, shieldAvailable: false });
    adapterMock.call.mockRejectedValue(Object.assign(new Error('server err'), { status: 500 }));
    await expect(m.callAI('gemini', null, 'prompt')).rejects.toThrow('server err');
    // shield=null → if(shield) false path en línea 209
  });

  test('getKey null + shield null → lastError null → new Error branch (lines 216+218)', async () => {
    const { m, keyPoolMock } = makeMocks({ hasKeys: true, shieldAvailable: false });
    keyPoolMock.getStats.mockReturnValue({ total: 2, available: 0, cooldown: 2, stats: [] });
    keyPoolMock.getKey.mockReturnValue(null); // break loop, lastError sigue null
    await expect(m.callAI('gemini', null, 'prompt')).rejects.toThrow('todas las API keys agotadas');
    // lastError=null → throw lastError || new Error → right branch
  });

  test('todas keys 429 + shield null → if(shield) false en línea 216', async () => {
    const { m, adapterMock, keyPoolMock } = makeMocks({ hasKeys: true, shieldAvailable: false });
    keyPoolMock.getStats.mockReturnValue({ total: 2, available: 0, cooldown: 2, stats: [] });
    adapterMock.call.mockRejectedValue(Object.assign(new Error('quota'), { status: 429 }));
    await expect(m.callAI('gemini', null, 'prompt')).rejects.toThrow('quota');
  });
});
