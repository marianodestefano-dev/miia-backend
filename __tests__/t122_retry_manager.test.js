'use strict';
const { withRetry, calcDelay, isRetryable, DEFAULTS } = require('../core/retry_manager');

describe('DEFAULTS', () => {
  test('maxRetries=3, baseDelayMs=500, maxDelayMs=30000, jitter=0.3', () => {
    expect(DEFAULTS.maxRetries).toBe(3);
    expect(DEFAULTS.baseDelayMs).toBe(500);
    expect(DEFAULTS.maxDelayMs).toBe(30000);
    expect(DEFAULTS.jitter).toBe(0.3);
  });
});

describe('calcDelay', () => {
  test('attempt 0 = baseDelayMs (sin jitter)', () => {
    const d = calcDelay(0, { baseDelayMs: 500, maxDelayMs: 30000, jitter: 0 });
    expect(d).toBe(500);
  });
  test('attempt 1 = 2x base (sin jitter)', () => {
    const d = calcDelay(1, { baseDelayMs: 500, maxDelayMs: 30000, jitter: 0 });
    expect(d).toBe(1000);
  });
  test('capped por maxDelayMs', () => {
    const d = calcDelay(10, { baseDelayMs: 500, maxDelayMs: 2000, jitter: 0 });
    expect(d).toBe(2000);
  });
  test('con jitter el delay es mayor al base', () => {
    const d = calcDelay(0, { baseDelayMs: 500, maxDelayMs: 30000, jitter: 0.5 });
    expect(d).toBeGreaterThanOrEqual(500);
  });
});

describe('isRetryable', () => {
  test('sin retryableErrors todo es reintentable', () => {
    expect(isRetryable(new Error('any'), null)).toBe(true);
    expect(isRetryable(new Error('any'), new Set())).toBe(false); // set vacio = ninguno
  });
  test('set vacio = false', () => {
    expect(isRetryable(new Error('anything'), new Set())).toBe(false);
  });
  test('match por status code string', () => {
    const err = Object.assign(new Error('rate limit'), { status: 429 });
    expect(isRetryable(err, new Set(['429']))).toBe(true);
  });
  test('match por message pattern', () => {
    const err = new Error('network timeout occurred');
    expect(isRetryable(err, new Set(['timeout']))).toBe(true);
  });
  test('no match = false', () => {
    const err = new Error('auth failed');
    expect(isRetryable(err, new Set(['timeout', '429']))).toBe(false);
  });
});

describe('withRetry', () => {
  const noSleep = () => Promise.resolve();

  test('lanza si fn no es funcion', async () => {
    await expect(withRetry(null)).rejects.toThrow('fn requerido');
  });

  test('retorna resultado en primer intento', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { _sleep: noSleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('reintenta hasta maxRetries y luego lanza', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    await expect(withRetry(fn, { maxRetries: 2, _sleep: noSleep })).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(3); // intento 0 + 2 reintentos
  });

  test('exito en segundo intento', async () => {
    let calls = 0;
    const fn = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) throw new Error('retry me');
      return 'success';
    });
    const result = await withRetry(fn, { maxRetries: 3, _sleep: noSleep });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('no reintenta si error no esta en retryableErrors', async () => {
    const err = Object.assign(new Error('auth failed'), { status: 401 });
    const fn = jest.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxRetries: 3, retryableErrors: new Set(['429']), _sleep: noSleep })).rejects.toThrow('auth failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('reintenta si status code en retryableErrors', async () => {
    let calls = 0;
    const fn = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        const e = Object.assign(new Error('rate limit'), { status: 429 });
        throw e;
      }
      return 'recovered';
    });
    const result = await withRetry(fn, { maxRetries: 3, retryableErrors: new Set(['429']), _sleep: noSleep });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('maxRetries=0 no reintenta', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    await expect(withRetry(fn, { maxRetries: 0, _sleep: noSleep })).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
