'use strict';

/**
 * T53 — tenant_metrics.js skeleton coverage tests
 */

const tm = require('../core/tenant_metrics');

beforeEach(() => {
  tm._resetState();
});

describe('T53 §A — recordIncoming', () => {
  test('uid valido agrega entry', () => {
    tm.recordIncoming('uid_a');
    const s = tm.getTenantStats('uid_a');
    expect(s.messages_in).toBe(1);
  });

  test('uid null/undefined → no-op', () => {
    tm.recordIncoming(null);
    tm.recordIncoming(undefined);
    tm.recordIncoming('');
    expect(tm.aggregateAll().tenants.length).toBe(0);
  });

  test('contactType registrado en breakdown', () => {
    tm.recordIncoming('uid_b', { contactType: 'lead' });
    tm.recordIncoming('uid_b', { contactType: 'lead' });
    tm.recordIncoming('uid_b', { contactType: 'family' });
    const s = tm.getTenantStats('uid_b');
    expect(s.contact_type_breakdown.lead).toBe(2);
    expect(s.contact_type_breakdown.family).toBe(1);
  });

  test('contactType default unknown', () => {
    tm.recordIncoming('uid_c');
    const s = tm.getTenantStats('uid_c');
    expect(s.contact_type_breakdown.unknown).toBe(1);
  });
});

describe('T53 §B — recordOutgoing', () => {
  test('latencyMs registrado para percentiles', () => {
    tm.recordOutgoing('uid_d', { latencyMs: 100 });
    tm.recordOutgoing('uid_d', { latencyMs: 200 });
    tm.recordOutgoing('uid_d', { latencyMs: 500 });
    const s = tm.getTenantStats('uid_d');
    expect(s.messages_out).toBe(3);
    expect(s.out_p50_latency_ms).toBeGreaterThan(0);
    expect(s.out_p95_latency_ms).toBeGreaterThanOrEqual(s.out_p50_latency_ms);
  });

  test('latencyMs no-numero → 0', () => {
    tm.recordOutgoing('uid_e', { latencyMs: 'abc' });
    const s = tm.getTenantStats('uid_e');
    expect(s.messages_out).toBe(1);
  });

  test('uid null → no-op', () => {
    tm.recordOutgoing(null, { latencyMs: 100 });
    expect(tm.aggregateAll().tenants.length).toBe(0);
  });
});

describe('T53 §C — recordError', () => {
  test('error agregado a counter', () => {
    tm.recordError('uid_f', { code: '500', module: 'TMH' });
    const s = tm.getTenantStats('uid_f');
    expect(s.errors).toBe(1);
  });

  test('error_rate calculado vs mensajes totales', () => {
    tm.recordIncoming('uid_g');
    tm.recordIncoming('uid_g');
    tm.recordIncoming('uid_g');
    tm.recordError('uid_g');
    const s = tm.getTenantStats('uid_g');
    // 1 error / 3 msgs = 33%
    expect(s.error_rate).toBe('33%');
  });

  test('uid null → no-op', () => {
    tm.recordError(null);
    expect(tm.aggregateAll().tenants.length).toBe(0);
  });
});

describe('T53 §D — recordAICall', () => {
  test('AI call exitosa → success rate 100%', () => {
    tm.recordAICall('uid_h', { provider: 'gemini', latencyMs: 500, success: true });
    const s = tm.getTenantStats('uid_h');
    expect(s.ai_calls).toBe(1);
    expect(s.ai_success_rate).toBe('100%');
    expect(s.ai_avg_latency_ms).toBe(500);
  });

  test('AI call fallida → success_rate < 100%', () => {
    tm.recordAICall('uid_i', { provider: 'gemini', latencyMs: 100, success: true });
    tm.recordAICall('uid_i', { provider: 'gemini', latencyMs: 200, success: false });
    const s = tm.getTenantStats('uid_i');
    expect(s.ai_success_rate).toBe('50%');
  });

  test('AI call sin opts → defaults', () => {
    tm.recordAICall('uid_j');
    const s = tm.getTenantStats('uid_j');
    expect(s.ai_calls).toBe(1);
    expect(s.ai_success_rate).toBe('100%');
  });

  test('AI call uid null → no-op', () => {
    tm.recordAICall(null);
    expect(tm.aggregateAll().tenants.length).toBe(0);
  });
});

describe('T53 §E — getTenantStats', () => {
  test('uid sin estado → defaults', () => {
    const s = tm.getTenantStats('uid_no_data');
    expect(s.messages_in).toBe(0);
    expect(s.messages_out).toBe(0);
    expect(s.errors).toBe(0);
    expect(s.error_rate).toBe('0%');
    expect(s.ai_calls).toBe(0);
    expect(s.ai_success_rate).toBe('100%');
  });

  test('uid null → defaults sin uid', () => {
    const s = tm.getTenantStats(null);
    expect(s.uid).toBeNull();
    expect(s.messages_in).toBe(0);
  });

  test('window_ms incluido en stats', () => {
    tm.recordIncoming('uid_w');
    const s = tm.getTenantStats('uid_w');
    expect(s.window_ms).toBe(tm.WINDOW_MS);
  });
});

describe('T53 §F — aggregateAll', () => {
  test('multiples tenants → tenants array + global', () => {
    tm.recordIncoming('uid_x');
    tm.recordIncoming('uid_y');
    tm.recordOutgoing('uid_x', { latencyMs: 100 });
    const r = tm.aggregateAll();
    expect(r.tenants.length).toBe(2);
    expect(r.global.tenant_count).toBe(2);
    expect(r.global.messages_in).toBe(2);
    expect(r.global.messages_out).toBe(1);
  });

  test('sin tenants → global con counts 0', () => {
    const r = tm.aggregateAll();
    expect(r.tenants.length).toBe(0);
    expect(r.global.tenant_count).toBe(0);
    expect(r.global.messages_in).toBe(0);
    expect(r.global.error_rate).toBe('0%');
  });

  test('global timestamp es ISO string', () => {
    tm.recordIncoming('uid_t');
    const r = tm.aggregateAll();
    expect(typeof r.global.timestamp).toBe('string');
    expect(r.global.timestamp).toMatch(/T.*Z$/);
  });

  test('global error_rate calculado vs total messages', () => {
    tm.recordIncoming('uid_z');
    tm.recordOutgoing('uid_z');
    tm.recordError('uid_z');
    const r = tm.aggregateAll();
    expect(r.global.error_rate).toBe('50%'); // 1/2
  });
});

describe('T53 §G — Constantes y reset', () => {
  test('WINDOW_MS exportado y > 0', () => {
    expect(typeof tm.WINDOW_MS).toBe('number');
    expect(tm.WINDOW_MS).toBeGreaterThan(0);
  });

  test('_resetState limpia todo', () => {
    tm.recordIncoming('uid_r');
    tm._resetState();
    expect(tm.aggregateAll().tenants.length).toBe(0);
  });
});

describe('T53 §H — _pruneOld via mockear ts viejos', () => {
  test('eventos viejos se eliminan al consultar stats', () => {
    // Insertar uno antiguo manualmente via API (recordIncoming) y avanzar el tiempo
    const orig = Date.now;
    const t0 = 1000000;
    Date.now = () => t0;
    tm.recordIncoming('uid_old');
    // Avanzar 6 minutos (mas que WINDOW_MS de 5 min)
    Date.now = () => t0 + 6 * 60 * 1000;
    const s = tm.getTenantStats('uid_old');
    Date.now = orig;
    expect(s.messages_in).toBe(0); // pruned
  });
});
