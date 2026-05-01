'use strict';

const {
  generateCode, isCodeExpired, isCodeValid,
  createReferralCode, validateAndUseCode, getReferralStats,
  REWARD_TYPES, CODE_STATUSES, CODE_LENGTH, CODE_EXPIRY_DAYS, MAX_USES_PER_CODE,
  __setFirestoreForTests,
} = require('../core/viral_referral_engine');

const UID = 'testUid1234567890';

function makeMockDb({ existingDoc = null, throwGet = false, throwSet = false, queryDocs = [] } = {}) {
  const querySnap = { forEach: fn => queryDocs.forEach((d, i) => fn({ id: 'code' + i, data: () => d })) };
  return {
    collection: (name) => ({
      doc: () => ({
        get: async () => {
          if (throwGet) throw new Error('get error');
          if (!existingDoc) return { exists: false, data: () => ({}) };
          return { exists: true, data: () => existingDoc };
        },
        set: async () => { if (throwSet) throw new Error('set error'); },
      }),
      where: () => ({
        get: async () => {
          if (throwGet) throw new Error('get error');
          return querySnap;
        },
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('consts / REWARD_TYPES / CODE_STATUSES', () => {
  test('REWARD_TYPES tiene tipos comunes', () => {
    expect(REWARD_TYPES).toContain('discount');
    expect(REWARD_TYPES).toContain('free_month');
  });
  test('REWARD_TYPES es frozen', () => {
    expect(() => { REWARD_TYPES.push('oro'); }).toThrow();
  });
  test('CODE_LENGTH es 8', () => {
    expect(CODE_LENGTH).toBe(8);
  });
  test('MAX_USES_PER_CODE es 100', () => {
    expect(MAX_USES_PER_CODE).toBe(100);
  });
});

describe('generateCode', () => {
  test('lanza si uid undefined', () => {
    expect(() => generateCode(undefined)).toThrow('uid requerido');
  });
  test('genera codigo de longitud correcta', () => {
    const code = generateCode(UID);
    expect(code.length).toBe(CODE_LENGTH);
  });
  test('codigo contiene solo mayusculas y numeros', () => {
    const code = generateCode(UID);
    expect(/^[A-Z0-9]+$/.test(code)).toBe(true);
  });
});

describe('isCodeExpired', () => {
  test('false si expiresAt es null', () => {
    expect(isCodeExpired(null)).toBe(false);
  });
  test('false si fecha futura', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    expect(isCodeExpired(future)).toBe(false);
  });
  test('true si fecha pasada', () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(isCodeExpired(past)).toBe(true);
  });
});

describe('isCodeValid', () => {
  test('true para codigo valido', () => {
    expect(isCodeValid('ABCD1234')).toBe(true);
  });
  test('false para codigo con minusculas', () => {
    expect(isCodeValid('abcd1234')).toBe(false);
  });
  test('false para codigo muy corto', () => {
    expect(isCodeValid('ABC')).toBe(false);
  });
  test('false para undefined', () => {
    expect(isCodeValid(undefined)).toBe(false);
  });
});

describe('createReferralCode', () => {
  test('lanza si uid undefined', async () => {
    await expect(createReferralCode(undefined)).rejects.toThrow('uid requerido');
  });
  test('lanza si rewardType invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(createReferralCode(UID, { rewardType: 'oro' })).rejects.toThrow('rewardType invalido');
  });
  test('crea codigo sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await createReferralCode(UID);
    expect(r.code).toBeDefined();
    expect(r.expiresAt).toBeDefined();
  });
  test('acepta customCode valido', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await createReferralCode(UID, { customCode: 'TEST1234' });
    expect(r.code).toBe('TEST1234');
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(createReferralCode(UID)).rejects.toThrow('set error');
  });
});

describe('validateAndUseCode', () => {
  test('lanza si code undefined', async () => {
    await expect(validateAndUseCode(undefined, '+1')).rejects.toThrow('code requerido');
  });
  test('lanza si newUserPhone undefined', async () => {
    await expect(validateAndUseCode('ABCD1234', undefined)).rejects.toThrow('newUserPhone requerido');
  });
  test('retorna invalid si codigo no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await validateAndUseCode('ABCD1234', '+541155667788');
    expect(r.valid).toBe(false);
  });
  test('retorna invalid si codigo expirado', async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    __setFirestoreForTests(makeMockDb({ existingDoc: { status: 'active', expiresAt: pastDate, usesCount: 0, maxUses: 100, uid: UID } }));
    const r = await validateAndUseCode('ABCD1234', '+541155667788');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('expirado');
  });
  test('valida y usa codigo activo', async () => {
    const futureDate = new Date(Date.now() + 86400000 * 30).toISOString();
    __setFirestoreForTests(makeMockDb({ existingDoc: { status: 'active', expiresAt: futureDate, usesCount: 0, maxUses: 100, uid: UID, rewardType: 'discount' } }));
    const r = await validateAndUseCode('ABCD1234', '+541155667788');
    expect(r.valid).toBe(true);
    expect(r.uid).toBe(UID);
  });
});

describe('getReferralStats', () => {
  test('lanza si uid undefined', async () => {
    await expect(getReferralStats(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna stats con 0 si no hay codigos', async () => {
    __setFirestoreForTests(makeMockDb({ queryDocs: [] }));
    const r = await getReferralStats(UID);
    expect(r.codesCount).toBe(0);
    expect(r.totalUses).toBe(0);
  });
  test('suma usos de multiples codigos', async () => {
    __setFirestoreForTests(makeMockDb({ queryDocs: [{ usesCount: 10 }, { usesCount: 25 }] }));
    const r = await getReferralStats(UID);
    expect(r.codesCount).toBe(2);
    expect(r.totalUses).toBe(35);
  });
  test('fail-open retorna vacios si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getReferralStats(UID);
    expect(r.totalUses).toBe(0);
  });
});
