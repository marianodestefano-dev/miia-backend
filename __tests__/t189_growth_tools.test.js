'use strict';

const {
  generateReferralCode, applyReferralCode,
  addLoyaltyPoints, getLoyaltyPoints, getInactiveContacts,
  GROWTH_CAMPAIGN_TYPES, DEFAULT_REFERRAL_REWARD,
  MAX_LOYALTY_POINTS, REACTIVATION_DAYS_THRESHOLD,
  __setFirestoreForTests,
} = require('../core/growth_tools');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const NOW = new Date('2026-05-04T15:00:00.000Z').getTime();

function makeMockDb({ codeData = null, pointsData = null, throwSet = false } = {}) {
  const store = {};

  const refDoc = (id) => ({
    get: async () => {
      if (codeData && codeData.code === id) return { exists: true, data: () => codeData };
      return { exists: !!store[id], data: () => store[id] || null };
    },
    set: async (data, opts) => {
      if (throwSet) throw new Error('set error');
      store[id] = Object.assign(store[id] || {}, data);
    },
  });

  const codesColl = { doc: (id) => refDoc(id) };
  const uidRefDoc = { collection: () => codesColl };

  const pDoc = (id) => ({
    get: async () => {
      if (pointsData && pointsData._id === id) return { exists: true, data: () => pointsData };
      return { exists: !!store[id], data: () => store[id] || null };
    },
    set: async (data, opts) => {
      if (throwSet) throw new Error('set error');
      store[id] = Object.assign(store[id] || {}, data);
    },
  });

  return {
    collection: (name) => {
      if (name === 'referral_codes') return { doc: () => uidRefDoc };
      if (name === 'loyalty_points') return { doc: (id) => pDoc(id) };
      return { doc: () => ({ set: async () => {}, get: async () => ({ exists: false }) }) };
    },
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('constants', () => {
  test('GROWTH_CAMPAIGN_TYPES incluye referral loyalty reactivation', () => {
    expect(GROWTH_CAMPAIGN_TYPES).toContain('referral');
    expect(GROWTH_CAMPAIGN_TYPES).toContain('loyalty');
    expect(GROWTH_CAMPAIGN_TYPES).toContain('reactivation');
  });
  test('es frozen', () => { expect(() => { GROWTH_CAMPAIGN_TYPES.push('x'); }).toThrow(); });
  test('DEFAULT_REFERRAL_REWARD es 10', () => { expect(DEFAULT_REFERRAL_REWARD).toBe(10); });
  test('MAX_LOYALTY_POINTS es 10000', () => { expect(MAX_LOYALTY_POINTS).toBe(10000); });
  test('REACTIVATION_DAYS_THRESHOLD es 30', () => { expect(REACTIVATION_DAYS_THRESHOLD).toBe(30); });
});

describe('generateReferralCode', () => {
  test('lanza si uid undefined', async () => {
    await expect(generateReferralCode(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(generateReferralCode(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('genera codigo de 8 chars y url', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await generateReferralCode(UID, PHONE);
    expect(r.code).toBeDefined();
    expect(r.code.length).toBe(8);
    expect(r.referralUrl).toContain(r.code);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(generateReferralCode(UID, PHONE)).rejects.toThrow('set error');
  });
});


describe('applyReferralCode', () => {
  test('lanza si ownerUid undefined', async () => {
    await expect(applyReferralCode(undefined, 'ABC123', PHONE)).rejects.toThrow('ownerUid requerido');
  });
  test('lanza si code undefined', async () => {
    await expect(applyReferralCode(UID, undefined, PHONE)).rejects.toThrow('code requerido');
  });
  test('lanza si newLeadPhone undefined', async () => {
    await expect(applyReferralCode(UID, 'ABC123', undefined)).rejects.toThrow('newLeadPhone requerido');
  });
  test('retorna applied=false si codigo no encontrado', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await applyReferralCode(UID, 'INEXISTENTE', PHONE);
    expect(r.applied).toBe(false);
  });
  test('retorna applied=true con codigo valido activo', async () => {
    const codeData = { code: 'ABC12345', phone: PHONE, active: true, rewardPoints: 10, usedCount: 0 };
    __setFirestoreForTests(makeMockDb({ codeData }));
    const r = await applyReferralCode(UID, 'ABC12345', '+54911XXXXXX');
    expect(r.applied).toBe(true);
    expect(r.reward).toBe(10);
  });
  test('retorna applied=false si codigo inactivo', async () => {
    const codeData = { code: 'ABC12345', phone: PHONE, active: false, rewardPoints: 10, usedCount: 0 };
    __setFirestoreForTests(makeMockDb({ codeData }));
    const r = await applyReferralCode(UID, 'ABC12345', '+54911XXXXXX');
    expect(r.applied).toBe(false);
  });
});

describe('addLoyaltyPoints y getLoyaltyPoints', () => {
  test('lanza si uid undefined', async () => {
    await expect(addLoyaltyPoints(undefined, PHONE, 5)).rejects.toThrow('uid requerido');
  });
  test('lanza si points no positivo', async () => {
    await expect(addLoyaltyPoints(UID, PHONE, 0)).rejects.toThrow('positivo');
    await expect(addLoyaltyPoints(UID, PHONE, -1)).rejects.toThrow('positivo');
  });
  test('agrega puntos sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await addLoyaltyPoints(UID, PHONE, 5);
    expect(r.added).toBe(5);
    expect(r.newTotal).toBeGreaterThan(0);
  });
  test('cappea en MAX_LOYALTY_POINTS', async () => {
    const pointsId = UID.substring(0, 8) + '_' + PHONE.replace('+', '');
    const pointsData = { _id: pointsId, points: 9999 };
    __setFirestoreForTests(makeMockDb({ pointsData }));
    const r = await addLoyaltyPoints(UID, PHONE, 100);
    expect(r.newTotal).toBe(MAX_LOYALTY_POINTS);
  });
  test('lanza si uid undefined en get', async () => {
    await expect(getLoyaltyPoints(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('retorna 0 si sin puntos', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getLoyaltyPoints(UID, PHONE)).toBe(0);
  });
  test('fail-open retorna 0 si Firestore falla', async () => {
    __setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => { throw new Error('err'); } }) }) });
    expect(await getLoyaltyPoints(UID, PHONE)).toBe(0);
  });
  test('propaga error Firestore en add', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(addLoyaltyPoints(UID, PHONE, 5)).rejects.toThrow('set error');
  });
});

describe('getInactiveContacts', () => {
  test('lanza si contacts no es array', () => {
    expect(() => getInactiveContacts('no array')).toThrow('debe ser array');
  });
  test('retorna contactos inactivos', () => {
    const contacts = [
      { phone: '+1', lastContactAt: new Date(NOW - 35 * 24 * 60 * 60 * 1000).toISOString() },
      { phone: '+2', lastContactAt: new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString() },
      { phone: '+3', lastContactAt: new Date(NOW - 31 * 24 * 60 * 60 * 1000).toISOString() },
    ];
    const inactive = getInactiveContacts(contacts, 30, NOW);
    expect(inactive.length).toBe(2);
    expect(inactive.map(c => c.phone)).toContain('+1');
    expect(inactive.map(c => c.phone)).toContain('+3');
  });
  test('retorna vacio si todos activos', () => {
    const contacts = [{ phone: '+1', lastContactAt: new Date(NOW - 1000).toISOString() }];
    expect(getInactiveContacts(contacts, 30, NOW)).toEqual([]);
  });
  test('ignora contactos sin lastContactAt', () => {
    const contacts = [{ phone: '+1' }, { phone: '+2', lastContactAt: new Date(NOW - 40 * 24 * 60 * 60 * 1000).toISOString() }];
    expect(getInactiveContacts(contacts, 30, NOW).length).toBe(1);
  });
  test('usa REACTIVATION_DAYS_THRESHOLD por default', () => {
    const contacts = [{ phone: '+1', lastContactAt: new Date(NOW - 31 * 24 * 60 * 60 * 1000).toISOString() }];
    expect(getInactiveContacts(contacts, undefined, NOW).length).toBe(1);
  });
});
