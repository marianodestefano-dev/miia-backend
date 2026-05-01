'use strict';

const {
  TRANSACTION_TYPES, REWARD_TYPES, TIER_NAMES, TIER_THRESHOLDS,
  MIN_REDEEM_POINTS, POINTS_EXPIRY_DAYS, POINTS_PER_CURRENCY_UNIT,
  computeTier, computePointsFromAmount,
  buildLoyaltyAccount, buildTransactionRecord,
  adjustPoints, buildRewardRecord, canRedeemReward,
} = require('../core/loyalty_engine');

const {
  COUPON_TYPES, COUPON_STATUSES,
  MAX_DISCOUNT_PERCENT, MAX_USES_DEFAULT, EXPIRY_DAYS_DEFAULT,
  generateCouponCode, buildCouponRecord,
  validateCoupon, computeDiscount, applyRedemption,
} = require('../core/coupon_engine');

const {
  NPS_MIN, NPS_MAX, PROMOTER_MIN, PASSIVE_MIN,
  DEFAULT_COHORT, DEFAULT_PERIOD_DAYS,
  classifyNPS, calculateNPSScore,
  recordNPSResponse, getCohortNPS,
  __setFirestoreForTests: setNpsDb,
} = require('../core/nps_tracker');

const UID = 'uid_t350';
const PHONE = '+5711112222';

function makeDeepDb() {
  const store = {};
  function makeDoc(path) {
    return {
      get: async () => {
        const d = store[path];
        return { exists: !!d, data: () => d };
      },
      set: async (data, opts) => {
        if (opts && opts.merge) store[path] = { ...(store[path] || {}), ...data };
        else store[path] = { ...data };
      },
      collection: (subCol) => makeCollection(path + '/' + subCol),
    };
  }
  function makeCollection(path) {
    return {
      doc: (docId) => makeDoc(path + '/' + docId),
      where: () => ({
        get: async () => {
          const prefix = path + '/';
          const docs = Object.entries(store)
            .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
            .map(([, v]) => ({ data: () => v }));
          return { docs, forEach: (fn) => docs.forEach(fn), empty: docs.length === 0 };
        },
      }),
      get: async () => {
        const prefix = path + '/';
        const docs = Object.entries(store)
          .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
          .map(([, v]) => ({ data: () => v }));
        return { docs, forEach: (fn) => docs.forEach(fn), empty: docs.length === 0 };
      },
    };
  }
  return { collection: (col) => makeCollection(col) };
}

describe('T350 -- loyalty_engine + coupon_engine + nps_tracker (32 tests)', () => {

  // ── LOYALTY ENGINE ──────────────────────────────────────────────────────────

  test('TRANSACTION_TYPES frozen, contiene earn/redeem/expire/adjust/bonus', () => {
    expect(() => { TRANSACTION_TYPES.hack = 'x'; }).toThrow();
    expect(TRANSACTION_TYPES).toContain('earn');
    expect(TRANSACTION_TYPES).toContain('redeem');
    expect(TRANSACTION_TYPES).toContain('expire');
    expect(TRANSACTION_TYPES).toContain('adjust');
    expect(TRANSACTION_TYPES).toContain('bonus');
    expect(TRANSACTION_TYPES.length).toBe(5);
  });

  test('REWARD_TYPES frozen, contiene discount/free_product/upgrade/cashback/custom', () => {
    expect(() => { REWARD_TYPES.hack = 'x'; }).toThrow();
    expect(REWARD_TYPES).toContain('discount');
    expect(REWARD_TYPES).toContain('free_product');
    expect(REWARD_TYPES).toContain('upgrade');
    expect(REWARD_TYPES).toContain('cashback');
    expect(REWARD_TYPES).toContain('custom');
  });

  test('TIER_NAMES frozen, contiene bronze/silver/gold/platinum/diamond en orden', () => {
    expect(() => { TIER_NAMES.hack = 'x'; }).toThrow();
    expect(TIER_NAMES).toContain('bronze');
    expect(TIER_NAMES).toContain('silver');
    expect(TIER_NAMES).toContain('gold');
    expect(TIER_NAMES).toContain('platinum');
    expect(TIER_NAMES).toContain('diamond');
    expect(TIER_NAMES.length).toBe(5);
  });

  test('computeTier: 0=bronze, 499=bronze, 500=silver, 1999=silver', () => {
    expect(computeTier(0)).toBe('bronze');
    expect(computeTier(499)).toBe('bronze');
    expect(computeTier(500)).toBe('silver');
    expect(computeTier(1999)).toBe('silver');
  });

  test('computeTier: 2000=gold, 4999=gold, 5000=platinum, 9999=platinum, 10000=diamond', () => {
    expect(computeTier(2000)).toBe('gold');
    expect(computeTier(4999)).toBe('gold');
    expect(computeTier(5000)).toBe('platinum');
    expect(computeTier(9999)).toBe('platinum');
    expect(computeTier(10000)).toBe('diamond');
    expect(computeTier(99999)).toBe('diamond');
  });

  test('computePointsFromAmount: multiplicador 1, amount 100 -> 100', () => {
    expect(computePointsFromAmount(100, 1)).toBe(100);
  });

  test('computePointsFromAmount: amount negativo -> 0', () => {
    expect(computePointsFromAmount(-50, 1)).toBe(0);
  });

  test('computePointsFromAmount: amount muy grande, capped en 100000', () => {
    const bigPts = computePointsFromAmount(1000000, 10);
    expect(bigPts).toBeLessThanOrEqual(100000);
    expect(bigPts).toBeGreaterThan(0);
  });

  test('buildLoyaltyAccount: retorna cuenta con tier y points inicializados', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, {});
    expect(acc.uid).toBe(UID);
    expect(acc.contactPhone).toBe(PHONE);
    expect(acc.points).toBe(0);
    expect(acc.tier).toBe('bronze');
    expect(acc.totalEarned).toBe(0);
    expect(acc.accountId).toBeDefined();
  });

  test('buildTransactionRecord: type invalido lanza', () => {
    expect(() => buildTransactionRecord('acc_1', UID, 'invalid_type', 100, {})).toThrow();
  });

  test('buildTransactionRecord: points < 0 lanza', () => {
    expect(() => buildTransactionRecord('acc_1', UID, 'earn', -1, {})).toThrow();
  });

  test('buildTransactionRecord: valido retorna record con type/points/accountId', () => {
    const rec = buildTransactionRecord('acc_1', UID, 'earn', 200, { description: 'compra test' });
    expect(rec.accountId).toBe('acc_1');
    expect(rec.uid).toBe(UID);
    expect(rec.type).toBe('earn');
    expect(rec.points).toBe(200);
    expect(rec.createdAt).toBeDefined();
    expect(rec.txId).toBeDefined();
  });

  test('MIN_REDEEM_POINTS=100, POINTS_EXPIRY_DAYS=365', () => {
    expect(MIN_REDEEM_POINTS).toBe(100);
    expect(POINTS_EXPIRY_DAYS).toBe(365);
  });

  // ── COUPON ENGINE ────────────────────────────────────────────────────────────

  test('COUPON_TYPES frozen, contiene percent/fixed/free_shipping/bogo/custom', () => {
    expect(() => { COUPON_TYPES.hack = 'x'; }).toThrow();
    expect(COUPON_TYPES).toContain('percent');
    expect(COUPON_TYPES).toContain('fixed');
    expect(COUPON_TYPES).toContain('free_shipping');
    expect(COUPON_TYPES).toContain('bogo');
    expect(COUPON_TYPES).toContain('custom');
  });

  test('COUPON_STATUSES frozen, contiene active/inactive/expired/exhausted/scheduled', () => {
    expect(() => { COUPON_STATUSES.hack = 'x'; }).toThrow();
    expect(COUPON_STATUSES).toContain('active');
    expect(COUPON_STATUSES).toContain('inactive');
    expect(COUPON_STATUSES).toContain('expired');
    expect(COUPON_STATUSES).toContain('exhausted');
    expect(COUPON_STATUSES).toContain('scheduled');
  });

  test('generateCouponCode: mismo seed -> mismo code determinista', () => {
    const code1 = generateCouponCode(8, 'seed_abc');
    const code2 = generateCouponCode(8, 'seed_abc');
    expect(code1).toBe(code2);
    expect(code1.length).toBe(8);
  });

  test('generateCouponCode: sin seed -> code sin O/0/I/1, longitud 6', () => {
    const code = generateCouponCode(6);
    expect(code.length).toBe(6);
    expect(code).not.toMatch(/[O0I1]/);
  });

  test('buildCouponRecord: retorna coupon con code, type, status=active', () => {
    const coupon = buildCouponRecord(UID, { type: 'percent', discountPercent: 20 });
    expect(coupon.uid).toBe(UID);
    expect(typeof coupon.code).toBe('string');
    expect(coupon.code.length).toBeGreaterThanOrEqual(4);
    expect(coupon.type).toBe('percent');
    expect(coupon.status).toBe('active');
  });

  test('buildCouponRecord: code personalizado se respeta (mayuscula)', () => {
    const coupon = buildCouponRecord(UID, { code: 'MIIA2026', type: 'fixed', discountAmount: 50 });
    expect(coupon.code).toBe('MIIA2026');
    expect(coupon.discountAmount).toBe(50);
  });

  test('validateCoupon: coupon inactive -> valid=false con error coupon_inactive', () => {
    const coupon = buildCouponRecord(UID, { type: 'percent', discountPercent: 10, status: 'inactive' });
    const result = validateCoupon(coupon, 100, {});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('coupon_inactive');
  });

  test('validateCoupon: coupon active -> valid=true, errors=[]', () => {
    const coupon = buildCouponRecord(UID, { type: 'percent', discountPercent: 10 });
    const result = validateCoupon(coupon, 100, {});
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  test('computeDiscount: percent 20% sobre 100 -> 20', () => {
    const coupon = buildCouponRecord(UID, { type: 'percent', discountPercent: 20 });
    const discount = computeDiscount(coupon, 100);
    expect(discount).toBe(20);
  });

  test('computeDiscount: fixed 15 sobre 100 -> 15', () => {
    const coupon = buildCouponRecord(UID, { type: 'fixed', discountAmount: 15 });
    const discount = computeDiscount(coupon, 100);
    expect(discount).toBe(15);
  });

  test('applyRedemption: incrementa currentUses y cambia status si agotado', () => {
    const coupon = buildCouponRecord(UID, { type: 'percent', discountPercent: 10, maxUses: 1 });
    expect(coupon.currentUses).toBe(0);
    const updated = applyRedemption(coupon);
    expect(updated.currentUses).toBe(1);
    expect(updated.status).toBe('exhausted');
  });

  test('MAX_DISCOUNT_PERCENT=100, MAX_USES_DEFAULT=1000, EXPIRY_DAYS_DEFAULT=30', () => {
    expect(MAX_DISCOUNT_PERCENT).toBe(100);
    expect(MAX_USES_DEFAULT).toBe(1000);
    expect(EXPIRY_DAYS_DEFAULT).toBe(30);
  });

  // ── NPS TRACKER ─────────────────────────────────────────────────────────────

  test('NPS_MIN=0, NPS_MAX=10, PROMOTER_MIN=9, PASSIVE_MIN=7', () => {
    expect(NPS_MIN).toBe(0);
    expect(NPS_MAX).toBe(10);
    expect(PROMOTER_MIN).toBe(9);
    expect(PASSIVE_MIN).toBe(7);
  });

  test('DEFAULT_COHORT=default, DEFAULT_PERIOD_DAYS=90', () => {
    expect(DEFAULT_COHORT).toBe('default');
    expect(DEFAULT_PERIOD_DAYS).toBe(90);
  });

  test('classifyNPS: 9=promoter, 10=promoter', () => {
    expect(classifyNPS(9)).toBe('promoter');
    expect(classifyNPS(10)).toBe('promoter');
  });

  test('classifyNPS: 7=passive, 8=passive', () => {
    expect(classifyNPS(7)).toBe('passive');
    expect(classifyNPS(8)).toBe('passive');
  });

  test('classifyNPS: 0=detractor, 5=detractor, 6=detractor', () => {
    expect(classifyNPS(0)).toBe('detractor');
    expect(classifyNPS(5)).toBe('detractor');
    expect(classifyNPS(6)).toBe('detractor');
  });

  test('classifyNPS: score invalido lanza', () => {
    expect(() => classifyNPS(-1)).toThrow();
    expect(() => classifyNPS(11)).toThrow();
    expect(() => classifyNPS(null)).toThrow();
  });

  test('calculateNPSScore: total=0 -> 0', () => {
    expect(calculateNPSScore(0, 0, 0)).toBe(0);
  });

  test('calculateNPSScore: 10 promoters 0 passives 0 detractors -> 100', () => {
    expect(calculateNPSScore(10, 0, 0)).toBe(100);
  });

  test('calculateNPSScore: 5 promoters 0 passives 5 detractors -> 0', () => {
    expect(calculateNPSScore(5, 0, 5)).toBe(0);
  });

  test('calculateNPSScore: 7 promoters 3 passives 0 detractors -> 70', () => {
    expect(calculateNPSScore(7, 3, 0)).toBe(70);
  });

  test('recordNPSResponse: uid null lanza', async () => {
    setNpsDb(makeDeepDb());
    await expect(recordNPSResponse(null, PHONE, 8, {})).rejects.toThrow('uid requerido');
  });

  test('recordNPSResponse: score fuera de rango lanza', async () => {
    setNpsDb(makeDeepDb());
    await expect(recordNPSResponse(UID, PHONE, 11, {})).rejects.toThrow();
    await expect(recordNPSResponse(UID, PHONE, -1, {})).rejects.toThrow();
  });

  test('recordNPSResponse: valido completa sin error, classifyNPS confirma promoter', async () => {
    setNpsDb(makeDeepDb());
    // recordNPSResponse no retorna valor, solo persiste. Verificar que no lanza.
    await expect(recordNPSResponse(UID, PHONE, 9, { cohort: 'test' })).resolves.toBeUndefined();
    // Verificar la clasificacion directamente
    expect(classifyNPS(9)).toBe('promoter');
  });
});
