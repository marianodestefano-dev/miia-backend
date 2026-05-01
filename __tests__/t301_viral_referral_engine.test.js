'use strict';

/**
 * T301 -- viral_referral_engine unit tests (30/30)
 */

const {
  generateCode,
  isCodeExpired,
  isCodeValid,
  createReferralCode,
  validateAndUseCode,
  getReferralStats,
  REWARD_TYPES,
  CODE_STATUSES,
  CODE_LENGTH,
  CODE_EXPIRY_DAYS,
  MAX_USES_PER_CODE,
  __setFirestoreForTests,
} = require('../core/viral_referral_engine');

function makeMockDb() {
  const store = { referral_codes: {} };
  return {
    store,
    db: {
      collection: (colName) => ({
        doc: (id) => ({
          set: async (data, opts) => {
            if (opts && opts.merge) {
              store[colName][id] = { ...(store[colName][id] || {}), ...data };
            } else {
              store[colName][id] = { ...data };
            }
          },
          get: async () => {
            const rec = store[colName] && store[colName][id];
            return { exists: !!rec, data: () => rec };
          },
        }),
        where: (field, op, val) => ({
          get: async () => {
            const all = Object.values(store[colName] || {});
            const filtered = all.filter(r => {
              if (op === '==') return r[field] === val;
              return true;
            });
            return {
              empty: filtered.length === 0,
              forEach: (fn) => filtered.forEach(d => fn({ data: () => d })),
            };
          },
        }),
      }),
    },
  };
}

const UID = 'owner_t301_001';

describe('T301 -- viral_referral_engine (30 tests)', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    __setFirestoreForTests(mock.db);
  });

  // isCodeValid

  test('isCodeValid: codigo alfanumerico 8 chars es valido', () => {
    expect(isCodeValid('ABCD1234')).toBe(true);
    expect(isCodeValid('OWNER001')).toBe(true);
    expect(isCodeValid('123456')).toBe(true);
  });

  test('isCodeValid: null, undefined y string vacio retornan false', () => {
    expect(isCodeValid(null)).toBe(false);
    expect(isCodeValid(undefined)).toBe(false);
    expect(isCodeValid('')).toBe(false);
  });

  test('isCodeValid: codigo muy corto (<6 chars) retorna false', () => {
    expect(isCodeValid('AB12')).toBe(false);
    expect(isCodeValid('ABCDE')).toBe(false);
  });

  test('isCodeValid: codigo con minusculas retorna false (requiere A-Z0-9)', () => {
    expect(isCodeValid('abcd1234')).toBe(false);
    expect(isCodeValid('Abcd1234')).toBe(false);
  });

  test('isCodeValid: codigo con caracteres especiales retorna false', () => {
    expect(isCodeValid('ABC-1234')).toBe(false);
    expect(isCodeValid('ABC_1234')).toBe(false);
  });

  // isCodeExpired

  test('isCodeExpired: null retorna false (sin expiry = no expira)', () => {
    expect(isCodeExpired(null)).toBe(false);
    expect(isCodeExpired(undefined)).toBe(false);
  });

  test('isCodeExpired: fecha pasada retorna true', () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(isCodeExpired(pastDate)).toBe(true);
  });

  test('isCodeExpired: fecha futura retorna false', () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    expect(isCodeExpired(futureDate)).toBe(false);
  });

  // generateCode

  test('generateCode: genera codigo de 8 caracteres uppercase', () => {
    const code = generateCode(UID);
    expect(typeof code).toBe('string');
    expect(code.length).toBe(CODE_LENGTH);
    expect(code).toBe(code.toUpperCase());
    expect(/^[A-Z0-9]+$/.test(code)).toBe(true);
  });

  test('generateCode: lanza error si uid falta', () => {
    expect(() => generateCode('')).toThrow('uid requerido');
    expect(() => generateCode(null)).toThrow('uid requerido');
  });

  // createReferralCode

  test('createReferralCode: crea codigo con defaults', async () => {
    const result = await createReferralCode(UID);
    expect(result.code).toBeDefined();
    expect(result.expiresAt).toBeDefined();
    expect(result.maxUses).toBe(MAX_USES_PER_CODE);
    const stored = mock.store.referral_codes[result.code];
    expect(stored.uid).toBe(UID);
    expect(stored.status).toBe('active');
    expect(stored.usesCount).toBe(0);
  });

  test('createReferralCode: crea con customCode y rewardType', async () => {
    const result = await createReferralCode(UID, {
      customCode: 'VERANO24',
      rewardType: 'discount',
      rewardValue: 20,
      maxUses: 50,
    });
    expect(result.code).toBe('VERANO24');
    expect(result.maxUses).toBe(50);
    const stored = mock.store.referral_codes['VERANO24'];
    expect(stored.rewardType).toBe('discount');
    expect(stored.rewardValue).toBe(20);
  });

  test('createReferralCode: lanza error si uid falta', async () => {
    await expect(createReferralCode('')).rejects.toThrow('uid requerido');
  });

  test('createReferralCode: lanza error si rewardType invalido', async () => {
    await expect(createReferralCode(UID, { rewardType: 'pizza' })).rejects.toThrow('rewardType invalido');
  });

  test('createReferralCode: lanza error si customCode tiene caracteres invalidos', async () => {
    await expect(createReferralCode(UID, { customCode: 'abc-xyz!!' })).rejects.toThrow('codigo invalido');
  });

  test('createReferralCode: customCode lowercase se convierte a uppercase valido', async () => {
    const result = await createReferralCode(UID, { customCode: 'verano24' });
    expect(result.code).toBe('VERANO24');
  });

  // validateAndUseCode

  test('validateAndUseCode: lanza error si code falta', async () => {
    await expect(validateAndUseCode('', '+5411111')).rejects.toThrow('code requerido');
  });

  test('validateAndUseCode: lanza error si newUserPhone falta', async () => {
    await expect(validateAndUseCode('VERANO24', '')).rejects.toThrow('newUserPhone requerido');
  });

  test('validateAndUseCode: retorna invalid si codigo no existe', async () => {
    const result = await validateAndUseCode('NOEXISTE', '+5411111');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('no encontrado');
  });

  test('validateAndUseCode: retorna valid e incrementa usesCount', async () => {
    await createReferralCode(UID, { customCode: 'PROMO001', rewardType: 'discount', rewardValue: 15 });
    const result = await validateAndUseCode('PROMO001', '+54115550001');
    expect(result.valid).toBe(true);
    expect(result.uid).toBe(UID);
    expect(result.rewardType).toBe('discount');
    expect(result.rewardValue).toBe(15);
    // Verificar incremento
    const stored = mock.store.referral_codes['PROMO001'];
    expect(stored.usesCount).toBe(1);
  });

  test('validateAndUseCode: acepta codigo lowercase (lo convierte)', async () => {
    await createReferralCode(UID, { customCode: 'PROMO002' });
    const result = await validateAndUseCode('promo002', '+54115550002');
    expect(result.valid).toBe(true);
  });

  test('validateAndUseCode: retorna invalid si codigo esta revocado', async () => {
    await createReferralCode(UID, { customCode: 'REVOCO01' });
    mock.store.referral_codes['REVOCO01'].status = 'revoked';
    const result = await validateAndUseCode('REVOCO01', '+54115550003');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('revoked');
  });

  test('validateAndUseCode: retorna invalid si codigo esta agotado (usesCount >= maxUses)', async () => {
    await createReferralCode(UID, { customCode: 'AGOTADO1', maxUses: 1 });
    mock.store.referral_codes['AGOTADO1'].usesCount = 1;
    const result = await validateAndUseCode('AGOTADO1', '+54115550004');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('agotado');
  });

  test('validateAndUseCode: retorna invalid si codigo esta expirado', async () => {
    await createReferralCode(UID, { customCode: 'EXPIRADO' });
    mock.store.referral_codes['EXPIRADO'].expiresAt = new Date(Date.now() - 1000).toISOString();
    const result = await validateAndUseCode('EXPIRADO', '+54115550005');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expirado');
  });

  // getReferralStats

  test('getReferralStats: lanza error si uid falta', async () => {
    await expect(getReferralStats('')).rejects.toThrow('uid requerido');
  });

  test('getReferralStats: retorna estadisticas vacias para uid sin codigos', async () => {
    const stats = await getReferralStats(UID);
    expect(stats.uid).toBe(UID);
    expect(stats.codesCount).toBe(0);
    expect(stats.totalUses).toBe(0);
    expect(stats.codes).toEqual([]);
  });

  test('getReferralStats: cuenta codigos y usos correctamente', async () => {
    await createReferralCode(UID, { customCode: 'STATS001' });
    await createReferralCode(UID, { customCode: 'STATS002' });
    mock.store.referral_codes['STATS001'].usesCount = 5;
    mock.store.referral_codes['STATS002'].usesCount = 3;
    const stats = await getReferralStats(UID);
    expect(stats.codesCount).toBe(2);
    expect(stats.totalUses).toBe(8);
    expect(stats.codes.length).toBe(2);
  });

  test('getReferralStats: no incluye codigos de otros owners', async () => {
    await createReferralCode(UID, { customCode: 'OWNER001' });
    await createReferralCode('other_owner', { customCode: 'OTHER001' });
    const stats = await getReferralStats(UID);
    expect(stats.codesCount).toBe(1);
    stats.codes.forEach(c => expect(c.uid).toBe(UID));
  });

  // Constantes

  test('REWARD_TYPES es frozen con 5 tipos', () => {
    expect(Object.isFrozen(REWARD_TYPES)).toBe(true);
    expect(REWARD_TYPES.length).toBe(5);
    ['discount','credit','free_month','cashback','points'].forEach(t => {
      expect(REWARD_TYPES).toContain(t);
    });
  });

  test('CODE_STATUSES es frozen con 4 estados', () => {
    expect(Object.isFrozen(CODE_STATUSES)).toBe(true);
    expect(CODE_STATUSES.length).toBe(4);
    ['active','expired','maxed','revoked'].forEach(s => {
      expect(CODE_STATUSES).toContain(s);
    });
  });

  test('CODE_LENGTH=8, CODE_EXPIRY_DAYS=30, MAX_USES_PER_CODE=100', () => {
    expect(CODE_LENGTH).toBe(8);
    expect(CODE_EXPIRY_DAYS).toBe(30);
    expect(MAX_USES_PER_CODE).toBe(100);
  });
});
