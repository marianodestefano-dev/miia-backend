'use strict';
const { CircuitBreaker, STATES, DEFAULTS } = require('../core/circuit_breaker');

describe('STATES y DEFAULTS', () => {
  test('estados validos', () => {
    expect(STATES.CLOSED).toBe('closed');
    expect(STATES.OPEN).toBe('open');
    expect(STATES.HALF_OPEN).toBe('half_open');
  });
  test('defaults correctos', () => {
    expect(DEFAULTS.failureThreshold).toBe(5);
    expect(DEFAULTS.successThreshold).toBe(2);
    expect(DEFAULTS.openTimeoutMs).toBe(30000);
  });
});

describe('CircuitBreaker — estado inicial', () => {
  test('inicia en CLOSED', () => {
    const cb = new CircuitBreaker({ name: 'test' });
    expect(cb.state).toBe(STATES.CLOSED);
    expect(cb.failureCount).toBe(0);
  });
  test('fn no funcion lanza', async () => {
    const cb = new CircuitBreaker();
    await expect(cb.execute(null)).rejects.toThrow('fn requerido');
  });
});

describe('CircuitBreaker — transicion CLOSED -> OPEN', () => {
  test('abre despues de failureThreshold fallos', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, name: 'test' });
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    for (let i = 0; i < 3; i++) {
      try { await cb.execute(fn); } catch {}
    }
    expect(cb.state).toBe(STATES.OPEN);
  });
  test('no abre antes del threshold', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    for (let i = 0; i < 2; i++) {
      try { await cb.execute(fn); } catch {}
    }
    expect(cb.state).toBe(STATES.CLOSED);
  });
});

describe('CircuitBreaker — estado OPEN', () => {
  test('lanza CIRCUIT_OPEN sin llamar fn', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    try { await cb.execute(() => { throw new Error('fail'); }); } catch {}
    const fn = jest.fn();
    await expect(cb.execute(fn)).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('CircuitBreaker — transicion OPEN -> HALF_OPEN -> CLOSED', () => {
  test('pasa a HALF_OPEN despues del timeout', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, openTimeoutMs: 100 });
    try { await cb.execute(() => { throw new Error('fail'); }); } catch {}
    expect(cb.state).toBe(STATES.OPEN);
    const futureMs = Date.now() + 200;
    const fn = jest.fn().mockResolvedValue('ok');
    try { await cb.execute(fn, futureMs); } catch {}
    expect(cb.state).toBe(STATES.HALF_OPEN);
  });
  test('cierra despues de successThreshold exitos en HALF_OPEN', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, openTimeoutMs: 0, successThreshold: 2 });
    try { await cb.execute(() => { throw new Error('fail'); }); } catch {}
    const fn = jest.fn().mockResolvedValue('ok');
    await cb.execute(fn, Date.now() + 1); // -> HALF_OPEN
    await cb.execute(fn, Date.now() + 1); // exito 1
    await cb.execute(fn); // exito 2 -> CLOSED
    expect(cb.state).toBe(STATES.CLOSED);
  });
  test('HALF_OPEN -> OPEN si falla', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, openTimeoutMs: 0 });
    try { await cb.execute(() => { throw new Error('fail'); }); } catch {}
    const futureMs = Date.now() + 1;
    try { await cb.execute(() => { throw new Error('fail again'); }, futureMs); } catch {}
    expect(cb.state).toBe(STATES.OPEN);
  });
});

describe('reset y getStats', () => {
  test('reset vuelve a CLOSED', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    try { await cb.execute(() => { throw new Error('fail'); }); } catch {}
    cb.reset();
    expect(cb.state).toBe(STATES.CLOSED);
    expect(cb.failureCount).toBe(0);
  });
  test('getStats retorna estado completo', () => {
    const cb = new CircuitBreaker({ name: 'myService' });
    const stats = cb.getStats();
    expect(stats.name).toBe('myService');
    expect(stats.state).toBe(STATES.CLOSED);
    expect(stats.failureCount).toBe(0);
  });
  test('exito en CLOSED resetea failureCount', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    try { await cb.execute(() => { throw new Error('fail'); }); } catch {}
    expect(cb.failureCount).toBe(1);
    await cb.execute(() => Promise.resolve('ok'));
    expect(cb.failureCount).toBe(0);
  });
});
