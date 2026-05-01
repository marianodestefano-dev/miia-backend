'use strict';

/**
 * T93 — Key rotation scheduler tests.
 * Cubre checkAndRotateKeys: dispara a 30d, salta a 15d, log en falla.
 */

const {
  checkAndRotateKeys,
  ROTATION_INTERVAL_DAYS,
  __setFirestoreForTests,
} = require('../core/key_rotation_scheduler');

const UID = 'uid_t93_keyrot_test_abc';

const DAYS_MS = 24 * 60 * 60 * 1000;

function makeMockDb({ lastRotation = null, throwRead = false, throwWrite = false } = {}) {
  const data = lastRotation !== null ? { lastKeyRotation: lastRotation, keyRotationCount: 0 } : {};
  const docExists = lastRotation !== null;

  const setFn = throwWrite
    ? jest.fn().mockRejectedValue(new Error('write fail'))
    : jest.fn().mockResolvedValue();

  const getFn = throwRead
    ? jest.fn().mockRejectedValue(new Error('read fail'))
    : jest.fn().mockResolvedValue({ exists: docExists, data: () => data });

  return {
    collection: () => ({
      doc: () => ({ get: getFn, set: setFn }),
    }),
    _setFn: setFn,
    _getFn: getFn,
  };
}

afterEach(() => __setFirestoreForTests(null));

describe('checkAndRotateKeys — validacion', () => {
  test('lanza error si uid es undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(checkAndRotateKeys(undefined)).rejects.toThrow('uid requerido');
  });

  test('lanza error si uid es string vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(checkAndRotateKeys('')).rejects.toThrow('uid requerido');
  });
});

describe('checkAndRotateKeys — logica de rotacion', () => {
  test('NO rota si ultima rotacion fue hace 15 dias', async () => {
    const lastRot = new Date(Date.now() - 15 * DAYS_MS).toISOString();
    const db = makeMockDb({ lastRotation: lastRot });
    __setFirestoreForTests(db);
    const result = await checkAndRotateKeys(UID);
    expect(result.rotated).toBe(false);
    expect(result.reason).toMatch(/not_due/);
    expect(db._setFn).not.toHaveBeenCalled();
  });

  test('NO rota si ultima rotacion fue hace 29 dias', async () => {
    const lastRot = new Date(Date.now() - 29 * DAYS_MS).toISOString();
    const db = makeMockDb({ lastRotation: lastRot });
    __setFirestoreForTests(db);
    const result = await checkAndRotateKeys(UID);
    expect(result.rotated).toBe(false);
  });

  test('SI rota si ultima rotacion fue hace 31 dias', async () => {
    const lastRot = new Date(Date.now() - 31 * DAYS_MS).toISOString();
    const db = makeMockDb({ lastRotation: lastRot });
    __setFirestoreForTests(db);
    const result = await checkAndRotateKeys(UID);
    expect(result.rotated).toBe(true);
    expect(result.reason).toBe('rotation_completed');
    expect(result.newRotationDate).toBeTruthy();
    expect(db._setFn).toHaveBeenCalledTimes(1);
  });

  test('SI rota si no hay lastKeyRotation (primera vez)', async () => {
    const db = makeMockDb({ lastRotation: null });
    __setFirestoreForTests(db);
    const result = await checkAndRotateKeys(UID);
    expect(result.rotated).toBe(true);
    expect(db._setFn).toHaveBeenCalledTimes(1);
  });

  test('ROTATION_INTERVAL_DAYS es exactamente 30', () => {
    expect(ROTATION_INTERVAL_DAYS).toBe(30);
  });
});

describe('checkAndRotateKeys — resiliencia a errores', () => {
  test('retorna error (no lanza) si Firestore read falla', async () => {
    const db = makeMockDb({ throwRead: true });
    __setFirestoreForTests(db);
    const result = await checkAndRotateKeys(UID);
    expect(result.rotated).toBe(false);
    expect(result.reason).toMatch(/read_error/);
  });

  test('retorna error (no lanza) si Firestore write falla en rotacion', async () => {
    const lastRot = new Date(Date.now() - 35 * DAYS_MS).toISOString();
    const db = makeMockDb({ lastRotation: lastRot, throwWrite: true });
    __setFirestoreForTests(db);
    const result = await checkAndRotateKeys(UID);
    expect(result.rotated).toBe(false);
    expect(result.reason).toMatch(/rotation_error/);
  });
});
