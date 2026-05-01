'use strict';

const { withRetry, calcDelay, isRetryable, DEFAULTS } = require('../core/retry_manager');
const { MessageQueue, DEFAULT_TTL_MS, VALID_PRIORITIES, PRIORITY_VALUE } = require('../core/message_queue');

const UID = 'uid_t322';
const PHONE = '+571111222';
const NOW = 1000000000000;

describe('T322 -- retry_manager + message_queue (30 tests)', () => {

  // DEFAULTS
  test('DEFAULTS frozen', () => {
    expect(() => { DEFAULTS.maxRetries = 99; }).toThrow();
  });

  test('DEFAULTS.maxRetries=3, baseDelayMs=500, maxDelayMs=30000', () => {
    expect(DEFAULTS.maxRetries).toBe(3);
    expect(DEFAULTS.baseDelayMs).toBe(500);
    expect(DEFAULTS.maxDelayMs).toBe(30000);
  });

  // calcDelay
  test('calcDelay attempt=0: baseDelayMs', () => {
    const d = calcDelay(0, { baseDelayMs: 500, maxDelayMs: 30000, jitter: 0 });
    expect(d).toBe(500);
  });

  test('calcDelay attempt=1: 2x baseDelayMs', () => {
    const d = calcDelay(1, { baseDelayMs: 500, maxDelayMs: 30000, jitter: 0 });
    expect(d).toBe(1000);
  });

  test('calcDelay capped por maxDelayMs', () => {
    const d = calcDelay(10, { baseDelayMs: 500, maxDelayMs: 2000, jitter: 0 });
    expect(d).toBe(2000);
  });

  // isRetryable
  test('isRetryable: null retryableErrors -> siempre true', () => {
    expect(isRetryable(new Error('cualquiera'), null)).toBe(true);
  });

  test('isRetryable: set vacio -> siempre false', () => {
    expect(isRetryable(new Error('cualquiera'), new Set())).toBe(false);
  });

  test('isRetryable: error.message incluye patron', () => {
    const err = new Error('network timeout');
    expect(isRetryable(err, new Set(['timeout']))).toBe(true);
  });

  test('isRetryable: error.status en set', () => {
    const err = Object.assign(new Error('server error'), { status: 503 });
    expect(isRetryable(err, new Set(['503']))).toBe(true);
  });

  test('isRetryable: error no coincide patron -> false', () => {
    expect(isRetryable(new Error('not found'), new Set(['timeout', '503']))).toBe(false);
  });

  // withRetry
  test('withRetry: fn no es funcion -> lanza', async () => {
    await expect(withRetry(null)).rejects.toThrow('fn requerido');
  });

  test('withRetry: fn exitosa primera vez', async () => {
    const r = await withRetry(async () => 42, { _sleep: async () => {} });
    expect(r).toBe(42);
  });

  test('withRetry: reintenta y eventualmente exita', async () => {
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    }, { maxRetries: 3, baseDelayMs: 1, _sleep: async () => {} });
    expect(r).toBe('ok');
    expect(calls).toBe(3);
  });

  test('withRetry: agota reintentos y lanza ultimo error', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw new Error(`error ${calls}`);
    }, { maxRetries: 2, baseDelayMs: 1, _sleep: async () => {} })).rejects.toThrow('error 3');
    expect(calls).toBe(3);
  });

  test('withRetry: error no reintentable -> falla inmediatamente', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw new Error('not found');
    }, { maxRetries: 3, retryableErrors: new Set(['timeout']), _sleep: async () => {} })).rejects.toThrow('not found');
    expect(calls).toBe(1);
  });

  // MessageQueue — constants
  test('VALID_PRIORITIES frozen y contiene high/normal/low', () => {
    expect(() => { VALID_PRIORITIES.push('ultra'); }).toThrow();
    expect(VALID_PRIORITIES).toContain('high');
    expect(VALID_PRIORITIES).toContain('normal');
    expect(VALID_PRIORITIES).toContain('low');
  });

  test('PRIORITY_VALUE: high=1, normal=2, low=3', () => {
    expect(PRIORITY_VALUE.high).toBe(1);
    expect(PRIORITY_VALUE.normal).toBe(2);
    expect(PRIORITY_VALUE.low).toBe(3);
  });

  test('DEFAULT_TTL_MS = 5min', () => {
    expect(DEFAULT_TTL_MS).toBe(5 * 60 * 1000);
  });

  // enqueue
  test('enqueue: uid null lanza', () => {
    const q = new MessageQueue();
    expect(() => q.enqueue(null, PHONE, 'msg')).toThrow('uid requerido');
  });

  test('enqueue: phone null lanza', () => {
    const q = new MessageQueue();
    expect(() => q.enqueue(UID, null, 'msg')).toThrow('phone requerido');
  });

  test('enqueue: priority invalida lanza', () => {
    const q = new MessageQueue();
    expect(() => q.enqueue(UID, PHONE, 'msg', { priority: 'ultra' })).toThrow('priority invalido');
  });

  test('enqueue: retorna id, enqueuedAt, expiresAt', () => {
    const q = new MessageQueue();
    const r = q.enqueue(UID, PHONE, 'hola');
    expect(r.id).toBe(1);
    expect(r.enqueuedAt).toBeDefined();
    expect(r.expiresAt).toBeGreaterThan(r.enqueuedAt);
  });

  // prioridad
  test('high priority sale antes que normal', () => {
    const q = new MessageQueue();
    q.enqueue(UID, PHONE, 'normal msg', { priority: 'normal' });
    q.enqueue(UID, PHONE, 'high msg', { priority: 'high' });
    const first = q.dequeue(UID, PHONE);
    expect(first.message).toBe('high msg');
    expect(first.priority).toBe('high');
  });

  // dequeue
  test('dequeue: retorna null si no hay msgs', () => {
    const q = new MessageQueue();
    expect(q.dequeue(UID, PHONE)).toBeNull();
  });

  test('dequeue: extrae mensaje correcto por uid+phone', () => {
    const q = new MessageQueue();
    q.enqueue(UID, PHONE, 'mensaje1');
    q.enqueue(UID, '+5799999', 'mensaje2');
    const r = q.dequeue(UID, PHONE);
    expect(r.message).toBe('mensaje1');
    expect(q.size(UID)).toBe(1);
  });

  // dequeueNext
  test('dequeueNext: extrae el de mayor prioridad de cualquier phone', () => {
    const q = new MessageQueue();
    q.enqueue(UID, PHONE, 'low', { priority: 'low' });
    q.enqueue(UID, '+5799999', 'high', { priority: 'high' });
    const r = q.dequeueNext(UID);
    expect(r.message).toBe('high');
  });

  // size
  test('size: cuenta items del uid', () => {
    const q = new MessageQueue();
    q.enqueue(UID, PHONE, 'a');
    q.enqueue(UID, PHONE, 'b');
    q.enqueue('otro_uid', PHONE, 'c');
    expect(q.size(UID)).toBe(2);
  });

  // TTL / expiración
  test('TTL: mensaje expirado no se retorna en dequeue', () => {
    const q = new MessageQueue({ ttlMs: 100 });
    q.enqueue(UID, PHONE, 'viejo');
    // enqueue usa Date.now() internamente, usar futureMs relativo al tiempo real
    const futureMs = Date.now() + 500;
    const r = q.dequeue(UID, PHONE, futureMs);
    expect(r).toBeNull();
    expect(q.size(UID, futureMs)).toBe(0);
  });

  // clear
  test('clear(uid): elimina solo los del uid', () => {
    const q = new MessageQueue();
    q.enqueue(UID, PHONE, 'a');
    q.enqueue('otro', PHONE, 'b');
    q.clear(UID);
    expect(q.size(UID)).toBe(0);
    expect(q.size('otro')).toBe(1);
  });

  test('clear sin uid: vacia todo', () => {
    const q = new MessageQueue();
    q.enqueue(UID, PHONE, 'a');
    q.enqueue('otro', PHONE, 'b');
    q.clear();
    expect(q.size()).toBe(0);
  });
});
