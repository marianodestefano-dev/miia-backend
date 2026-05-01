'use strict';
const { MessageQueue, DEFAULT_TTL_MS, VALID_PRIORITIES, PRIORITY_VALUE } = require('../core/message_queue');

describe('constantes', () => {
  test('DEFAULT_TTL_MS = 5 minutos', () => {
    expect(DEFAULT_TTL_MS).toBe(5 * 60 * 1000);
  });
  test('VALID_PRIORITIES contiene high/normal/low', () => {
    expect(VALID_PRIORITIES).toContain('high');
    expect(VALID_PRIORITIES).toContain('normal');
    expect(VALID_PRIORITIES).toContain('low');
  });
  test('PRIORITY_VALUE: high < normal < low (valor numerico)', () => {
    expect(PRIORITY_VALUE.high).toBeLessThan(PRIORITY_VALUE.normal);
    expect(PRIORITY_VALUE.normal).toBeLessThan(PRIORITY_VALUE.low);
  });
});

describe('enqueue — validacion', () => {
  let q;
  beforeEach(() => { q = new MessageQueue(); });

  test('lanza si uid falta', () => {
    expect(() => q.enqueue(null, '+1234', 'msg')).toThrow('uid requerido');
  });
  test('lanza si phone falta', () => {
    expect(() => q.enqueue('uid1', '', 'msg')).toThrow('phone requerido');
  });
  test('lanza si message falta', () => {
    expect(() => q.enqueue('uid1', '+1234', '')).toThrow('message requerido');
  });
  test('lanza si priority invalida', () => {
    expect(() => q.enqueue('uid1', '+1234', 'msg', { priority: 'urgent' })).toThrow('priority invalido');
  });
  test('retorna id, enqueuedAt, expiresAt', () => {
    const r = q.enqueue('uid1', '+1234', 'hola');
    expect(r.id).toBeGreaterThan(0);
    expect(r.enqueuedAt).toBeGreaterThan(0);
    expect(r.expiresAt).toBe(r.enqueuedAt + DEFAULT_TTL_MS);
  });
});

describe('enqueue + dequeue', () => {
  let q;
  beforeEach(() => { q = new MessageQueue(); });

  test('dequeue retorna item encolado', () => {
    q.enqueue('uid1', '+1234', 'hola');
    const item = q.dequeue('uid1', '+1234');
    expect(item).not.toBeNull();
    expect(item.message).toBe('hola');
  });
  test('dequeue retorna null si no hay items', () => {
    expect(q.dequeue('uid1', '+1234')).toBeNull();
  });
  test('dequeue null si uid no coincide', () => {
    q.enqueue('uid1', '+1234', 'hola');
    expect(q.dequeue('uid2', '+1234')).toBeNull();
  });
  test('size cuenta correctamente', () => {
    q.enqueue('uid1', '+1234', 'msg1');
    q.enqueue('uid1', '+1234', 'msg2');
    expect(q.size('uid1')).toBe(2);
    q.dequeue('uid1', '+1234');
    expect(q.size('uid1')).toBe(1);
  });
});

describe('prioridad', () => {
  let q;
  beforeEach(() => { q = new MessageQueue(); });

  test('high se extrae antes que normal', () => {
    q.enqueue('uid1', '+1234', 'normal msg', { priority: 'normal' });
    q.enqueue('uid1', '+1234', 'high msg', { priority: 'high' });
    const item = q.dequeue('uid1', '+1234');
    expect(item.priority).toBe('high');
    expect(item.message).toBe('high msg');
  });
  test('normal se extrae antes que low', () => {
    q.enqueue('uid1', '+1234', 'low msg', { priority: 'low' });
    q.enqueue('uid1', '+1234', 'normal msg', { priority: 'normal' });
    const item = q.dequeue('uid1', '+1234');
    expect(item.priority).toBe('normal');
  });
  test('mismo priority: FIFO por enqueuedAt', () => {
    q.enqueue('uid1', '+1234', 'first');
    q.enqueue('uid1', '+1234', 'second');
    const item = q.dequeue('uid1', '+1234');
    expect(item.message).toBe('first');
  });
});

describe('TTL y expiracion', () => {
  test('item expirado no se dequeue', () => {
    const q = new MessageQueue({ ttlMs: 100 });
    q.enqueue('uid1', '+1234', 'msg');
    const future = Date.now() + 200;
    const item = q.dequeue('uid1', '+1234', future);
    expect(item).toBeNull();
  });
  test('size = 0 para items expirados', () => {
    const q = new MessageQueue({ ttlMs: 100 });
    q.enqueue('uid1', '+1234', 'msg');
    expect(q.size('uid1', Date.now() + 200)).toBe(0);
  });
});

describe('dequeueNext y clear', () => {
  let q;
  beforeEach(() => { q = new MessageQueue(); });

  test('dequeueNext retorna el de mayor prioridad entre todos los phones', () => {
    q.enqueue('uid1', '+1111', 'low msg', { priority: 'low' });
    q.enqueue('uid1', '+2222', 'high msg', { priority: 'high' });
    const item = q.dequeueNext('uid1');
    expect(item.priority).toBe('high');
    expect(item.phone).toBe('+2222');
  });
  test('dequeueNext null si no hay items para uid', () => {
    expect(q.dequeueNext('uid_vacio')).toBeNull();
  });
  test('clear(uid) borra solo los del uid', () => {
    q.enqueue('uid1', '+1234', 'msg1');
    q.enqueue('uid2', '+5678', 'msg2');
    q.clear('uid1');
    expect(q.size('uid1')).toBe(0);
    expect(q.size('uid2')).toBe(1);
  });
  test('clear() sin uid vacia todo', () => {
    q.enqueue('uid1', '+1234', 'msg1');
    q.enqueue('uid2', '+5678', 'msg2');
    q.clear();
    expect(q.size()).toBe(0);
  });
});
