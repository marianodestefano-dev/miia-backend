'use strict';

const {
  getOwnerConsent, setOwnerConsent, hasOwnerConsented,
  requestConsent, recordConsent, hasConsent, revokeConsent,
  VALID_MODES, __setFirestoreForTests,
} = require('../core/consent_manager');

function makeMockDb(snapExists, snapData) {
  const mockSet = jest.fn().mockResolvedValue(undefined);
  const ref = {
    get: jest.fn().mockResolvedValue({ exists: snapExists, data: () => JSON.parse(JSON.stringify(snapData || {})) }),
    set: mockSet,
  };
  return {
    ref,
    mockSet,
    db: {
      collection: () => ({
        doc: () => ({ collection: () => ({ doc: () => ref }), get: ref.get }),
      }),
    },
  };
}

beforeEach(() => { __setFirestoreForTests(null); });

// ── getOwnerConsent / setOwnerConsent / hasOwnerConsented ──────────────────
describe('getOwnerConsent', function () {
  test('uid invalido → throw', async function () {
    await expect(getOwnerConsent(null)).rejects.toThrow('uid requerido');
  });
  test('doc no existe → null', async function () {
    const { db } = makeMockDb(false, null);
    __setFirestoreForTests(db);
    expect(await getOwnerConsent('uid1')).toBeNull();
  });
  test('doc existe → retorna datos', async function () {
    const { db } = makeMockDb(true, { mode: 'A' });
    __setFirestoreForTests(db);
    expect((await getOwnerConsent('uid1')).mode).toBe('A');
  });
});

describe('setOwnerConsent', function () {
  test('uid invalido → throw', async function () {
    await expect(setOwnerConsent(null, { mode: 'A' })).rejects.toThrow('uid requerido');
  });
  test('mode invalido → throw', async function () {
    const { db } = makeMockDb(false, null);
    __setFirestoreForTests(db);
    await expect(setOwnerConsent('uid1', { mode: 'X' })).rejects.toThrow('mode invalido');
  });
  test('mode valido A → guarda', async function () {
    const { db } = makeMockDb(false, null);
    __setFirestoreForTests(db);
    const r = await setOwnerConsent('uid1', { mode: 'A', acknowledgment: 'ok' });
    expect(r.success).toBe(true);
  });
  test('acknowledgment no-string → null', async function () {
    const { db } = makeMockDb(false, null);
    __setFirestoreForTests(db);
    const r = await setOwnerConsent('uid1', { mode: 'B' });
    expect(r.acknowledgment).toBeNull();
  });
});

describe('hasOwnerConsented', function () {
  test('uid invalido → false', async function () {
    expect(await hasOwnerConsented(null)).toBe(false);
  });
  test('doc no existe → false', async function () {
    const { db } = makeMockDb(false, null);
    __setFirestoreForTests(db);
    expect(await hasOwnerConsented('uid1')).toBe(false);
  });
  test('doc con mode valido → true', async function () {
    const { db } = makeMockDb(true, { mode: 'C' });
    __setFirestoreForTests(db);
    expect(await hasOwnerConsented('uid1')).toBe(true);
  });
  test('doc con mode invalido → false', async function () {
    const { db } = makeMockDb(true, { mode: 'Z' });
    __setFirestoreForTests(db);
    expect(await hasOwnerConsented('uid1')).toBe(false);
  });
  test('Firestore error → fallback true', async function () {
    const errDb = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ get: async () => { throw new Error('fs down'); } }) }) }) }) };
    __setFirestoreForTests(errDb);
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await hasOwnerConsented('uid1')).toBe(true);
    spy.mockRestore();
  });
});
// ── requestConsent / recordConsent / hasConsent / revokeConsent ──────────────
describe('requestConsent', function () {
  test('parametros faltantes → throw', async function () {
    await expect(requestConsent(null, '+57300', 'pii')).rejects.toThrow('parametros_requeridos');
  });
  test('phone null → throw', async function () {
    await expect(requestConsent('uid1', null, 'pii')).rejects.toThrow('parametros_requeridos');
  });
  test('dataType null → throw', async function () {
    await expect(requestConsent('uid1', '+57300', null)).rejects.toThrow('parametros_requeridos');
  });
  test('valido → token y expiresAt', async function () {
    const { db } = makeMockDb(false, {});
    __setFirestoreForTests(db);
    const r = await requestConsent('uid1', '+57300', 'historial_medico');
    expect(r.token.length).toBe(32);
    expect(r.expiresAt).toBeTruthy();
  });
});

describe('recordConsent', function () {
  test('uid null → throw', async function () {
    await expect(recordConsent(null, '+57300', 'tok', true)).rejects.toThrow('parametros_requeridos');
  });
  test('token null → throw', async function () {
    await expect(recordConsent('uid1', '+57300', null, true)).rejects.toThrow('parametros_requeridos');
  });
  test('token invalido → throw', async function () {
    const { db } = makeMockDb(true, { pending: { token: 'abc', dataType: 'pii', expiresAt: new Date(Date.now() + 60000).toISOString() } });
    __setFirestoreForTests(db);
    await expect(recordConsent('uid1', '+57300', 'WRONG', true)).rejects.toThrow('token_invalido');
  });
  test('pending null (sin datos) → token_invalido', async function () {
    const { db } = makeMockDb(false, {});
    __setFirestoreForTests(db);
    await expect(recordConsent('uid1', '+57300', 'tok', true)).rejects.toThrow('token_invalido');
  });
  test('token expirado → throw', async function () {
    const expired = new Date(Date.now() - 1000).toISOString();
    const { db } = makeMockDb(true, { pending: { token: 'tok123', dataType: 'pii', expiresAt: expired } });
    __setFirestoreForTests(db);
    await expect(recordConsent('uid1', '+57300', 'tok123', true)).rejects.toThrow('token_expirado');
  });
  test('aceptado=true → ok', async function () {
    const future = new Date(Date.now() + 60000).toISOString();
    const { db } = makeMockDb(true, { pending: { token: 'tok123', dataType: 'pii', expiresAt: future } });
    __setFirestoreForTests(db);
    const r = await recordConsent('uid1', '+57300', 'tok123', true);
    expect(r.ok).toBe(true);
  });
  test('aceptado=false → ok (rechazado)', async function () {
    const future = new Date(Date.now() + 60000).toISOString();
    const { db } = makeMockDb(true, { pending: { token: 'tok123', dataType: 'pii', expiresAt: future } });
    __setFirestoreForTests(db);
    const r = await recordConsent('uid1', '+57300', 'tok123', false);
    expect(r.ok).toBe(true);
  });
});

describe('hasConsent', function () {
  test('uid null → false', async function () {
    expect(await hasConsent(null, '+57300', 'pii')).toBe(false);
  });
  test('phone null → false', async function () {
    expect(await hasConsent('uid1', null, 'pii')).toBe(false);
  });
  test('doc no existe → false', async function () {
    const { db } = makeMockDb(false, {});
    __setFirestoreForTests(db);
    expect(await hasConsent('uid1', '+57300', 'pii')).toBe(false);
  });
  test('accepted=false → false', async function () {
    const { db } = makeMockDb(true, { accepted: false, dataType: 'pii' });
    __setFirestoreForTests(db);
    expect(await hasConsent('uid1', '+57300', 'pii')).toBe(false);
  });
  test('dataType mismatch → false', async function () {
    const { db } = makeMockDb(true, { accepted: true, dataType: 'historial' });
    __setFirestoreForTests(db);
    expect(await hasConsent('uid1', '+57300', 'pii')).toBe(false);
  });
  test('accepted y dataType match → true', async function () {
    const { db } = makeMockDb(true, { accepted: true, dataType: 'pii' });
    __setFirestoreForTests(db);
    expect(await hasConsent('uid1', '+57300', 'pii')).toBe(true);
  });
  test('accepted y sin dataType filter → true', async function () {
    const { db } = makeMockDb(true, { accepted: true, dataType: 'pii' });
    __setFirestoreForTests(db);
    expect(await hasConsent('uid1', '+57300', null)).toBe(true);
  });
});

describe('revokeConsent', function () {
  test('uid null → throw', async function () {
    await expect(revokeConsent(null, '+57300')).rejects.toThrow('parametros_requeridos');
  });
  test('phone null → throw', async function () {
    await expect(revokeConsent('uid1', null)).rejects.toThrow('parametros_requeridos');
  });
  test('valido → ok', async function () {
    const { db } = makeMockDb(true, { accepted: true });
    __setFirestoreForTests(db);
    const r = await revokeConsent('uid1', '+57300');
    expect(r.ok).toBe(true);
  });
});
