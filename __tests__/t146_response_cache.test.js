'use strict';
const { ResponseCache, buildCacheKey, DEFAULT_TTL_MS, DEFAULT_MAX_SIZE } = require('../core/response_cache');

const NOW = Date.now();

describe('buildCacheKey', () => {
  test('null prompt retorna null', () => { expect(buildCacheKey(null)).toBeNull(); });
  test('genera key de 16 chars hex', () => {
    const k = buildCacheKey('prompt', 'ctx');
    expect(k.length).toBe(16);
    expect(k).toMatch(/^[a-f0-9]+$/);
  });
  test('mismo prompt + ctx = misma key', () => {
    expect(buildCacheKey('p', 'c')).toBe(buildCacheKey('p', 'c'));
  });
  test('diferente ctx = diferente key', () => {
    expect(buildCacheKey('p', 'c1')).not.toBe(buildCacheKey('p', 'c2'));
  });
});

describe('ResponseCache — constructor', () => {
  test('lanza si ttlMs <= 0', () => {
    expect(() => new ResponseCache({ ttlMs: 0 })).toThrow('ttlMs debe ser > 0');
  });
  test('lanza si maxSize <= 0', () => {
    expect(() => new ResponseCache({ maxSize: 0 })).toThrow('maxSize debe ser > 0');
  });
  test('size inicial = 0', () => {
    const c = new ResponseCache();
    expect(c.size).toBe(0);
  });
});

describe('ResponseCache — get/set', () => {
  let c;
  beforeEach(() => { c = new ResponseCache({ ttlMs: 60000 }); });

  test('get key inexistente = null', () => {
    expect(c.get('no_existe', NOW)).toBeNull();
  });
  test('set lanza si key falta', () => {
    expect(() => c.set(null, 'resp')).toThrow('key requerida');
  });
  test('set lanza si response null', () => {
    expect(() => c.set('key', null)).toThrow('response requerida');
  });
  test('set y get retorna la respuesta', () => {
    c.set('k1', 'respuesta de MIIA', NOW);
    expect(c.get('k1', NOW)).toBe('respuesta de MIIA');
  });
  test('get despues de TTL retorna null', () => {
    c.set('k1', 'resp', NOW);
    expect(c.get('k1', NOW + 70000)).toBeNull();
  });
  test('size incrementa con set', () => {
    c.set('k1', 'r1', NOW);
    c.set('k2', 'r2', NOW);
    expect(c.size).toBe(2);
  });
  test('get incrementa hits', () => {
    c.set('k1', 'resp', NOW);
    c.get('k1', NOW);
    c.get('k1', NOW);
    expect(c.getStats().totalHits).toBe(2);
  });
});

describe('ResponseCache — eviction y invalidate', () => {
  test('evictExpired limpia entradas expiradas', () => {
    const c = new ResponseCache({ ttlMs: 1000 });
    c.set('k1', 'r', NOW);
    c.set('k2', 'r', NOW + 500);
    const evicted = c.evictExpired(NOW + 1100);
    expect(evicted).toBe(1); // solo k1 expiro (>1000ms)
  });
  test('maxSize evicta el mas antiguo', () => {
    const c = new ResponseCache({ maxSize: 2, ttlMs: 60000 });
    c.set('k1', 'r1', NOW);
    c.set('k2', 'r2', NOW + 1);
    c.set('k3', 'r3', NOW + 2); // evicta k1
    expect(c.size).toBe(2);
    expect(c.get('k1', NOW)).toBeNull();
    expect(c.get('k2', NOW)).not.toBeNull();
  });
  test('invalidate elimina la entrada', () => {
    const c = new ResponseCache({ ttlMs: 60000 });
    c.set('k1', 'r', NOW);
    c.invalidate('k1');
    expect(c.get('k1', NOW)).toBeNull();
  });
  test('clear vacia todo', () => {
    const c = new ResponseCache({ ttlMs: 60000 });
    c.set('k1', 'r1'); c.set('k2', 'r2');
    c.clear();
    expect(c.size).toBe(0);
  });
});

describe('ResponseCache — getStats', () => {
  test('retorna stats correctos', () => {
    const c = new ResponseCache({ ttlMs: 60000, maxSize: 100 });
    c.set('k1', 'r', NOW);
    const s = c.getStats();
    expect(s.size).toBe(1);
    expect(s.maxSize).toBe(100);
    expect(s.ttlMs).toBe(60000);
    expect(s.totalHits).toBe(0);
  });
});
