'use strict';

/**
 * T92 — Consent management finalization: edge cases no cubiertos por C-431.
 * Tests para core/consent_manager.js: getOwnerConsent, setOwnerConsent, hasOwnerConsented.
 */

const {
  getOwnerConsent,
  setOwnerConsent,
  hasOwnerConsented,
  VALID_MODES,
  __setFirestoreForTests,
} = require('../core/consent_manager');

const UID = 'uid_t92_consent_test_abc123';

function makeMockDb({ docData = null, throwGet = false, throwSet = false } = {}) {
  const setFn = throwSet
    ? jest.fn().mockRejectedValue(new Error('Firestore write error'))
    : jest.fn().mockResolvedValue();
  const getFn = throwGet
    ? jest.fn().mockRejectedValue(new Error('Firestore read error'))
    : jest.fn().mockResolvedValue(
        docData ? { exists: true, data: () => docData } : { exists: false }
      );
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({ get: getFn, set: setFn }),
        }),
      }),
    }),
    _setFn: setFn,
    _getFn: getFn,
  };
}

afterEach(() => __setFirestoreForTests(null));

// ── 1. getOwnerConsent ──────────────────────────────────────────────────

describe('getOwnerConsent', () => {
  test('lanza error si uid es undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getOwnerConsent(undefined)).rejects.toThrow('uid requerido');
  });

  test('retorna null si no hay doc en Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ docData: null }));
    const result = await getOwnerConsent(UID);
    expect(result).toBeNull();
  });

  test('retorna datos cuando el doc existe', async () => {
    const docData = { mode: 'B', updatedAt: '2026-05-01T00:00:00Z', updatedBy: UID };
    __setFirestoreForTests(makeMockDb({ docData }));
    const result = await getOwnerConsent(UID);
    expect(result).toEqual(docData);
  });
});

// ── 2. setOwnerConsent ─────────────────────────────────────────────────

describe('setOwnerConsent', () => {
  test('acepta modo A y llama Firestore set', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const result = await setOwnerConsent(UID, { mode: 'A' });
    expect(result.success).toBe(true);
    expect(result.mode).toBe('A');
    expect(db._setFn).toHaveBeenCalledTimes(1);
  });

  test('acepta los 3 modos validos A, B, C', async () => {
    for (const mode of VALID_MODES) {
      const db = makeMockDb();
      __setFirestoreForTests(db);
      const result = await setOwnerConsent(UID, { mode });
      expect(result.mode).toBe(mode);
    }
  });

  test('lanza error si mode es invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(setOwnerConsent(UID, { mode: 'Z' })).rejects.toThrow('mode invalido');
  });

  test('lanza error si uid es vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(setOwnerConsent('', { mode: 'A' })).rejects.toThrow('uid requerido');
  });

  test('acknowledgment se incluye si es string', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const result = await setOwnerConsent(UID, { mode: 'B', acknowledgment: 'Acepto los terminos' });
    expect(result.acknowledgment).toBe('Acepto los terminos');
  });

  test('acknowledgment null se guarda como null si no es string', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const result = await setOwnerConsent(UID, { mode: 'C', acknowledgment: 12345 });
    expect(result.acknowledgment).toBeNull();
  });
});

// ── 3. hasOwnerConsented ───────────────────────────────────────────────

describe('hasOwnerConsented', () => {
  test('retorna false si no hay doc', async () => {
    __setFirestoreForTests(makeMockDb({ docData: null }));
    expect(await hasOwnerConsented(UID)).toBe(false);
  });

  test('retorna true si modo es A/B/C', async () => {
    for (const mode of VALID_MODES) {
      __setFirestoreForTests(makeMockDb({ docData: { mode } }));
      expect(await hasOwnerConsented(UID)).toBe(true);
    }
  });

  test('retorna false si modo es invalido aunque doc exista', async () => {
    __setFirestoreForTests(makeMockDb({ docData: { mode: 'X' } }));
    expect(await hasOwnerConsented(UID)).toBe(false);
  });

  test('fallback true si Firestore falla (fail-open: no bloquear MIIA)', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await hasOwnerConsented(UID)).toBe(true);
  });

  test('retorna false si uid es string vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await hasOwnerConsented('')).toBe(false);
  });
});
