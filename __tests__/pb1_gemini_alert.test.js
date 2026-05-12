'use strict';

/**
 * PB.1 — Tests alerta fallos consecutivos Gemini por uid
 * Cubre: 2 fallos (sin alerta), 3 fallos (con alerta), éxito (reset), sin uid (sin alerta), uids aislados
 */

const { callGemini, __setFetchForTests, __setAlertFn } = require('../ai/gemini_client');

let alertFn;

beforeEach(() => {
  alertFn = jest.fn();
  __setAlertFn(alertFn);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  __setFetchForTests(null);
  __setAlertFn(null);
  jest.restoreAllMocks();
});

function failFetch(status = 500) {
  return jest.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve('server error'),
  });
}

function successFetch(text = 'respuesta ok') {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      candidates: [{ content: { parts: [{ text }] } }],
    }),
  });
}

describe('PB.1 — Alerta Gemini fallos consecutivos', () => {
  test('2 fallos consecutivos → sin alerta', async () => {
    const uid = 'pb1-A-' + Date.now();
    __setFetchForTests(failFetch());
    await expect(callGemini('key', 'p', { uid, retries: 0 })).rejects.toThrow();
    await expect(callGemini('key', 'p', { uid, retries: 0 })).rejects.toThrow();
    expect(alertFn).not.toHaveBeenCalled();
  });

  test('3 fallos consecutivos → dispara alerta con uid correcto', async () => {
    const uid = 'pb1-B-' + Date.now();
    __setFetchForTests(failFetch());
    await expect(callGemini('key', 'p', { uid, retries: 0 })).rejects.toThrow();
    await expect(callGemini('key', 'p', { uid, retries: 0 })).rejects.toThrow();
    await expect(callGemini('key', 'p', { uid, retries: 0 })).rejects.toThrow();
    expect(alertFn).toHaveBeenCalledTimes(1);
    expect(alertFn).toHaveBeenCalledWith(uid, expect.stringContaining('PB1-ALERTA'));
    expect(alertFn).toHaveBeenCalledWith(uid, expect.stringContaining('3'));
  });

  test('4 fallos consecutivos → alerta en 3ro y 4to (count acumula)', async () => {
    const uid = 'pb1-C-' + Date.now();
    __setFetchForTests(failFetch());
    for (let i = 0; i < 4; i++) {
      await expect(callGemini('key', 'p', { uid, retries: 0 })).rejects.toThrow();
    }
    expect(alertFn).toHaveBeenCalledTimes(2);
  });

  test('exito despues de 2 fallos → resetea contador', async () => {
    const uid = 'pb1-D-' + Date.now();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('err') })
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('err') })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
      })
      .mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('err') });

    __setFetchForTests(mockFetch);
    await expect(callGemini('key', 'p', { uid, retries: 0 })).rejects.toThrow();
    await expect(callGemini('key', 'p', { uid, retries: 0 })).rejects.toThrow();
    await expect(callGemini('key', 'p', { uid, retries: 0 })).resolves.toBe('ok'); // reset
    await expect(callGemini('key', 'p', { uid, retries: 0 })).rejects.toThrow(); // 1 post-reset
    await expect(callGemini('key', 'p', { uid, retries: 0 })).rejects.toThrow(); // 2 post-reset
    expect(alertFn).not.toHaveBeenCalled(); // solo 2 fallos post-reset, no llega a 3
  });

  test('sin uid → no dispara alerta aunque haya 3+ fallos', async () => {
    __setFetchForTests(failFetch());
    for (let i = 0; i < 4; i++) {
      await expect(callGemini('key', 'p', { retries: 0 })).rejects.toThrow();
    }
    expect(alertFn).not.toHaveBeenCalled();
  });

  test('uids distintos → contadores independientes sin interferencia', async () => {
    const uid1 = 'pb1-E1-' + Date.now();
    const uid2 = 'pb1-E2-' + Date.now();
    __setFetchForTests(failFetch());
    await expect(callGemini('key', 'p', { uid: uid1, retries: 0 })).rejects.toThrow();
    await expect(callGemini('key', 'p', { uid: uid2, retries: 0 })).rejects.toThrow();
    await expect(callGemini('key', 'p', { uid: uid1, retries: 0 })).rejects.toThrow();
    await expect(callGemini('key', 'p', { uid: uid2, retries: 0 })).rejects.toThrow();
    // uid1: 2 fallos, uid2: 2 fallos → ninguno llega a 3
    expect(alertFn).not.toHaveBeenCalled();
  });

  test('sin _sendOwnerAlert configurado: no lanza aunque haya 3+ fallos', async () => {
    __setAlertFn(null); // desconfigurar
    const uid = 'pb1-F-' + Date.now();
    __setFetchForTests(failFetch());
    for (let i = 0; i < 3; i++) {
      await expect(callGemini('key', 'p', { uid, retries: 0 })).rejects.toThrow();
    }
    // no error thrown even without alert fn
  });
});
