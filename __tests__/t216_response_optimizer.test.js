'use strict';

const {
  classifyLatency, calculatePercentile, analyzeResponseTimes,
  generateLatencyReport, shouldThrottle, estimateQueueDelay,
  P95_TARGET_MS, P99_TARGET_MS, RESPONSE_BUCKETS,
} = require('../core/response_optimizer');

describe('P95_TARGET_MS / P99_TARGET_MS / RESPONSE_BUCKETS', () => {
  test('P95_TARGET_MS es 2000', () => {
    expect(P95_TARGET_MS).toBe(2000);
  });
  test('P99_TARGET_MS es 5000', () => {
    expect(P99_TARGET_MS).toBe(5000);
  });
  test('RESPONSE_BUCKETS tiene buckets comunes', () => {
    expect(RESPONSE_BUCKETS).toContain('<500ms');
    expect(RESPONSE_BUCKETS).toContain('>5s');
  });
  test('RESPONSE_BUCKETS es frozen', () => {
    expect(() => { RESPONSE_BUCKETS.push('extra'); }).toThrow();
  });
});

describe('classifyLatency', () => {
  test('lanza para valor negativo', () => {
    expect(() => classifyLatency(-1)).toThrow('numero positivo');
  });
  test('clasifica 200ms como <500ms', () => {
    expect(classifyLatency(200)).toBe('<500ms');
  });
  test('clasifica 750ms como 500-1s', () => {
    expect(classifyLatency(750)).toBe('500-1s');
  });
  test('clasifica 1500ms como 1-2s', () => {
    expect(classifyLatency(1500)).toBe('1-2s');
  });
  test('clasifica 3000ms como 2-5s', () => {
    expect(classifyLatency(3000)).toBe('2-5s');
  });
  test('clasifica 6000ms como >5s', () => {
    expect(classifyLatency(6000)).toBe('>5s');
  });
});

describe('calculatePercentile', () => {
  test('retorna 0 para array vacio', () => {
    expect(calculatePercentile([], 95)).toBe(0);
  });
  test('lanza si percentile fuera de rango', () => {
    expect(() => calculatePercentile([1,2,3], 101)).toThrow('0-100');
  });
  test('P95 de [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]', () => {
    const times = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
    expect(calculatePercentile(times, 95)).toBe(10000);
  });
  test('P50 de 10 elementos uniformes', () => {
    const times = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
    const p50 = calculatePercentile(times, 50);
    expect(p50).toBeGreaterThan(0);
  });
});

describe('analyzeResponseTimes', () => {
  test('lanza si times no es array', () => {
    expect(() => analyzeResponseTimes('no')).toThrow('debe ser array');
  });
  test('retorna ceros para array vacio', () => {
    const r = analyzeResponseTimes([]);
    expect(r.p95).toBe(0);
    expect(r.count).toBe(0);
    expect(r.meetsTarget).toBe(true);
  });
  test('meetsTarget true cuando P95 < 2s', () => {
    const times = Array.from({ length: 100 }, () => 500);
    const r = analyzeResponseTimes(times);
    expect(r.meetsTarget).toBe(true);
    expect(r.p95).toBe(500);
  });
  test('meetsTarget false cuando P95 > 2s', () => {
    const times = Array.from({ length: 100 }, () => 3000);
    const r = analyzeResponseTimes(times);
    expect(r.meetsTarget).toBe(false);
  });
  test('calcula mean correctamente', () => {
    const times = [1000, 2000, 3000];
    const r = analyzeResponseTimes(times);
    expect(r.mean).toBe(2000);
  });
});

describe('generateLatencyReport', () => {
  test('lanza si times no es array', () => {
    expect(() => generateLatencyReport('no')).toThrow('debe ser array');
  });
  test('retorna stats y buckets y recommendation', () => {
    const times = [100, 200, 300, 1500, 5000];
    const r = generateLatencyReport(times);
    expect(r.stats).toBeDefined();
    expect(r.buckets).toBeDefined();
    expect(r.recommendation).toBeDefined();
  });
  test('recommendation OK cuando dentro del target', () => {
    const times = Array.from({ length: 100 }, () => 500);
    const r = generateLatencyReport(times);
    expect(r.recommendation).toContain('OK');
  });
  test('recommendation ALERTA cuando fuera del target', () => {
    const times = Array.from({ length: 100 }, () => 3000);
    const r = generateLatencyReport(times);
    expect(r.recommendation).toContain('ALERTA');
  });
});

describe('shouldThrottle', () => {
  test('lanza si recentTimes no es array', () => {
    expect(() => shouldThrottle('no')).toThrow('debe ser array');
  });
  test('false para array vacio', () => {
    expect(shouldThrottle([])).toBe(false);
  });
  test('false cuando tiempos bajo target', () => {
    expect(shouldThrottle(Array.from({ length: 20 }, () => 500))).toBe(false);
  });
  test('true cuando tiempos sobre target', () => {
    expect(shouldThrottle(Array.from({ length: 20 }, () => 3000))).toBe(true);
  });
});

describe('estimateQueueDelay', () => {
  test('lanza si pendingCount invalido', () => {
    expect(() => estimateQueueDelay(-1, 100)).toThrow('pendingCount invalido');
  });
  test('lanza si avgProcessingMs invalido', () => {
    expect(() => estimateQueueDelay(5, 0)).toThrow('avgProcessingMs invalido');
  });
  test('calcula delay correctamente', () => {
    const r = estimateQueueDelay(5, 200);
    expect(r.estimatedMs).toBe(1000);
    expect(r.exceedsTarget).toBe(false);
  });
  test('exceedsTarget true si delay alto', () => {
    const r = estimateQueueDelay(20, 200);
    expect(r.exceedsTarget).toBe(true);
  });
  test('recommendBatch true si pendingCount > 10', () => {
    const r = estimateQueueDelay(15, 100);
    expect(r.recommendBatch).toBe(true);
  });
});
