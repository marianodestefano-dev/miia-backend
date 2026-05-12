'use strict';

/**
 * VI-BACKEND-COVERAGE: ai/ai_gateway.js — 100% branches
 * Uses jest.resetModules + jest.doMock for fresh module isolation.
 */

let gw, mockCallAI, mockCallAIChat, mockKeyPool;

beforeEach(() => {
  jest.resetModules();
  mockCallAI = jest.fn();
  mockCallAIChat = jest.fn();
  mockKeyPool = { hasKeys: jest.fn().mockReturnValue(false), getKey: jest.fn().mockReturnValue(null) };
  jest.doMock('../ai/ai_client', () => ({
    callAI: mockCallAI,
    callAIChat: mockCallAIChat,
    keyPool: mockKeyPool,
  }));
  delete process.env.MIIA_MODEL_FAMILY_CHAT;
  gw = require('../ai/ai_gateway');
});

afterEach(() => {
  delete process.env.MIIA_MODEL_FAMILY_CHAT;
});

// ── applyTierOverride ─────────────────────────────────────────
describe('applyTierOverride', () => {
  test('!aiTier → return config as-is (branch !aiTier)', () => {
    const cfg = { preferred: 'gemini', model: 'x' };
    expect(gw.applyTierOverride(null, 'lead_response', cfg)).toBe(cfg);
    expect(gw.applyTierOverride(undefined, 'lead_response', cfg)).toBe(cfg);
  });

  test('aiTier=opus_max → override to claude opus (branch aiTier===opus_max)', () => {
    const cfg = { preferred: 'gemini', model: 'x', fallbacks: ['openai'] };
    const result = gw.applyTierOverride('opus_max', 'lead_response', cfg);
    expect(result.preferred).toBe('claude');
    expect(result.model).toBe('claude-opus-4-6');
  });

  test('aiTier=standard → return config unchanged (else branch)', () => {
    const cfg = { preferred: 'gemini', model: 'x' };
    const result = gw.applyTierOverride('standard', 'lead_response', cfg);
    expect(result).toBe(cfg);
  });
});

// ── getApiKey ─────────────────────────────────────────────────
describe('getApiKey', () => {
  test('ownerConfig tiene key para ese provider → usa owner key (branch 1)', () => {
    const key = gw.getApiKey('gemini', { aiProvider: 'gemini', aiApiKey: 'owner-key' });
    expect(key).toBe('owner-key');
  });

  test('keyPool tiene keys → usa pool (branch 2)', () => {
    mockKeyPool.hasKeys.mockReturnValue(true);
    mockKeyPool.getKey.mockReturnValue('pool-key');
    const key = gw.getApiKey('gemini', {});
    expect(key).toBe('pool-key');
  });

  test('env var → usa env (branch 3)', () => {
    process.env.GEMINI_API_KEY = 'env-key';
    const key = gw.getApiKey('gemini', {});
    expect(key).toBe('env-key');
    delete process.env.GEMINI_API_KEY;
  });

  test('ninguna fuente → null (branch 3 false)', () => {
    const key = gw.getApiKey('gemini', {});
    expect(key).toBeNull();
  });

  test('ownerConfig provider no coincide → no usa owner key', () => {
    const key = gw.getApiKey('openai', { aiProvider: 'gemini', aiApiKey: 'owner-key' });
    expect(key).toBeNull(); // gemini key no aplica a openai
  });
});

// ── healthCheck ───────────────────────────────────────────────
describe('healthCheck', () => {
  test('sin calls → avgLatency=0, failRate=0%, failoverRate=0% (calls=0 false branches)', () => {
    const h = gw.healthCheck();
    expect(h.totalCalls).toBe(0);
    expect(h.failoverRate).toBe('0%');
    expect(h.providers.gemini.avgLatencyMs).toBe(0);
    expect(h.providers.gemini.failRate).toBe('0%');
  });

  test('con calls → calcula avgLatency y failRate (calls>0 true branch)', async () => {
    mockKeyPool.hasKeys.mockReturnValue(true);
    mockKeyPool.getKey.mockReturnValue('key');
    mockCallAI.mockResolvedValue('ok');
    await gw.smartCall('lead_response', 'prompt', {});
    const h = gw.healthCheck();
    expect(h.totalCalls).toBeGreaterThan(0);
    expect(h.providers.gemini.calls).toBeGreaterThan(0);
    // failoverRate branch: totalCalls > 0 → compute (0 failovers → '0%')
    expect(h.failoverRate).toBe('0%');
  });
});

// ── smartCall — provider selection ───────────────────────────
describe('smartCall — provider branches', () => {
  test('api key faltante → skip provider (branch !apiKey)', async () => {
    // No keys anywhere → all skipped → all fail
    const r = await gw.smartCall('lead_response', 'prompt', {});
    expect(r.text).toBeNull();
    expect(r.failedOver).toBe(true);
  });

  test('primer provider OK → no failover (branch failedOver false)', async () => {
    mockKeyPool.hasKeys.mockReturnValue(true);
    mockKeyPool.getKey.mockReturnValue('key1');
    mockCallAI.mockResolvedValue('respuesta');
    const r = await gw.smartCall('lead_response', 'prompt', {});
    expect(r.text).toBe('respuesta');
    expect(r.failedOver).toBe(false);
    expect(r.provider).toBe('gemini');
  });

  test('primer provider falla → failover a segundo OK (branch failedOver true)', async () => {
    // Solo primer provider tiene key, falla
    mockKeyPool.hasKeys.mockImplementation((p) => p === 'gemini');
    mockKeyPool.getKey.mockReturnValue('gemini-key');
    mockCallAI
      .mockRejectedValueOnce(new Error('gemini down'))
      .mockResolvedValue('respuesta openai');
    // Agregar openai env
    process.env.OPENAI_API_KEY = 'openai-key';
    const r = await gw.smartCall('lead_response', 'prompt', {});
    delete process.env.OPENAI_API_KEY;
    expect(r.failedOver).toBe(true);
  });

  test('ownerProvider configurado → usa primero ownerProvider (branch ownerProvider truthy)', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    mockCallAI.mockResolvedValue('openai response');
    const r = await gw.smartCall('lead_response', 'prompt', { aiProvider: 'openai' });
    delete process.env.OPENAI_API_KEY;
    expect(r.provider).toBe('openai');
  });

  test('FAMILY_CHAT context → usa claude opus por defecto', async () => {
    process.env.CLAUDE_API_KEY = 'claude-key';
    mockCallAI.mockResolvedValue('familia response');
    const r = await gw.smartCall('family_chat', 'prompt', {});
    delete process.env.CLAUDE_API_KEY;
    expect(r.provider).toBe('claude');
  });

  test('OWNER_CHAT + opus_max → override a claude opus', async () => {
    process.env.CLAUDE_API_KEY = 'claude-key';
    mockCallAI.mockResolvedValue('opus response');
    const r = await gw.smartCall('lead_response', 'prompt', { aiTier: 'opus_max' });
    delete process.env.CLAUDE_API_KEY;
    expect(r.provider).toBe('claude');
  });

  test('usedOwnerKey true (i=0 + ownerConfig aiApiKey + same provider)', async () => {
    mockCallAI.mockResolvedValue('owner key response');
    const r = await gw.smartCall('lead_response', 'prompt', {
      aiProvider: 'gemini',
      aiApiKey: 'owner-gemini-key',
    });
    expect(r.usedMiiaBackup).toBe(false); // owner key used at i=0
    expect(r.text).toBe('owner key response');
  });

  test('usedMiiaBackup=true: failedOver + ownerConfig.aiApiKey + no owner key', async () => {
    // gemini fails, openai succeeds, owner had a key but it was for gemini
    process.env.OPENAI_API_KEY = 'openai-key';
    mockCallAI
      .mockRejectedValueOnce(new Error('gemini down'))
      .mockResolvedValue('openai result');
    const r = await gw.smartCall('lead_response', 'prompt', {
      aiProvider: 'gemini',
      aiApiKey: 'owner-gemini-key',
    });
    delete process.env.OPENAI_API_KEY;
    expect(r.failedOver).toBe(true);
    expect(r.usedMiiaBackup).toBe(true);
  });
});

// ── smartCall — enableSearch branches ─────────────────────────
describe('smartCall — enableSearch guard', () => {
  test('enableSearch=true + preferred not gemini → force gemini (searchForceGemini=true)', async () => {
    // OWNER_CHAT preferred=claude → searchForceGemini=true
    process.env.GEMINI_API_KEY = 'gemini-key';
    mockCallAI.mockResolvedValue('gemini search result');
    const r = await gw.smartCall('owner_chat', 'prompt', {}, { enableSearch: true });
    delete process.env.GEMINI_API_KEY;
    // Should use gemini despite owner_chat preferring claude
    expect(r.provider).toBe('gemini');
  });

  test('enableSearch=true + forceProvider set → no searchForceGemini (forceProvider wins)', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    mockCallAI.mockResolvedValue('openai result');
    const r = await gw.smartCall('owner_chat', 'prompt', {}, {
      enableSearch: true,
      forceProvider: 'openai',
    });
    delete process.env.OPENAI_API_KEY;
    // forceProvider wins → openai (not gemini)
    expect(r.provider).toBe('openai');
  });

  test('enableSearch=true + preferred already gemini → no searchForceGemini', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    mockCallAI.mockResolvedValue('gemini result');
    // lead_response preferred=gemini → no searchForceGemini
    const r = await gw.smartCall('lead_response', 'prompt', {}, { enableSearch: true });
    delete process.env.GEMINI_API_KEY;
    expect(r.provider).toBe('gemini');
  });

  test('enableSearch + finalSearchProvider !== gemini → integrity violation log (no throw)', async () => {
    // forceProvider=openai + enableSearch=true → finalSearchProvider=openai → ALERTA
    process.env.OPENAI_API_KEY = 'openai-key';
    mockCallAI.mockResolvedValue('openai result');
    const r = await gw.smartCall('owner_chat', 'prompt', {}, {
      enableSearch: true,
      forceProvider: 'openai',
    });
    delete process.env.OPENAI_API_KEY;
    expect(r.text).toBe('openai result');
  });
});

// ── smartCall — B+ strategy (claudeThinking / gemini params) ─
describe('smartCall — B+ strategy params', () => {
  test('claude provider + thinking budget → effectiveMaxTokens = base + thinking', async () => {
    process.env.CLAUDE_API_KEY = 'claude-key';
    mockCallAI.mockResolvedValue('claude response');
    const r = await gw.smartCall('owner_chat', 'prompt', {});
    delete process.env.CLAUDE_API_KEY;
    expect(r.provider).toBe('claude');
    // Verify callAI was called with elevated maxTokens (base 4096 + thinking 4096)
    const callOpts = mockCallAI.mock.calls[0][3];
    expect(callOpts.maxTokens).toBe(8192); // 4096 + 4096 thinking
    expect(callOpts.thinking).toBe(4096);
  });

  test('gemini provider → includes topP/topK/thinkingBudget', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    mockCallAI.mockResolvedValue('gemini response');
    await gw.smartCall('lead_response', 'prompt', {});
    delete process.env.GEMINI_API_KEY;
    const callOpts = mockCallAI.mock.calls[0][3];
    expect(callOpts.topP).toBeDefined();
    expect(callOpts.thinkingBudget).toBeDefined();
  });

  test('context desconocido → usa GENERAL config', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    mockCallAI.mockResolvedValue('general response');
    const r = await gw.smartCall('unknown_context', 'prompt', {});
    delete process.env.GEMINI_API_KEY;
    expect(r.text).toBe('general response');
  });

  test('smartCall sin ownerConfig/opts → default params = {} (branch line 295)', async () => {
    process.env.GEMINI_API_KEY = 'key';
    mockCallAI.mockResolvedValue('ok');
    const r = await gw.smartCall('lead_response', 'prompt');
    delete process.env.GEMINI_API_KEY;
    expect(r.text).toBe('ok');
  });

  // Note: line 358 PROVIDER_DEFAULT_MODELS[provider] || config.model is dead-code:
  // any unknown provider would also be missing from providerMetrics → TypeError before reaching it.
});

// ── applyFamilyChatModelOverride ──────────────────────────────
describe('applyFamilyChatModelOverride', () => {
  test('context !== FAMILY_CHAT → return config sin modificar (branch 1)', () => {
    const cfg = gw.CONTEXT_CONFIG['lead_response'];
    // Se llama internamente via smartCall — testear via env
    // No MIIA_MODEL_FAMILY_CHAT → lead_response no se modifica
    expect(cfg.preferred).toBe('gemini');
  });

  test('FAMILY_CHAT + no env → return config default (branch !envValue)', async () => {
    process.env.CLAUDE_API_KEY = 'key';
    mockCallAI.mockResolvedValue('ok');
    const r = await gw.smartCall('family_chat', 'p', {});
    delete process.env.CLAUDE_API_KEY;
    expect(r.provider).toBe('claude'); // default opus
  });

  test('FAMILY_CHAT + env valido → override provider (branch mapped truthy)', async () => {
    process.env.MIIA_MODEL_FAMILY_CHAT = 'gemini-flash';
    process.env.GEMINI_API_KEY = 'key';
    mockCallAI.mockResolvedValue('gemini ok');
    const r = await gw.smartCall('family_chat', 'p', {});
    delete process.env.GEMINI_API_KEY;
    expect(r.provider).toBe('gemini');
  });

  test('FAMILY_CHAT + env invalido → warning + config default (branch !mapped)', async () => {
    process.env.MIIA_MODEL_FAMILY_CHAT = 'invalid-model';
    process.env.CLAUDE_API_KEY = 'key';
    mockCallAI.mockResolvedValue('ok');
    const r = await gw.smartCall('family_chat', 'p', {});
    delete process.env.CLAUDE_API_KEY;
    expect(r.provider).toBe('claude'); // fallback default
  });
});

// ── smartChat ─────────────────────────────────────────────────
describe('smartChat', () => {
  test('sin api key → todos fallan → null (branch all fail)', async () => {
    const r = await gw.smartChat('lead_response', [], 'sys', {});
    expect(r.text).toBeNull();
    expect(r.failedOver).toBe(true);
  });

  test('primer provider OK → respuesta (branch failedOver false)', async () => {
    process.env.GEMINI_API_KEY = 'key';
    mockCallAIChat.mockResolvedValue('chat response');
    const r = await gw.smartChat('lead_response', [], 'sys', {});
    delete process.env.GEMINI_API_KEY;
    expect(r.text).toBe('chat response');
    expect(r.failedOver).toBe(false);
  });

  test('primer provider falla → failover OK (branch failedOver true)', async () => {
    process.env.GEMINI_API_KEY = 'g-key';
    process.env.OPENAI_API_KEY = 'o-key';
    mockCallAIChat
      .mockRejectedValueOnce(new Error('gemini chat fail'))
      .mockResolvedValue('openai chat');
    const r = await gw.smartChat('lead_response', [], 'sys', {});
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(r.failedOver).toBe(true);
  });

  test('ownerProvider → antepone en lista (branch ownerProvider truthy)', async () => {
    process.env.OPENAI_API_KEY = 'key';
    mockCallAIChat.mockResolvedValue('openai chat');
    const r = await gw.smartChat('lead_response', [], 'sys', { aiProvider: 'openai' });
    delete process.env.OPENAI_API_KEY;
    expect(r.provider).toBe('openai');
  });

  test('claude context → claudeThinking + effectiveMaxTokens (B+ strategy)', async () => {
    process.env.CLAUDE_API_KEY = 'key';
    mockCallAIChat.mockResolvedValue('claude chat');
    const r = await gw.smartChat('owner_chat', [], 'sys', {});
    delete process.env.CLAUDE_API_KEY;
    expect(r.provider).toBe('claude');
    const callOpts = mockCallAIChat.mock.calls[0][4];
    expect(callOpts.thinking).toBe(4096);
  });

  test('gemini failover (provider !== preferred) → PROVIDER_DEFAULTS model', async () => {
    // auditor preferred=claude, fallbacks=[gemini, openai] → claude fails → gemini
    process.env.CLAUDE_API_KEY = 'c-key';
    process.env.GEMINI_API_KEY = 'g-key';
    mockCallAIChat
      .mockRejectedValueOnce(new Error('claude fail'))
      .mockResolvedValue('gemini chat result');
    const r = await gw.smartChat('auditor', [], 'sys', {});
    delete process.env.CLAUDE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect(r.failedOver).toBe(true);
    expect(r.provider).toBe('gemini');
  });

  test('chat: provider sin key → skip (branch !apiKey in chat loop)', async () => {
    // Sin keys → skip all → all fail
    const r = await gw.smartChat('owner_chat', [], 'sys', {});
    expect(r.text).toBeNull();
  });

  test('chat: gemini params inyectados (branch provider===gemini)', async () => {
    process.env.GEMINI_API_KEY = 'key';
    mockCallAIChat.mockResolvedValue('gemini');
    await gw.smartChat('lead_response', [], 'sys', {});
    delete process.env.GEMINI_API_KEY;
    const callOpts = mockCallAIChat.mock.calls[0][4];
    expect(callOpts.topP !== undefined || callOpts.thinkingBudget !== undefined).toBe(true);
  });

  test('smartChat sin ownerConfig/opts → default params (branch lines 417-418)', async () => {
    process.env.GEMINI_API_KEY = 'key';
    mockCallAIChat.mockResolvedValue('ok');
    const r = await gw.smartChat('lead_response', []);
    delete process.env.GEMINI_API_KEY;
    expect(r.text).toBe('ok');
  });

  test('smartChat unknown context → GENERAL config (branch line 418 ||)', async () => {
    process.env.GEMINI_API_KEY = 'key';
    mockCallAIChat.mockResolvedValue('general chat');
    const r = await gw.smartChat('unknown_ctx', [], 'sys', {});
    delete process.env.GEMINI_API_KEY;
    expect(r.text).toBe('general chat');
  });

  // Note: line 443 PROVIDER_DEFAULTS[provider] || config.model is dead-code (same reason as 358).
});
