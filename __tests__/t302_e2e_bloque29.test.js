'use strict';

/**
 * T302 -- E2E Bloque 29
 * Pipeline: owner crea codigo de referido (viral_referral) → nuevo cliente
 * usa codigo (descuento 20%) → pago con descuento → factura emitida →
 * loyalty bonus al referidor → stats de referidos → upgrade plan (pricing)
 * → pipeline completo.
 */

const {
  generateCode,
  isCodeValid,
  createReferralCode,
  validateAndUseCode,
  getReferralStats,
  __setFirestoreForTests: setRefDb,
} = require('../core/viral_referral_engine');

const {
  buildPaymentRecord,
  processPayment,
  markProcessing,
  computePaymentStats,
  __setFirestoreForTests: setPayDb,
} = require('../core/payment_engine');

const {
  buildInvoiceRecord,
  buildLineItem,
  applyPayment,
  __setFirestoreForTests: setInvDb,
} = require('../core/invoice_engine');

const {
  buildLoyaltyAccount,
  earnPoints,
  __setFirestoreForTests: setLoyDb,
} = require('../core/loyalty_engine');

const {
  comparePlans,
  recommendPlan,
  getPlanPrice,
  invalidateCache,
  __setFirestoreForTests: setPricingDb,
} = require('../core/dynamic_pricing_engine');

const {
  buildCouponRecord,
  computeDiscount,
  validateCoupon,
  __setFirestoreForTests: setCoupDb,
} = require('../core/coupon_engine');

function makeMockDb() {
  const store = { referral_codes: {}, global_pricing: {} };
  return {
    store,
    db: {
      collection: (colName) => {
        if (colName === 'referral_codes' || colName === 'global_pricing') {
          return {
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
                const filtered = all.filter(r => op === '==' ? r[field] === val : true);
                return {
                  empty: filtered.length === 0,
                  forEach: (fn) => filtered.forEach(d => fn({ data: () => d })),
                };
              },
            }),
            get: async () => {
              const entries = Object.entries(store[colName] || {});
              return {
                empty: entries.length === 0,
                forEach: (fn) => entries.forEach(([id, data]) => fn({ id, data: () => data })),
              };
            },
          };
        }
        // owners pattern
        return {
          doc: (uid) => ({
            collection: (subCol) => ({
              doc: (id) => ({
                set: async (data, opts) => {
                  if (!store[uid]) store[uid] = {};
                  if (!store[uid][subCol]) store[uid][subCol] = {};
                  if (opts && opts.merge) {
                    store[uid][subCol][id] = { ...(store[uid][subCol][id] || {}), ...data };
                  } else {
                    store[uid][subCol][id] = { ...data };
                  }
                },
                get: async () => {
                  const rec = store[uid] && store[uid][subCol] && store[uid][subCol][id];
                  return { exists: !!rec, data: () => rec };
                },
              }),
              where: (field, op, val) => {
                const chain = { filters: [[field, op, val]] };
                chain.where = (f2, op2, v2) => { chain.filters.push([f2, op2, v2]); return chain; };
                chain.get = async () => {
                  const all = Object.values((store[uid] || {})[subCol] || {});
                  const filtered = all.filter(r => chain.filters.every(([f, o, v]) => o === '==' ? r[f] === v : true));
                  return {
                    empty: filtered.length === 0,
                    forEach: (fn) => filtered.forEach(d => fn({ data: () => d })),
                  };
                };
                return chain;
              },
              get: async () => {
                const all = Object.values((store[uid] || {})[subCol] || {});
                return {
                  empty: all.length === 0,
                  forEach: (fn) => all.forEach(d => fn({ data: () => d })),
                };
              },
            }),
          }),
        };
      },
    },
  };
}

const REFERRER_UID = 'owner_bloque29_referrer';
const PHONE_REFERRER = '+541188880001';
const PHONE_NEW_CLIENT = '+541188880002';

describe('T302 -- E2E Bloque 29: viral_referral + coupon + payment + invoice + loyalty + pricing', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setRefDb(mock.db);
    setPayDb(mock.db);
    setInvDb(mock.db);
    setLoyDb(mock.db);
    setPricingDb(mock.db);
    setCoupDb(mock.db);
    invalidateCache();
  });

  // Paso 1: Owner genera codigo de referido

  test('Paso 1 -- owner crea codigo de referido con recompensa cashback', async () => {
    const result = await createReferralCode(REFERRER_UID, {
      customCode: 'VERANO24',
      rewardType: 'cashback',
      rewardValue: 20,
      maxUses: 10,
    });
    expect(result.code).toBe('VERANO24');
    expect(result.maxUses).toBe(10);
    expect(result.expiresAt).toBeDefined();

    const stored = mock.store.referral_codes['VERANO24'];
    expect(stored.uid).toBe(REFERRER_UID);
    expect(stored.rewardType).toBe('cashback');
    expect(stored.rewardValue).toBe(20);
  });

  // Paso 2: Nuevo cliente valida el codigo

  test('Paso 2 -- nuevo cliente valida codigo VERANO24 y recibe reward info', async () => {
    await createReferralCode(REFERRER_UID, {
      customCode: 'VERANO24', rewardType: 'discount', rewardValue: 20, maxUses: 10,
    });

    const result = await validateAndUseCode('VERANO24', PHONE_NEW_CLIENT);
    expect(result.valid).toBe(true);
    expect(result.uid).toBe(REFERRER_UID);
    expect(result.rewardType).toBe('discount');
    expect(result.rewardValue).toBe(20);

    // usesCount incremented
    expect(mock.store.referral_codes['VERANO24'].usesCount).toBe(1);
  });

  // Paso 3: Descuento aplicado al pago del nuevo cliente

  test('Paso 3 -- descuento 20% aplicado al plan starter 19 USD', () => {
    const precioBase = 19; // plan starter
    const descuentoPct = 20;
    const descuento = Math.round(precioBase * descuentoPct / 100 * 100) / 100;
    const finalAmount = precioBase - descuento;

    expect(descuento).toBe(3.8);
    expect(finalAmount).toBe(15.2);
  });

  // Paso 4: Pago del nuevo cliente con descuento

  test('Paso 4 -- pago 15.2 USD del nuevo cliente completado', () => {
    let pago = buildPaymentRecord(REFERRER_UID, {
      amount: 15.2,
      method: 'card_credit',
      currency: 'USD',
      contactPhone: PHONE_NEW_CLIENT,
      description: 'Starter Plan - referido VERANO24',
    });

    pago = markProcessing(pago);
    pago = processPayment(pago, { success: true, amountReceived: 15.2 });
    expect(pago.status).toBe('completed');
    expect(pago.amountReceived).toBe(15.2);
  });

  // Paso 5: Factura emitida para el nuevo cliente

  test('Paso 5 -- factura emitida para el nuevo cliente con descuento referido', () => {
    const lineItems = [
      buildLineItem({ description: 'Starter Plan 1 mes', quantity: 1, unitPrice: 19, taxRate: 0 }),
    ];
    let invoice = buildInvoiceRecord(REFERRER_UID, {
      clientPhone: PHONE_NEW_CLIENT,
      currency: 'USD',
      lineItems,
      globalDiscountAmount: 3.8,
    });

    expect(invoice.total).toBe(15.2);
    const paid = applyPayment(invoice, 15.2);
    expect(paid.status).toBe('paid');
    expect(paid.amountDue).toBe(0);
  });

  // Paso 6: Referidor recibe loyalty bonus

  test('Paso 6 -- referidor gana 500 loyalty points por referido exitoso', () => {
    let refAccount = buildLoyaltyAccount(REFERRER_UID, PHONE_REFERRER, { contactName: 'Referidor' });
    const result = earnPoints(refAccount, 500, { source: 'referral', code: 'VERANO24' });
    refAccount = result.account;
    expect(refAccount.points).toBe(500);
    expect(refAccount.tier).toBe('silver'); // 500 = silver threshold
  });

  // Paso 7: Stats de referidos del owner

  test('Paso 7 -- stats de referidos: 1 codigo, 1 uso', async () => {
    await createReferralCode(REFERRER_UID, { customCode: 'VERANO24', maxUses: 10 });
    await validateAndUseCode('VERANO24', PHONE_NEW_CLIENT);

    const stats = await getReferralStats(REFERRER_UID);
    expect(stats.codesCount).toBe(1);
    expect(stats.totalUses).toBe(1);
  });

  // Paso 8: Recomendacion de plan para el negocio que crece por referidos

  test('Paso 8 -- con 8 referidos (800 msgs/dia) recomienda plan pro', () => {
    const plan = recommendPlan({ avgMessagesPerDay: 800, totalContacts: 800 });
    expect(plan).toBe('pro'); // >500 msgs -> pro
  });

  // Paso 9: Comparar planes para upgrade

  test('Paso 9 -- comparar starter vs pro muestra beneficio del upgrade', () => {
    const diff = comparePlans('starter', 'pro');
    expect(diff.priceDiffUSD).toBe(30);
    expect(diff.messagesDiff).toBe(4500);
    expect(diff.contactsDiff).toBe(4500);
    expect(diff.upgradeRecommended).toBe(true);
  });

  // Pipeline completo

  test('Pipeline completo -- referral+discount+payment+invoice+loyalty+pricing', async () => {
    // A. Crear codigo referido
    await createReferralCode(REFERRER_UID, {
      customCode: 'FULLREF1', rewardType: 'discount', rewardValue: 20, maxUses: 5,
    });

    // B. Validar y usar codigo
    const validation = await validateAndUseCode('FULLREF1', PHONE_NEW_CLIENT);
    expect(validation.valid).toBe(true);
    expect(validation.rewardValue).toBe(20);
    expect(mock.store.referral_codes['FULLREF1'].usesCount).toBe(1);

    // C. Calcular descuento (20% sobre 19 USD starter)
    const base = 19;
    const disc = Math.round(base * 0.20 * 100) / 100;
    const final = Math.round((base - disc) * 100) / 100;
    expect(disc).toBe(3.8);
    expect(final).toBe(15.2);

    // D. Pago cliente nuevo
    let pago = buildPaymentRecord(REFERRER_UID, { amount: final, method: 'transfer', currency: 'USD', contactPhone: PHONE_NEW_CLIENT });
    pago = markProcessing(pago);
    pago = processPayment(pago, { success: true, amountReceived: final });
    expect(pago.status).toBe('completed');

    // E. Factura
    const items = [buildLineItem({ description: 'Starter mes 1', quantity: 1, unitPrice: base, taxRate: 0 })];
    let invoice = buildInvoiceRecord(REFERRER_UID, { clientPhone: PHONE_NEW_CLIENT, currency: 'USD', items, lineItems: items, globalDiscountAmount: disc });
    invoice = applyPayment(invoice, final);
    expect(invoice.status).toBe('paid');

    // F. Loyalty referidor
    let refAcc = buildLoyaltyAccount(REFERRER_UID, PHONE_REFERRER, {});
    refAcc = earnPoints(refAcc, 500, { source: 'referral' }).account;
    expect(refAcc.points).toBe(500);
    expect(refAcc.tier).toBe('silver');

    // G. Stats referido
    const stats = await getReferralStats(REFERRER_UID);
    expect(stats.codesCount).toBe(1);
    expect(stats.totalUses).toBe(1);

    // H. Recomendacion upgrade
    const rec = recommendPlan({ avgMessagesPerDay: 800 });
    expect(rec).toBe('pro');

    // I. Ver precio plan pro para AR
    const proAR = await getPlanPrice('pro', 'AR');
    expect(proAR.currency).toBe('ARS');
    expect(proAR.priceUSD).toBe(49);

    // J. Stats pago
    const payStats = computePaymentStats([pago]);
    expect(payStats.totalCollected).toBe(15.2);
    expect(payStats.successRate).toBe(100);

    // K. Intento de codigo agotado tras usar 5 veces
    for (let i = 1; i < 5; i++) {
      await validateAndUseCode('FULLREF1', '+541188880' + (10 + i));
    }
    const exhausted = await validateAndUseCode('FULLREF1', '+541188880099');
    expect(exhausted.valid).toBe(false);
    expect(exhausted.reason).toContain('agotado');
  });
});
