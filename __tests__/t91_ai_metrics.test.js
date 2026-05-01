'use strict';

/**
 * T91 — AI Metrics (Observabilidad V2)
 * Tests: recordRegeneration, ai_timeout_count, ai_regen_count, ai_p95_latency_ms
 */

const tenantMetrics = require('../core/tenant_metrics');

beforeEach(() => tenantMetrics._resetState());

describe('T91 — recordRegeneration', () => {
  test('recordRegeneration exports como funcion', () => {
    expect(typeof tenantMetrics.recordRegeneration).toBe('function');
  });

  test('recordRegeneration no crashea con uid null', () => {
    expect(() => tenantMetrics.recordRegeneration(null)).not.toThrow();
  });

  test('recordRegeneration registra con reason correcto', () => {
    tenantMetrics.recordRegeneration('uid1', { reason: 'REGEX', context: 'test veto' });
    const stats = tenantMetrics.getTenantStats('uid1');
    expect(stats.ai_regen_count).toBe(1);
  });

  test('recordRegeneration acumula multiples regens', () => {
    tenantMetrics.recordRegeneration('uid1', { reason: 'REGEX' });
    tenantMetrics.recordRegeneration('uid1', { reason: 'AI_AUDITOR' });
    tenantMetrics.recordRegeneration('uid1', { reason: 'V2_CRITICAL' });
    const stats = tenantMetrics.getTenantStats('uid1');
    expect(stats.ai_regen_count).toBe(3);
  });

  test('ai_regen_count = 0 sin regens', () => {
    const stats = tenantMetrics.getTenantStats('uid_clean');
    expect(stats.ai_regen_count).toBe(0);
  });
});

describe('T91 — ai_timeout_count', () => {
  test('timeout: true registra como timeout', () => {
    tenantMetrics.recordAICall('uid1', { provider: 'gemini', latencyMs: 45000, success: false, timeout: true });
    const stats = tenantMetrics.getTenantStats('uid1');
    expect(stats.ai_timeout_count).toBe(1);
  });

  test('timeout: false no cuenta como timeout', () => {
    tenantMetrics.recordAICall('uid1', { provider: 'gemini', latencyMs: 800, success: true, timeout: false });
    const stats = tenantMetrics.getTenantStats('uid1');
    expect(stats.ai_timeout_count).toBe(0);
  });

  test('ai_timeout_rate = 0% sin timeouts', () => {
    tenantMetrics.recordAICall('uid1', { provider: 'gemini', latencyMs: 300, success: true, timeout: false });
    const stats = tenantMetrics.getTenantStats('uid1');
    expect(stats.ai_timeout_rate).toBe('0%');
  });

  test('ai_timeout_rate calcula porcentaje correcto 1/2', () => {
    tenantMetrics.recordAICall('uid1', { provider: 'gemini', latencyMs: 500, success: true, timeout: false });
    tenantMetrics.recordAICall('uid1', { provider: 'gemini', latencyMs: 45000, success: false, timeout: true });
    const stats = tenantMetrics.getTenantStats('uid1');
    expect(stats.ai_timeout_rate).toBe('50%');
  });

  test('ai_timeout_count = 0 sin calls', () => {
    const stats = tenantMetrics.getTenantStats('uid_clean');
    expect(stats.ai_timeout_count).toBe(0);
    expect(stats.ai_timeout_rate).toBe('0%');
  });
});

describe('T91 — ai_p95_latency_ms', () => {
  test('ai_p95_latency_ms calcula p95 de calls exitosos', () => {
    [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].forEach(ms => {
      tenantMetrics.recordAICall('uid1', { provider: 'gemini', latencyMs: ms, success: true, timeout: false });
    });
    const stats = tenantMetrics.getTenantStats('uid1');
    expect(stats.ai_p95_latency_ms).toBeGreaterThanOrEqual(900);
  });

  test('ai_p95_latency_ms = 0 sin calls exitosos', () => {
    tenantMetrics.recordAICall('uid1', { provider: 'gemini', latencyMs: 45000, success: false, timeout: true });
    const stats = tenantMetrics.getTenantStats('uid1');
    expect(stats.ai_p95_latency_ms).toBe(0);
  });
});

describe('T91 — aggregateAll T91 fields', () => {
  test('aggregateAll incluye ai_timeouts + ai_regens en global', () => {
    tenantMetrics.recordAICall('uid1', { provider: 'gemini', latencyMs: 45000, success: false, timeout: true });
    tenantMetrics.recordRegeneration('uid1', { reason: 'REGEX' });
    tenantMetrics.recordRegeneration('uid2', { reason: 'V2_CRITICAL' });
    const all = tenantMetrics.aggregateAll();
    expect(all.global.ai_timeouts).toBe(1);
    expect(all.global.ai_regens).toBe(2);
  });
});

describe('T91 — model field en recordAICall', () => {
  test('model field se almacena en aiCalls', () => {
    tenantMetrics.recordAICall('uid1', { provider: 'gemini', latencyMs: 500, success: true, timeout: false, model: 'gemini-2.5-flash' });
    const stats = tenantMetrics.getTenantStats('uid1');
    expect(stats.ai_calls).toBe(1);
    expect(stats.ai_p95_latency_ms).toBe(500);
  });
});

describe('T91 — getMetrics lazy loader en ai_client', () => {
  test('ai_client exporta callAI + callAIChat sin throw', () => {
    const aiClient = require('../ai/ai_client');
    expect(typeof aiClient.callAI).toBe('function');
    expect(typeof aiClient.callAIChat).toBe('function');
  });
});
