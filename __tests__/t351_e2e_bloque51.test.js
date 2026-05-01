'use strict';

/**
 * T351 -- E2E Bloque 51
 * Pipeline: loyalty_engine -> coupon_engine -> nps_tracker
 */

const {
  computeTier, computePointsFromAmount,
  buildLoyaltyAccount, buildTransactionRecord,
  TIER_THRESHOLDS, MIN_REDEEM_POINTS,
} = require('../core/loyalty_engine');

const {
  buildCouponRecord, validateCoupon, computeDiscount,
  applyRedemption,
} = require('../core/coupon_engine');

const {
  classifyNPS, calculateNPSScore, recordNPSResponse,
  __setFirestoreForTests: setNpsDb,
} = require('../core/nps_tracker');

const UID = 'owner_bloque51_001';
const PHONE = '+5712223333';

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

describe('T351 -- E2E Bloque 51: loyalty_engine + coupon_engine + nps_tracker', () => {

  test('Paso 1 -- nuevo lead en bronze tier (0 puntos)', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, {});
    expect(acc.tier).toBe('bronze');
    expect(acc.points).toBe(0);
    expect(acc.totalEarned).toBe(0);
  });

  test('Paso 2 -- ganar 600 puntos lleva a tier silver', () => {
    const pts = computePointsFromAmount(600, 1);
    expect(pts).toBe(600);
    const tier = computeTier(pts);
    expect(tier).toBe('silver');
  });

  test('Paso 3 -- buildTransactionRecord para earn de 150 puntos', () => {
    const rec = buildTransactionRecord('acc_bloque51', UID, 'earn', 150, { description: 'compra enero' });
    expect(rec.type).toBe('earn');
    expect(rec.points).toBe(150);
    expect(rec.accountId).toBe('acc_bloque51');
    expect(rec.txId).toBeDefined();
  });

  test('Paso 4 -- cupon descuento 15% aplicado sobre 200 -> 30', () => {
    const coupon = buildCouponRecord(UID, { type: 'percent', discountPercent: 15 });
    const validation = validateCoupon(coupon, 200, {});
    expect(validation.valid).toBe(true);
    const discount = computeDiscount(coupon, 200);
    expect(discount).toBe(30);
  });

  test('Paso 5 -- cupon agotado tras aplicar con maxUses=1', () => {
    const coupon = buildCouponRecord(UID, { type: 'fixed', discountAmount: 25, maxUses: 1 });
    expect(coupon.currentUses).toBe(0);
    const updated = applyRedemption(coupon);
    expect(updated.currentUses).toBe(1);
    expect(updated.status).toBe('exhausted');
  });

  test('Paso 6 -- NPS score 10 = promoter', () => {
    expect(classifyNPS(10)).toBe('promoter');
    expect(calculateNPSScore(10, 0, 0)).toBe(100);
  });

  test('Pipeline completo -- loyalty + coupon + NPS', async () => {
    setNpsDb(makeDeepDb());

    // A: Crear cuenta fidelidad
    const acc = buildLoyaltyAccount(UID, PHONE, {});
    expect(acc.uid).toBe(UID);
    expect(acc.tier).toBe('bronze');

    // B: Registrar earn de 300 puntos
    const rec = buildTransactionRecord('acc_pipe', UID, 'earn', 300, {});
    expect(rec.points).toBe(300);
    expect(rec.type).toBe('earn');

    // C: Tier sube con 2000 puntos acumulados
    expect(computeTier(2000)).toBe('gold');

    // D: Aplicar cupón de 10% sobre 500 -> descuento 50
    const coupon = buildCouponRecord(UID, { type: 'percent', discountPercent: 10 });
    const val = validateCoupon(coupon, 500, {});
    expect(val.valid).toBe(true);
    const disc = computeDiscount(coupon, 500);
    expect(disc).toBe(50);

    // E: Calcular NPS de cohorte: 8 promoters, 2 passives, 0 detractors -> 80
    const score = calculateNPSScore(8, 2, 0);
    expect(score).toBe(80);

    // F: Registrar NPS sin error
    await expect(recordNPSResponse(UID, PHONE, 9, { cohort: 'post_purchase' })).resolves.toBeUndefined();

    // G: Clasificaciones correctas
    expect(classifyNPS(9)).toBe('promoter');
    expect(classifyNPS(6)).toBe('detractor');
    expect(classifyNPS(7)).toBe('passive');
  });
});
