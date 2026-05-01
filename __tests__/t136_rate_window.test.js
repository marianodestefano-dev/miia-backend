'use strict';
const { RateWindow } = require('../core/rate_window');

describe('RateWindow — constructor', () => {
  test('lanza si windowMs invalido', () => {
    expect(() => new RateWindow({ windowMs: 0, maxRequests: 5 })).toThrow('windowMs requerido');
    expect(() => new RateWindow({ windowMs: -1, maxRequests: 5 })).toThrow('windowMs requerido');
  });
  test('lanza si maxRequests invalido', () => {
    expect(() => new RateWindow({ windowMs: 1000, maxRequests: 0 })).toThrow('maxRequests requerido');
  });
  test('crea correctamente', () => {
    const rw = new RateWindow({ windowMs: 1000, maxRequests: 5, cleanupIntervalMs: 0 });
    expect(rw).toBeDefined();
    rw.destroy();
  });
});

describe('RateWindow — check', () => {
  let rw;
  beforeEach(() => { rw = new RateWindow({ windowMs: 10000, maxRequests: 3, cleanupIntervalMs: 0 }); });
  afterEach(() => rw.destroy());

  test('lanza si key falta', () => {
    expect(() => rw.check(null)).toThrow('key requerido');
  });
  test('primer request = allowed', () => {
    const r = rw.check('user1');
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
    expect(r.remaining).toBe(2);
  });
  test('hasta maxRequests = todos allowed', () => {
    const now = Date.now();
    rw.check('user1', now);
    rw.check('user1', now + 1);
    const r = rw.check('user1', now + 2);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(0);
  });
  test('superar maxRequests = denied', () => {
    const now = Date.now();
    rw.check('user1', now);
    rw.check('user1', now + 1);
    rw.check('user1', now + 2);
    const r = rw.check('user1', now + 3);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });
  test('diferente key tiene su propio bucket', () => {
    const now = Date.now();
    rw.check('user1', now); rw.check('user1', now); rw.check('user1', now);
    const r = rw.check('user2', now);
    expect(r.allowed).toBe(true);
  });
  test('requests fuera de ventana no cuentan', () => {
    const now = Date.now();
    // 3 requests hace 11 segundos (fuera de ventana de 10s)
    rw.check('user1', now - 11000);
    rw.check('user1', now - 11000);
    rw.check('user1', now - 11000);
    // Ahora deberia poder hacer mas
    const r = rw.check('user1', now);
    expect(r.allowed).toBe(true);
  });
});

describe('RateWindow — peek', () => {
  let rw;
  beforeEach(() => { rw = new RateWindow({ windowMs: 10000, maxRequests: 3, cleanupIntervalMs: 0 }); });
  afterEach(() => rw.destroy());

  test('peek no registra request', () => {
    const now = Date.now();
    rw.check('user1', now);
    const p1 = rw.peek('user1', now);
    const p2 = rw.peek('user1', now);
    expect(p1.count).toBe(p2.count);
    expect(p1.count).toBe(1);
  });
  test('key inexistente = count 0', () => {
    const p = rw.peek('noexiste');
    expect(p.count).toBe(0);
    expect(p.remaining).toBe(3);
  });
});

describe('RateWindow — reset y cleanup', () => {
  let rw;
  beforeEach(() => { rw = new RateWindow({ windowMs: 10000, maxRequests: 3, cleanupIntervalMs: 0 }); });
  afterEach(() => rw.destroy());

  test('reset(key) limpia ese bucket', () => {
    const now = Date.now();
    rw.check('user1', now);
    rw.reset('user1');
    expect(rw.peek('user1').count).toBe(0);
  });
  test('reset() sin arg limpia todo', () => {
    rw.check('user1'); rw.check('user2');
    rw.reset();
    expect(rw.bucketCount).toBe(0);
  });
  test('_cleanup elimina entradas expiradas', () => {
    const now = Date.now();
    rw.check('user1', now - 20000); // fuera de ventana
    rw.check('user2', now);         // dentro
    rw._cleanup(now);
    expect(rw.bucketCount).toBe(1);
  });
});
