"use strict";

// Carga growth_tools UNA sola vez (no resetModules)
jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
const gt = require('../core/growth_tools');

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

function makeDoc({ exists = false, data = null, set = false } = {}) {
  return {
    get: jest.fn().mockResolvedValue({ exists, data: () => data }),
    set: set ? jest.fn().mockResolvedValue({}) : jest.fn().mockResolvedValue({}),
  };
}

function makeDb({ getExists = false, getData = null, setThrows = false } = {}) {
  const docFn = () => {
    const d = makeDoc({ exists: getExists, data: getData });
    if (setThrows) d.set = jest.fn().mockRejectedValue(new Error('set fail'));
    return {
      get: d.get,
      set: d.set,
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ get: d.get, set: d.set }),
      }),
    };
  };
  return {
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue(docFn()),
    }),
  };
}

// ===== Guards generateReferralCode =====
describe('P5 extra3 -- growth_tools guard branches', () => {
  test('generateReferralCode: uid null -> throw', async () => {
    await expect(gt.generateReferralCode(null, '+1')).rejects.toThrow('uid requerido');
  });
  test('generateReferralCode: phone null -> throw', async () => {
    await expect(gt.generateReferralCode('uid1', null)).rejects.toThrow('phone requerido');
  });

  // ===== Guards applyReferralCode =====
  test('applyReferralCode: ownerUid null -> throw', async () => {
    await expect(gt.applyReferralCode(null, 'CODE', '+1')).rejects.toThrow('ownerUid requerido');
  });
  test('applyReferralCode: code null -> throw', async () => {
    await expect(gt.applyReferralCode('uid', null, '+1')).rejects.toThrow('code requerido');
  });
  test('applyReferralCode: newLeadPhone null -> throw', async () => {
    await expect(gt.applyReferralCode('uid', 'CODE', null)).rejects.toThrow('newLeadPhone requerido');
  });

  // ===== Guards addLoyaltyPoints =====
  test('addLoyaltyPoints: uid null -> throw', async () => {
    await expect(gt.addLoyaltyPoints(null, '+1', 5)).rejects.toThrow('uid requerido');
  });
  test('addLoyaltyPoints: phone null -> throw', async () => {
    await expect(gt.addLoyaltyPoints('uid', null, 5)).rejects.toThrow('phone requerido');
  });
  test('addLoyaltyPoints: points no numerico -> throw', async () => {
    await expect(gt.addLoyaltyPoints('uid', '+1', 'abc')).rejects.toThrow('points debe ser numero positivo');
  });
  test('addLoyaltyPoints: points cero -> throw', async () => {
    await expect(gt.addLoyaltyPoints('uid', '+1', 0)).rejects.toThrow('points debe ser numero positivo');
  });

  // ===== Guards getLoyaltyPoints =====
  test('getLoyaltyPoints: uid null -> throw', async () => {
    await expect(gt.getLoyaltyPoints(null, '+1')).rejects.toThrow('uid requerido');
  });
  test('getLoyaltyPoints: phone null -> throw', async () => {
    await expect(gt.getLoyaltyPoints('uid', null)).rejects.toThrow('phone requerido');
  });

  // ===== Guards getInactiveContacts =====
  test('getInactiveContacts: no array -> throw', () => {
    expect(() => gt.getInactiveContacts('not-array')).toThrow('contacts debe ser array');
  });

  // ===== Binary || fallback con points=0 =====
  test('addLoyaltyPoints: snap.data().points=0 -> current=0 (|| branch)', async () => {
    gt.__setFirestoreForTests(makeDb({ getExists: true, getData: { points: 0 } }));
    const r = await gt.addLoyaltyPoints('uid1', '+1234', 10);
    expect(r.newTotal).toBe(10);
  });

  test('getLoyaltyPoints: snap.data().points=0 -> retorna 0 (|| branch)', async () => {
    gt.__setFirestoreForTests(makeDb({ getExists: true, getData: { points: 0 } }));
    const r = await gt.getLoyaltyPoints('uid1', '+1234');
    expect(r).toBe(0);
  });
});
