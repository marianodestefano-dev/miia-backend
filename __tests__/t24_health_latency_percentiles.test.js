'use strict';

/**
 * Tests: T24 — health_check.js latency rolling percentiles p50/p95/p99.
 *
 * Origen: T20 propuesta E2 (latency histograma rolling). Wi firmo T24
 * mail [161] — "Top 1 mejora T20 health check". Vi seleccion: E2 latency
 * percentiles para AI gateway + Firestore (conecta con T11 logging que
 * ARQ ya implemento en JUEGA MIIA).
 *
 * §A — Tests estaticos sobre source health_check.js.
 * §B — Tests runtime: recordLatency + computePercentiles.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HC_PATH = path.resolve(__dirname, '../core/health_check.js');
const HC_SOURCE = fs.readFileSync(HC_PATH, 'utf8');

// ════════════════════════════════════════════════════════════════════
// §A — Verificacion estatica de source health_check.js
// ════════════════════════════════════════════════════════════════════

describe('T24 §A — latency percentiles en source health_check.js', () => {
  test('A.1 — comentario T24-FIX presente (trazabilidad)', () => {
    expect(HC_SOURCE).toMatch(/T24-FIX/);
  });

  test('A.2 — recordLatency function definida', () => {
    expect(HC_SOURCE).toMatch(/function recordLatency\(component, latencyMs\)/);
  });

  test('A.3 — computePercentiles function definida', () => {
    expect(HC_SOURCE).toMatch(/function computePercentiles\(component\)/);
  });

  test('A.4 — LATENCY_BUFFER_SIZE constante definida', () => {
    expect(HC_SOURCE).toMatch(/const LATENCY_BUFFER_SIZE\s*=\s*100/);
  });

  test('A.5 — checkFirestore llama recordLatency en happy path', () => {
    // Buscar bloque checkFirestore + recordLatency
    const idx = HC_SOURCE.indexOf("async function checkFirestore");
    expect(idx).toBeGreaterThan(0);
    const block = HC_SOURCE.slice(idx, idx + 1000);
    expect(block).toMatch(/recordLatency\('firestore', latency\)/);
  });

  test('A.6 — checkAIGateway llama recordLatency cuando result === true', () => {
    const idx = HC_SOURCE.indexOf("async function checkAIGateway");
    expect(idx).toBeGreaterThan(0);
    const block = HC_SOURCE.slice(idx, idx + 1500);
    expect(block).toMatch(/if \(result\) recordLatency\('aiGateway', latency\)/);
  });

  test('A.7 — getHealthStatus expone latency percentiles en response', () => {
    expect(HC_SOURCE).toMatch(/firestorePct\s*=\s*computePercentiles\('firestore'\)/);
    expect(HC_SOURCE).toMatch(/aiGatewayPct\s*=\s*computePercentiles\('aiGateway'\)/);
    expect(HC_SOURCE).toMatch(/latency:\s*firestorePct/);
    expect(HC_SOURCE).toMatch(/latency:\s*aiGatewayPct/);
  });

  test('A.8 — exports recordLatency, computePercentiles, _health, LATENCY_BUFFER_SIZE', () => {
    expect(HC_SOURCE).toMatch(/recordLatency,/);
    expect(HC_SOURCE).toMatch(/computePercentiles,/);
    expect(HC_SOURCE).toMatch(/_health,/);
    expect(HC_SOURCE).toMatch(/LATENCY_BUFFER_SIZE,/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — Tests runtime: recordLatency + computePercentiles
// ════════════════════════════════════════════════════════════════════

describe('T24 §B — latency rolling buffer logica', () => {
  let recordLatency, computePercentiles, _health, LATENCY_BUFFER_SIZE;

  beforeAll(() => {
    // Mock firebase-admin antes de require health_check
    jest.doMock('firebase-admin', () => ({
      firestore: () => ({ collection: () => ({ doc: () => ({ set: () => Promise.resolve() }) }) }),
      // FieldValue agregado para evitar TypeError en checkFirestore
    }));
    jest.doMock('../whatsapp/tenant_manager', () => ({
      getUpsertStats: () => ({ count10min: 0, count20min: 0, lastUpsertAt: null }),
    }));
    const hc = require('../core/health_check');
    recordLatency = hc.recordLatency;
    computePercentiles = hc.computePercentiles;
    _health = hc._health;
    LATENCY_BUFFER_SIZE = hc.LATENCY_BUFFER_SIZE;
  });

  beforeEach(() => {
    // Reset state entre tests
    _health.firestore.latencyHistory = [];
    _health.aiGateway.latencyHistory = [];
  });

  test('B.1 — recordLatency agrega sample al buffer', () => {
    recordLatency('firestore', 50);
    expect(_health.firestore.latencyHistory).toEqual([50]);
  });

  test('B.2 — recordLatency rechaza valores no numericos', () => {
    recordLatency('firestore', 'foo');
    recordLatency('firestore', null);
    recordLatency('firestore', undefined);
    recordLatency('firestore', -10);
    expect(_health.firestore.latencyHistory).toEqual([]);
  });

  test('B.3 — recordLatency limita buffer a LATENCY_BUFFER_SIZE (100)', () => {
    for (let i = 0; i < 150; i++) recordLatency('firestore', i);
    expect(_health.firestore.latencyHistory.length).toBe(LATENCY_BUFFER_SIZE);
    // Los primeros 50 fueron descartados (FIFO)
    expect(_health.firestore.latencyHistory[0]).toBe(50);
    expect(_health.firestore.latencyHistory[99]).toBe(149);
  });

  test('B.4 — computePercentiles retorna null si < 5 samples', () => {
    recordLatency('firestore', 100);
    recordLatency('firestore', 200);
    expect(computePercentiles('firestore')).toBeNull();
  });

  test('B.5 — computePercentiles calcula p50/p95/p99 con dataset conocido', () => {
    // Dataset: 10, 20, 30, ..., 1000 (100 samples)
    for (let i = 1; i <= 100; i++) recordLatency('firestore', i * 10);
    const pct = computePercentiles('firestore');
    expect(pct).not.toBeNull();
    expect(pct.samples).toBe(100);
    expect(pct.min).toBe(10);
    expect(pct.max).toBe(1000);
    // p50 ~= 510 (sample idx 50 de 100), p95 ~= 960, p99 ~= 1000
    expect(pct.p50).toBeGreaterThanOrEqual(500);
    expect(pct.p50).toBeLessThanOrEqual(520);
    expect(pct.p95).toBeGreaterThanOrEqual(950);
    expect(pct.p99).toBeGreaterThanOrEqual(990);
  });

  test('B.6 — computePercentiles avg correcto', () => {
    [100, 200, 300, 400, 500].forEach(v => recordLatency('aiGateway', v));
    const pct = computePercentiles('aiGateway');
    expect(pct.avg).toBe(300); // (100+200+300+400+500)/5 = 300
  });

  test('B.7 — buffers de componentes son independientes', () => {
    recordLatency('firestore', 100);
    recordLatency('aiGateway', 999);
    expect(_health.firestore.latencyHistory).toEqual([100]);
    expect(_health.aiGateway.latencyHistory).toEqual([999]);
  });

  test('B.8 — computePercentiles componente desconocido retorna null', () => {
    expect(computePercentiles('inexistente')).toBeNull();
  });
});
