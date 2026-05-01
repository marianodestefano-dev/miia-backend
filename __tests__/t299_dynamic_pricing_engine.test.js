'use strict';

/**
 * T299 -- dynamic_pricing_engine unit tests (37/37)
 * Cubre: isValidPlan, isValidCurrency, getCurrencyForCountry, comparePlans,
 * recommendPlan, loadPricingFromFirestore, getPlanPrice, getAllPlans,
 * savePlanPricing, cache, constantes.
 */

const {
  getPlanPrice,
  getAllPlans,
  savePlanPricing,
  comparePlans,
  recommendPlan,
  loadPricingFromFirestore,
  getCurrencyForCountry,
  isValidPlan,
  isValidCurrency,
  invalidateCache,
  SUPPORTED_CURRENCIES,
  DEFAULT_PLANS,
  COUNTRY_CURRENCY_MAP,
  PLAN_NAMES,
  CACHE_TTL_MS,
  __setFirestoreForTests,
} = require('../core/dynamic_pricing_engine');

function makeMockDb(initialData) {
  const store = Object.assign({ global_pricing: {} }, initialData || {});
  return {
    store,
    db: {
      collection: (colName) => ({
        get: async () => {
          const entries = Object.entries(store[colName] || {});
          return {
            empty: entries.length === 0,
            forEach: (fn) => entries.forEach(([id, data]) => fn({ id, data: () => data })),
          };
        },
        doc: (id) => ({
          set: async (data, opts) => {
            if (!store[colName]) store[colName] = {};
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
      }),
    },
  };
}

describe('T299 -- dynamic_pricing_engine (37 tests)', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    __setFirestoreForTests(mock.db);
    invalidateCache();
  });

  // isValidPlan

  test('isValidPlan: planes validos retornan true', () => {
    expect(isValidPlan('free')).toBe(true);
    expect(isValidPlan('starter')).toBe(true);
    expect(isValidPlan('pro')).toBe(true);
    expect(isValidPlan('enterprise')).toBe(true);
  });

  test('isValidPlan: planes invalidos retornan false', () => {
    expect(isValidPlan('ultra')).toBe(false);
    expect(isValidPlan('')).toBe(false);
    expect(isValidPlan(null)).toBe(false);
  });

  // isValidCurrency

  test('isValidCurrency: monedas validas retornan true', () => {
    expect(isValidCurrency('USD')).toBe(true);
    expect(isValidCurrency('ARS')).toBe(true);
    expect(isValidCurrency('COP')).toBe(true);
    expect(isValidCurrency('MXN')).toBe(true);
  });

  test('isValidCurrency: monedas invalidas retornan false', () => {
    expect(isValidCurrency('EUR')).toBe(false);
    expect(isValidCurrency('GBP')).toBe(false);
    expect(isValidCurrency('')).toBe(false);
  });

  // getCurrencyForCountry

  test('getCurrencyForCountry: paises conocidos retornan moneda correcta', () => {
    expect(getCurrencyForCountry('AR')).toBe('ARS');
    expect(getCurrencyForCountry('CO')).toBe('COP');
    expect(getCurrencyForCountry('MX')).toBe('MXN');
    expect(getCurrencyForCountry('CL')).toBe('CLP');
    expect(getCurrencyForCountry('PE')).toBe('PEN');
    expect(getCurrencyForCountry('BR')).toBe('BRL');
    expect(getCurrencyForCountry('US')).toBe('USD');
  });

  test('getCurrencyForCountry: pais desconocido retorna USD (DEFAULT)', () => {
    expect(getCurrencyForCountry('DE')).toBe('USD');
    expect(getCurrencyForCountry(null)).toBe('USD');
    expect(getCurrencyForCountry(undefined)).toBe('USD');
  });

  // comparePlans

  test('comparePlans: free vs starter retorna diff correcto', () => {
    const result = comparePlans('free', 'starter');
    expect(result).not.toBeNull();
    expect(result.priceDiffUSD).toBe(19); // 19 - 0
    expect(result.messagesDiff).toBe(450); // 500 - 50
    expect(result.upgradeRecommended).toBe(true);
  });

  test('comparePlans: starter vs pro retorna diff correcto', () => {
    const result = comparePlans('starter', 'pro');
    expect(result.priceDiffUSD).toBe(30); // 49 - 19
    expect(result.messagesDiff).toBe(4500); // 5000 - 500
    expect(result.upgradeRecommended).toBe(true);
  });

  test('comparePlans: plan invalido retorna null', () => {
    expect(comparePlans('ultra', 'pro')).toBeNull();
    expect(comparePlans('free', 'mega')).toBeNull();
  });

  test('comparePlans: pro vs enterprise tiene upgradeRecommended=true', () => {
    const result = comparePlans('pro', 'enterprise');
    expect(result.priceDiffUSD).toBe(100); // 149 - 49
    expect(result.upgradeRecommended).toBe(true);
  });

  // recommendPlan

  test('recommendPlan: null o sin datos retorna free', () => {
    expect(recommendPlan(null)).toBe('free');
    expect(recommendPlan({})).toBe('free');
  });

  test('recommendPlan: avgMessagesPerDay=30 y contacts=50 → free', () => {
    expect(recommendPlan({ avgMessagesPerDay: 30, totalContacts: 50 })).toBe('free');
  });

  test('recommendPlan: avgMessagesPerDay=100 → starter', () => {
    expect(recommendPlan({ avgMessagesPerDay: 100 })).toBe('starter');
  });

  test('recommendPlan: totalContacts=600 → pro', () => {
    expect(recommendPlan({ avgMessagesPerDay: 10, totalContacts: 600 })).toBe('pro');
  });

  test('recommendPlan: avgMessagesPerDay=6000 → enterprise', () => {
    expect(recommendPlan({ avgMessagesPerDay: 6000 })).toBe('enterprise');
  });

  test('recommendPlan: totalContacts=6000 → enterprise', () => {
    expect(recommendPlan({ totalContacts: 6000 })).toBe('enterprise');
  });

  // loadPricingFromFirestore

  test('loadPricingFromFirestore: sin datos en Firestore retorna DEFAULT_PLANS', async () => {
    const pricing = await loadPricingFromFirestore();
    expect(pricing).toBeDefined();
    expect(pricing.free).toBeDefined();
    expect(pricing.starter).toBeDefined();
    expect(pricing.pro).toBeDefined();
    expect(pricing.enterprise).toBeDefined();
    expect(pricing.free.priceUSD).toBe(0);
    expect(pricing.starter.priceUSD).toBe(19);
  });

  test('loadPricingFromFirestore: con datos en Firestore usa esos datos', async () => {
    mock.store.global_pricing = {
      starter: { priceUSD: 25, messagesPerDay: 800, broadcastsPerDay: 5, contacts: 600 },
    };
    invalidateCache();
    const pricing = await loadPricingFromFirestore();
    expect(pricing.starter.priceUSD).toBe(25);
    expect(pricing.starter.messagesPerDay).toBe(800);
  });

  test('loadPricingFromFirestore: usa cache si es valida (segunda llamada no va a Firestore)', async () => {
    await loadPricingFromFirestore();
    // Modificar store despues de cargar cache no afecta resultado
    mock.store.global_pricing = { starter: { priceUSD: 999, messagesPerDay: 1, broadcastsPerDay: 0, contacts: 1 } };
    const pricing = await loadPricingFromFirestore();
    // Si cache es valida, no lee el nuevo valor
    expect(pricing.starter.priceUSD).not.toBe(999);
  });

  test('invalidateCache: limpia cache y fuerza recarga', async () => {
    await loadPricingFromFirestore();
    mock.store.global_pricing = { starter: { priceUSD: 99, messagesPerDay: 500, broadcastsPerDay: 2, contacts: 500 } };
    invalidateCache();
    const pricing = await loadPricingFromFirestore();
    expect(pricing.starter.priceUSD).toBe(99);
  });

  // getPlanPrice

  test('getPlanPrice: lanza error para plan invalido', async () => {
    await expect(getPlanPrice('ultramax', 'AR')).rejects.toThrow('plan invalido');
  });

  test('getPlanPrice: free plan AR → ARS con features correctas', async () => {
    const result = await getPlanPrice('free', 'AR');
    expect(result.plan).toBe('free');
    expect(result.currency).toBe('ARS');
    expect(result.priceUSD).toBe(0);
    expect(result.features.messagesPerDay).toBe(50);
    expect(result.features.contacts).toBe(100);
    expect(result.countryCode).toBe('AR');
  });

  test('getPlanPrice: starter plan CO → COP', async () => {
    const result = await getPlanPrice('starter', 'CO');
    expect(result.currency).toBe('COP');
    expect(result.priceUSD).toBe(19);
  });

  test('getPlanPrice: pro plan US → USD', async () => {
    const result = await getPlanPrice('pro', 'US');
    expect(result.currency).toBe('USD');
    expect(result.priceUSD).toBe(49);
    expect(result.features.messagesPerDay).toBe(5000);
  });

  test('getPlanPrice: enterprise plan retorna features maximas', async () => {
    const result = await getPlanPrice('enterprise', 'US');
    expect(result.priceUSD).toBe(149);
    expect(result.features.messagesPerDay).toBe(50000);
    expect(result.features.contacts).toBe(50000);
    expect(result.features.broadcastsPerDay).toBe(100);
  });

  test('getPlanPrice: localPrice es null cuando no hay precio local en Firestore', async () => {
    const result = await getPlanPrice('starter', 'AR');
    // Sin datos en Firestore, localPrice sera null (no hay priceARS en DEFAULT_PLANS)
    expect(result.localPrice).toBeNull();
  });

  // getAllPlans

  test('getAllPlans: retorna todos los 4 planes', async () => {
    const plans = await getAllPlans('AR');
    expect(Object.keys(plans).length).toBe(4);
    expect(plans.free).toBeDefined();
    expect(plans.starter).toBeDefined();
    expect(plans.pro).toBeDefined();
    expect(plans.enterprise).toBeDefined();
  });

  test('getAllPlans: cada plan tiene currency ARS para AR', async () => {
    const plans = await getAllPlans('AR');
    Object.values(plans).forEach(p => {
      expect(p.currency).toBe('ARS');
    });
  });

  test('getAllPlans: cada plan tiene objeto features', async () => {
    const plans = await getAllPlans('CO');
    Object.values(plans).forEach(p => {
      expect(p.features).toBeDefined();
      expect(typeof p.features.messagesPerDay).toBe('number');
    });
  });

  // savePlanPricing

  test('savePlanPricing: lanza error para plan invalido', async () => {
    await expect(savePlanPricing('ultra', { priceUSD: 99 })).rejects.toThrow('plan invalido');
  });

  test('savePlanPricing: lanza error si priceData falta', async () => {
    await expect(savePlanPricing('pro', null)).rejects.toThrow('priceData requerido');
  });

  test('savePlanPricing: lanza error si priceUSD negativo', async () => {
    await expect(savePlanPricing('pro', { priceUSD: -10 })).rejects.toThrow('priceUSD debe ser numero >= 0');
  });

  test('savePlanPricing: guarda plan y invalida cache', async () => {
    await savePlanPricing('starter', { priceUSD: 25, messagesPerDay: 800, broadcastsPerDay: 5, contacts: 600 });
    const stored = mock.store.global_pricing['starter'];
    expect(stored.priceUSD).toBe(25);
    expect(stored.updatedAt).toBeDefined();
    // Cache fue invalidada, proxima carga lee el nuevo valor
    const pricing = await loadPricingFromFirestore();
    expect(pricing.starter.priceUSD).toBe(25);
  });

  test('savePlanPricing: priceUSD=0 es valido (plan free)', async () => {
    await expect(savePlanPricing('free', { priceUSD: 0 })).resolves.not.toThrow();
  });

  // Constantes

  test('SUPPORTED_CURRENCIES es frozen con 7 monedas', () => {
    expect(Object.isFrozen(SUPPORTED_CURRENCIES)).toBe(true);
    expect(SUPPORTED_CURRENCIES.length).toBe(7);
    ['USD','ARS','COP','MXN','CLP','PEN','BRL'].forEach(c => {
      expect(SUPPORTED_CURRENCIES).toContain(c);
    });
  });

  test('DEFAULT_PLANS es frozen con 4 planes y precios correctos', () => {
    expect(Object.isFrozen(DEFAULT_PLANS)).toBe(true);
    expect(DEFAULT_PLANS.free.priceUSD).toBe(0);
    expect(DEFAULT_PLANS.starter.priceUSD).toBe(19);
    expect(DEFAULT_PLANS.pro.priceUSD).toBe(49);
    expect(DEFAULT_PLANS.enterprise.priceUSD).toBe(149);
  });

  test('PLAN_NAMES es frozen con 4 nombres', () => {
    expect(Object.isFrozen(PLAN_NAMES)).toBe(true);
    expect(PLAN_NAMES.length).toBe(4);
    ['free','starter','pro','enterprise'].forEach(p => {
      expect(PLAN_NAMES).toContain(p);
    });
  });

  test('COUNTRY_CURRENCY_MAP mapea paises correctamente', () => {
    expect(COUNTRY_CURRENCY_MAP['AR']).toBe('ARS');
    expect(COUNTRY_CURRENCY_MAP['CO']).toBe('COP');
    expect(COUNTRY_CURRENCY_MAP['DEFAULT']).toBe('USD');
  });

  test('CACHE_TTL_MS es 5 minutos en ms', () => {
    expect(CACHE_TTL_MS).toBe(5 * 60 * 1000);
  });
});
