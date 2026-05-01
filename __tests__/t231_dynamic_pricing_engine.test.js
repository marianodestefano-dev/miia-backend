'use strict';

const {
  getPlanPrice, getAllPlans, savePlanPricing, comparePlans, recommendPlan,
  loadPricingFromFirestore, getCurrencyForCountry, isValidPlan, isValidCurrency,
  invalidateCache,
  SUPPORTED_CURRENCIES, DEFAULT_PLANS, PLAN_NAMES, CACHE_TTL_MS, COUNTRY_CURRENCY_MAP,
  __setFirestoreForTests,
} = require('../core/dynamic_pricing_engine');

function makeMockDb({ docs = [], throwGet = false, throwSet = false } = {}) {
  const docsMap = {};
  docs.forEach(d => { docsMap[d.id] = d; });
  return {
    collection: () => ({
      get: async () => {
        if (throwGet) throw new Error('get error');
        const items = Object.entries(docsMap).map(([id, data]) => ({ id, data: () => data }));
        return { forEach: fn => items.forEach(fn) };
      },
      doc: (id) => ({
        set: async (data, opts) => {
          if (throwSet) throw new Error('set error');
          docsMap[id] = data;
        },
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); invalidateCache(); });
afterEach(() => { __setFirestoreForTests(null); invalidateCache(); });

describe('Constantes', () => {
  test('SUPPORTED_CURRENCIES tiene 7 monedas', () => { expect(SUPPORTED_CURRENCIES.length).toBe(7); });
  test('frozen SUPPORTED_CURRENCIES', () => { expect(() => { SUPPORTED_CURRENCIES.push('EUR'); }).toThrow(); });
  test('PLAN_NAMES tiene 4 planes', () => { expect(PLAN_NAMES.length).toBe(4); });
  test('DEFAULT_PLANS tiene free/starter/pro/enterprise', () => {
    expect(DEFAULT_PLANS.free).toBeDefined();
    expect(DEFAULT_PLANS.starter).toBeDefined();
    expect(DEFAULT_PLANS.pro).toBeDefined();
    expect(DEFAULT_PLANS.enterprise).toBeDefined();
  });
  test('precios crecientes free < starter < pro < enterprise', () => {
    expect(DEFAULT_PLANS.free.priceUSD).toBeLessThan(DEFAULT_PLANS.starter.priceUSD);
    expect(DEFAULT_PLANS.starter.priceUSD).toBeLessThan(DEFAULT_PLANS.pro.priceUSD);
    expect(DEFAULT_PLANS.pro.priceUSD).toBeLessThan(DEFAULT_PLANS.enterprise.priceUSD);
  });
  test('CACHE_TTL_MS es 5 minutos', () => { expect(CACHE_TTL_MS).toBe(5 * 60 * 1000); });
});

describe('isValidPlan e isValidCurrency', () => {
  test('free es plan valido', () => { expect(isValidPlan('free')).toBe(true); });
  test('enterprise es plan valido', () => { expect(isValidPlan('enterprise')).toBe(true); });
  test('premium no es plan valido', () => { expect(isValidPlan('premium')).toBe(false); });
  test('USD es moneda valida', () => { expect(isValidCurrency('USD')).toBe(true); });
  test('EUR no es moneda valida', () => { expect(isValidCurrency('EUR')).toBe(false); });
});

describe('getCurrencyForCountry', () => {
  test('AR retorna ARS', () => { expect(getCurrencyForCountry('AR')).toBe('ARS'); });
  test('CO retorna COP', () => { expect(getCurrencyForCountry('CO')).toBe('COP'); });
  test('MX retorna MXN', () => { expect(getCurrencyForCountry('MX')).toBe('MXN'); });
  test('US retorna USD', () => { expect(getCurrencyForCountry('US')).toBe('USD'); });
  test('pais desconocido retorna USD', () => { expect(getCurrencyForCountry('ZZ')).toBe('USD'); });
});

describe('loadPricingFromFirestore', () => {
  test('retorna DEFAULT_PLANS si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await loadPricingFromFirestore();
    expect(r.free).toBeDefined();
    expect(r.starter).toBeDefined();
  });
  test('retorna DEFAULT_PLANS si coleccion vacia', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await loadPricingFromFirestore();
    expect(r.free).toBeDefined();
  });
  test('carga datos personalizados de Firestore', async () => {
    const docs = [{ id: 'pro', priceUSD: 59, messagesPerDay: 6000, broadcastsPerDay: 15, contacts: 6000 }];
    __setFirestoreForTests(makeMockDb({ docs }));
    const r = await loadPricingFromFirestore();
    expect(r.pro.priceUSD).toBe(59);
  });
});

describe('getPlanPrice', () => {
  test('lanza si plan invalido', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    await expect(getPlanPrice('premium', 'AR')).rejects.toThrow('plan invalido');
  });
  test('retorna precio con currency correcta para AR', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getPlanPrice('starter', 'AR');
    expect(r.plan).toBe('starter');
    expect(r.currency).toBe('ARS');
    expect(r.priceUSD).toBe(DEFAULT_PLANS.starter.priceUSD);
  });
  test('retorna features del plan', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getPlanPrice('pro', 'CO');
    expect(r.features.messagesPerDay).toBeGreaterThan(0);
    expect(r.features.contacts).toBeGreaterThan(0);
  });
  test('free tiene priceUSD 0', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getPlanPrice('free');
    expect(r.priceUSD).toBe(0);
  });
});

describe('getAllPlans', () => {
  test('retorna los 4 planes', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getAllPlans('MX');
    expect(Object.keys(r).length).toBe(4);
    expect(r.free).toBeDefined();
    expect(r.enterprise).toBeDefined();
  });
  test('todos usan currency MXN para MX', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getAllPlans('MX');
    PLAN_NAMES.forEach(plan => { expect(r[plan].currency).toBe('MXN'); });
  });
});

describe('savePlanPricing', () => {
  test('lanza si plan invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(savePlanPricing('premium', { priceUSD: 100 })).rejects.toThrow('plan invalido');
  });
  test('lanza si priceData no es objeto', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(savePlanPricing('starter', null)).rejects.toThrow('priceData requerido');
  });
  test('lanza si priceUSD negativo', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(savePlanPricing('starter', { priceUSD: -10 })).rejects.toThrow('>= 0');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(savePlanPricing('starter', { priceUSD: 25, priceARS: 25000 })).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(savePlanPricing('starter', { priceUSD: 25 })).rejects.toThrow('set error');
  });
});

describe('comparePlans', () => {
  test('compara free vs starter', () => {
    const r = comparePlans('free', 'starter');
    expect(r.priceDiffUSD).toBeGreaterThan(0);
    expect(r.upgradeRecommended).toBe(true);
    expect(r.messagesDiff).toBeGreaterThan(0);
  });
  test('retorna null si plan invalido', () => {
    expect(comparePlans('free', 'premium')).toBeNull();
  });
});

describe('recommendPlan', () => {
  test('retorna free para uso bajo', () => {
    expect(recommendPlan({ avgMessagesPerDay: 10, totalContacts: 50 })).toBe('free');
  });
  test('retorna starter para uso medio', () => {
    expect(recommendPlan({ avgMessagesPerDay: 100, totalContacts: 200 })).toBe('starter');
  });
  test('retorna pro para uso alto', () => {
    expect(recommendPlan({ avgMessagesPerDay: 2000, totalContacts: 2000 })).toBe('pro');
  });
  test('retorna enterprise para uso muy alto', () => {
    expect(recommendPlan({ avgMessagesPerDay: 10000, totalContacts: 10000 })).toBe('enterprise');
  });
  test('retorna free si no hay stats', () => {
    expect(recommendPlan(null)).toBe('free');
  });
});
