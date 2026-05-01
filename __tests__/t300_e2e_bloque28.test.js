'use strict';

/**
 * T300 -- E2E Bloque 28
 * Pipeline: owner evalua planes (dynamic_pricing) -> recomienda pro ->
 * suscripcion mensual creada -> pago primer cobro -> factura emitida ->
 * loyalty por pago -> admin actualiza precio plan -> stats completas.
 */

const {
  getPlanPrice,
  getAllPlans,
  comparePlans,
  recommendPlan,
  savePlanPricing,
  invalidateCache,
  __setFirestoreForTests: setPricingDb,
} = require('../core/dynamic_pricing_engine');

const {
  buildSubscriptionRecord,
  computeSubscriptionPrice,
  recordBilling,
  cancelSubscription,
  pauseSubscription,
  resumeSubscription,
  __setFirestoreForTests: setSubDb,
} = require('../core/subscription_engine');

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

function makeMockDb() {
  const store = { global_pricing: {} };
  return {
    store,
    db: {
      collection: (colName) => {
        if (colName === 'global_pricing') {
          return {
            get: async () => {
              const entries = Object.entries(store.global_pricing || {});
              return {
                empty: entries.length === 0,
                forEach: (fn) => entries.forEach(([id, data]) => fn({ id, data: () => data })),
              };
            },
            doc: (id) => ({
              set: async (data, opts) => {
                if (opts && opts.merge) {
                  store.global_pricing[id] = { ...(store.global_pricing[id] || {}), ...data };
                } else {
                  store.global_pricing[id] = { ...data };
                }
              },
            }),
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
                  const filtered = all.filter(r => chain.filters.every(([f, o, v]) => {
                    if (o === '==') return r[f] === v;
                    return true;
                  }));
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

const UID = 'owner_bloque28_001';
const PHONE = '+541177770001';

describe('T300 -- E2E Bloque 28: dynamic_pricing + subscription + payment + invoice + loyalty', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setPricingDb(mock.db);
    setSubDb(mock.db);
    setPayDb(mock.db);
    setInvDb(mock.db);
    setLoyDb(mock.db);
    invalidateCache();
  });

  // Paso 1: Ver todos los planes disponibles

  test('Paso 1 -- todos los planes disponibles para AR', async () => {
    const plans = await getAllPlans('AR');
    expect(Object.keys(plans).length).toBe(4);
    expect(plans.free.currency).toBe('ARS');
    expect(plans.pro.priceUSD).toBe(49);
    expect(plans.enterprise.features.contacts).toBe(50000);
  });

  // Paso 2: Comparar starter vs pro

  test('Paso 2 -- comparar starter vs pro para decidir upgrade', () => {
    const diff = comparePlans('starter', 'pro');
    expect(diff.priceDiffUSD).toBe(30);
    expect(diff.messagesDiff).toBe(4500);
    expect(diff.upgradeRecommended).toBe(true);
  });

  // Paso 3: Recomendar plan segun uso del negocio

  test('Paso 3 -- recommendPlan para negocio con 300 msgs/dia y 400 contactos', () => {
    const plan = recommendPlan({ avgMessagesPerDay: 300, totalContacts: 400 });
    expect(plan).toBe('starter'); // 300 msgs > 50, contacts=400 > 100 -> starter
    // 300 > 50 y 400 > 100 -> starter
  });

  test('Paso 3b -- recommendPlan para negocio con 600 contactos', () => {
    const plan = recommendPlan({ avgMessagesPerDay: 100, totalContacts: 600 });
    expect(plan).toBe('pro'); // contacts > 500 -> pro
  });

  // Paso 4: Obtener precio del plan pro para AR

  test('Paso 4 -- precio plan pro para Argentina', async () => {
    const price = await getPlanPrice('pro', 'AR');
    expect(price.plan).toBe('pro');
    expect(price.currency).toBe('ARS');
    expect(price.priceUSD).toBe(49);
    expect(price.features.messagesPerDay).toBe(5000);
  });

  // Paso 5: Suscripcion al plan pro creada

  test('Paso 5 -- suscripcion mensual plan pro creada', () => {
    let sub = buildSubscriptionRecord(UID, {
      name: 'MIIA Pro Plan',
      type: 'plan',
      billingCycle: 'monthly',
      price: 49,
      currency: 'USD',
      contactPhone: PHONE,
      contactName: 'Federico Suarez',
    });

    expect(sub.status).toBe('active');
    expect(sub.billingCycle).toBe('monthly');
    expect(computeSubscriptionPrice(sub)).toBe(49);

    // Primer cobro exitoso
    sub = recordBilling(sub, true);
    expect(sub.billingCount).toBe(1);
    expect(sub.nextBillingAt).toBeGreaterThan(sub.lastBilledAt);
  });

  // Paso 6: Pago del primer mes

  test('Paso 6 -- pago 49 USD por suscripcion pro', () => {
    let pago = buildPaymentRecord(UID, {
      amount: 49,
      method: 'card_credit',
      currency: 'USD',
      contactPhone: PHONE,
      contactName: 'Federico Suarez',
      description: 'MIIA Pro Plan - Mes 1',
    });

    expect(pago.status).toBe('pending');
    pago = markProcessing(pago);
    pago = processPayment(pago, { success: true, amountReceived: 49, externalId: 'CC-B28-001' });
    expect(pago.status).toBe('completed');
    expect(pago.amountReceived).toBe(49);
    expect(pago.currency).toBe('USD');
  });

  // Paso 7: Factura emitida

  test('Paso 7 -- factura emitida por suscripcion pro', () => {
    const lineItems = [
      buildLineItem({ description: 'MIIA Pro Plan - 1 mes', quantity: 1, unitPrice: 49, taxRate: 0 }),
    ];

    let invoice = buildInvoiceRecord(UID, {
      clientPhone: PHONE,
      clientName: 'Federico Suarez',
      currency: 'USD',
      lineItems,
      globalDiscountAmount: 0,
    });

    expect(invoice.status).toBe('draft');
    expect(invoice.total).toBe(49);

    const paid = applyPayment(invoice, 49);
    expect(paid.status).toBe('paid');
    expect(paid.amountDue).toBe(0);
  });

  // Paso 8: Loyalty por suscripcion

  test('Paso 8 -- loyalty 49 puntos por pago plan pro', () => {
    let account = buildLoyaltyAccount(UID, PHONE, { contactName: 'Federico Suarez' });
    const result = earnPoints(account, 49, { source: 'subscription', plan: 'pro' });
    account = result.account;
    expect(account.points).toBe(49);
    expect(account.tier).toBe('bronze'); // <500 = bronze
  });

  // Paso 9: Admin actualiza precio plan pro en Firestore

  test('Paso 9 -- admin actualiza precio plan pro a 55 USD', async () => {
    await savePlanPricing('pro', {
      priceUSD: 55,
      messagesPerDay: 5000,
      broadcastsPerDay: 10,
      contacts: 5000,
    });

    const stored = mock.store.global_pricing['pro'];
    expect(stored.priceUSD).toBe(55);
    expect(stored.updatedAt).toBeDefined();

    // Cache invalidada, siguiente getPlanPrice usa nuevo precio
    const price = await getPlanPrice('pro', 'US');
    expect(price.priceUSD).toBe(55);
  });

  // Pipeline completo integrado

  test('Pipeline completo -- pricing + subscription + payment + invoice + loyalty', async () => {
    // A. Ver planes
    const plans = await getAllPlans('CO');
    expect(plans.pro.currency).toBe('COP');

    // B. Comparar y recomendar
    const diff = comparePlans('starter', 'pro');
    expect(diff.upgradeRecommended).toBe(true);

    const recommended = recommendPlan({ avgMessagesPerDay: 600, totalContacts: 400 });
    expect(recommended).toBe('pro'); // 600 > 500 msgs -> pro

    // C. Precio pro para Colombia
    const proPrice = await getPlanPrice('pro', 'CO');
    expect(proPrice.currency).toBe('COP');
    expect(proPrice.priceUSD).toBe(49);

    // D. Suscripcion
    let sub = buildSubscriptionRecord(UID, {
      name: 'MIIA Pro Plan',
      type: 'plan',
      billingCycle: 'monthly',
      price: 49,
      currency: 'USD',
      contactPhone: PHONE,
      discountPercent: 0,
    });
    expect(sub.status).toBe('active');
    sub = recordBilling(sub, true);
    expect(sub.billingCount).toBe(1);

    // E. Pago
    let pago = buildPaymentRecord(UID, { amount: 49, method: 'transfer', currency: 'USD', contactPhone: PHONE });
    pago = markProcessing(pago);
    pago = processPayment(pago, { success: true, amountReceived: 49 });
    expect(pago.status).toBe('completed');

    // F. Factura
    const lineItems = [buildLineItem({ description: 'Pro Plan mes 1', quantity: 1, unitPrice: 49, taxRate: 0 })];
    let invoice = buildInvoiceRecord(UID, { clientPhone: PHONE, currency: 'USD', lineItems, globalDiscountAmount: 0 });
    invoice = applyPayment(invoice, 49);
    expect(invoice.status).toBe('paid');

    // G. Loyalty
    let account = buildLoyaltyAccount(UID, PHONE, {});
    const earned = earnPoints(account, 49, { source: 'subscription' });
    account = earned.account;
    expect(account.points).toBe(49);

    // H. Pausa y reanuda suscripcion
    sub = pauseSubscription(sub);
    expect(sub.status).toBe('paused');
    expect(sub.pausedAt).toBeGreaterThan(0);

    sub = resumeSubscription(sub);
    expect(sub.status).toBe('active');
    expect(sub.pausedAt).toBeNull();

    // I. Admin actualiza precio
    await savePlanPricing('pro', { priceUSD: 59, messagesPerDay: 5000, broadcastsPerDay: 10, contacts: 5000 });
    const updatedPrice = await getPlanPrice('pro', 'AR');
    expect(updatedPrice.priceUSD).toBe(59);

    // J. Stats pago
    const payStats = computePaymentStats([pago]);
    expect(payStats.totalCollected).toBe(49);
    expect(payStats.successRate).toBe(100);
    expect(payStats.byMethod.transfer).toBe(1);

    // K. Cancel suscripcion
    sub = cancelSubscription(sub);
    expect(sub.status).toBe('cancelled');
    expect(sub.cancelledAt).toBeGreaterThan(0);
    expect(() => cancelSubscription(sub)).toThrow('ya esta cancelada');
  });
});
