'use strict';

jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));

let pm;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
  jest.mock('../core/pricing_calculator', () => ({
    PLANS: { starter: { priceUSD: 49 }, enterprise: { priceUSD: null } },
    COUNTRY_MULTIPLIERS: { CO: 1.0, default: 1.0 },
  }));
  pm = require('../core/pricing_manager');
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (pm) pm.clearCacheForTests();
  jest.restoreAllMocks();
});

function makeDb({ globalExists = true, bizExists = true, globalData = null, bizData = null, throwOn = null } = {}) {
  const docMock = jest.fn().mockImplementation((path) => {
    const get = jest.fn().mockImplementation(() => {
      if (throwOn && path.includes(throwOn)) return Promise.reject(new Error('db error'));
      if (path === 'settings/pricing') {
        return Promise.resolve({ exists: globalExists, data: () => globalData || { plans: { s: 1 } } });
      }
      return Promise.resolve({ exists: bizExists, data: () => bizData || { custom_plan: 'gold' } });
    });
    const set = jest.fn().mockResolvedValue({});
    return { get, set };
  });
  return { doc: docMock };
}

describe('PB2 -- getGlobalPricing', () => {
  test('doc existe -> source=firestore', async () => {
    pm.__setFirestoreForTests(makeDb({ globalExists: true }));
    const r = await pm.getGlobalPricing();
    expect(r.source).toBe('firestore');
  });

  test('doc no existe -> fallback hardcoded (source=hardcoded)', async () => {
    pm.__setFirestoreForTests(makeDb({ globalExists: false }));
    const r = await pm.getGlobalPricing();
    expect(r.source).toBe('hardcoded');
    expect(r.plans).toBeDefined();
  });

  test('segunda llamada -> cache hit (doc.get llamado 1 sola vez)', async () => {
    const db = makeDb({ globalExists: true });
    pm.__setFirestoreForTests(db);
    await pm.getGlobalPricing();
    await pm.getGlobalPricing();
    const calls = db.doc.mock.calls.filter(c => c[0] === 'settings/pricing');
    expect(calls.length).toBe(1);
  });

  test('db lanza error -> source=fallback_error', async () => {
    pm.__setFirestoreForTests(makeDb({ throwOn: 'settings/pricing' }));
    const r = await pm.getGlobalPricing();
    expect(r.source).toBe('fallback_error');
    expect(console.error).toHaveBeenCalled();
  });
});

describe('PB2 -- getPricingForBiz', () => {
  test('bizId null -> lanza error', async () => {
    pm.__setFirestoreForTests(makeDb());
    await expect(pm.getPricingForBiz(null)).rejects.toThrow('bizId requerido');
  });

  test('doc existe -> custom=true, source=firestore', async () => {
    pm.__setFirestoreForTests(makeDb({ bizExists: true }));
    const r = await pm.getPricingForBiz('biz123');
    expect(r.custom).toBe(true);
    expect(r.bizId).toBe('biz123');
    expect(r.source).toBe('firestore');
  });

  test('doc no existe -> fallback global, custom=false', async () => {
    pm.__setFirestoreForTests(makeDb({ bizExists: false, globalExists: true }));
    const r = await pm.getPricingForBiz('biz456');
    expect(r.custom).toBe(false);
    expect(r.bizId).toBe('biz456');
  });

  test('segunda llamada mismo bizId -> cache hit', async () => {
    const db = makeDb({ bizExists: true });
    pm.__setFirestoreForTests(db);
    await pm.getPricingForBiz('bizXYZ');
    await pm.getPricingForBiz('bizXYZ');
    const bizCalls = db.doc.mock.calls.filter(c => c[0] && c[0].includes('bizXYZ'));
    expect(bizCalls.length).toBe(1);
  });

  test('db lanza error -> re-throw', async () => {
    pm.__setFirestoreForTests(makeDb({ throwOn: 'businesses' }));
    await expect(pm.getPricingForBiz('bad')).rejects.toThrow('db error');
    expect(console.error).toHaveBeenCalled();
  });
});

describe('PB2 -- setPricingForBiz', () => {
  test('bizId null -> lanza error', async () => {
    pm.__setFirestoreForTests(makeDb());
    await expect(pm.setPricingForBiz(null, { x: 1 })).rejects.toThrow('bizId requerido');
  });

  test('pricingData null -> lanza error', async () => {
    pm.__setFirestoreForTests(makeDb());
    await expect(pm.setPricingForBiz('biz1', null)).rejects.toThrow('pricingData invalido');
  });

  test('pricingData string -> lanza error (typeof !== object)', async () => {
    pm.__setFirestoreForTests(makeDb());
    await expect(pm.setPricingForBiz('biz1', 'string-invalido')).rejects.toThrow('pricingData invalido');
  });

  test('datos validos -> guarda + invalida cache', async () => {
    const db = makeDb();
    pm.__setFirestoreForTests(db);
    const r = await pm.setPricingForBiz('biz1', { plan: 'gold' });
    expect(r.success).toBe(true);
    expect(r.bizId).toBe('biz1');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('biz1'));
  });

  test('db.set lanza error -> re-throw + console.error', async () => {
    const db = {
      doc: jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue({ exists: true, data: () => ({}) }),
        set: jest.fn().mockRejectedValue(new Error('set fail')),
      }),
    };
    pm.__setFirestoreForTests(db);
    await expect(pm.setPricingForBiz('biz1', { x: 1 })).rejects.toThrow('set fail');
    expect(console.error).toHaveBeenCalled();
  });
});

describe('PB2 -- setGlobalPricing', () => {
  test('pricingData null -> lanza error', async () => {
    pm.__setFirestoreForTests(makeDb());
    await expect(pm.setGlobalPricing(null)).rejects.toThrow('pricingData invalido');
  });

  test('datos validos -> guarda + log', async () => {
    const db = makeDb();
    pm.__setFirestoreForTests(db);
    const r = await pm.setGlobalPricing({ plans: { starter: { priceUSD: 59 } } });
    expect(r.success).toBe(true);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('global'));
  });

  test('db.set lanza error -> re-throw', async () => {
    const db = {
      doc: jest.fn().mockReturnValue({
        set: jest.fn().mockRejectedValue(new Error('set fail global')),
      }),
    };
    pm.__setFirestoreForTests(db);
    await expect(pm.setGlobalPricing({ plans: {} })).rejects.toThrow('set fail global');
  });
});

describe('PB2 -- getPricingByCountry', () => {
  test('pricing null -> null (branch !pricing truthy)', () => {
    expect(pm.getPricingByCountry(null, 'CO')).toBeNull();
  });

  test('country_rules[country] existe -> retorna regla custom', () => {
    const p = { country_rules: { CO: { multiplier: 1.2, currency: 'COP' } } };
    expect(pm.getPricingByCountry(p, 'CO')).toEqual({ multiplier: 1.2, currency: 'COP' });
  });

  test('sin regla + country_multipliers[country] existe -> usa ese mult', () => {
    const p = { country_rules: {}, country_multipliers: { AR: 0.8, default: 1.0 } };
    expect(pm.getPricingByCountry(p, 'AR')).toEqual({ multiplier: 0.8 });
  });

  test('sin regla + country_multipliers[country] undefined -> usa default', () => {
    const p = { country_rules: {}, country_multipliers: { default: 1.0 } };
    expect(pm.getPricingByCountry(p, 'ZZ')).toEqual({ multiplier: 1.0 });
  });

  test('sin country_multipliers -> {multiplier: 1.0} (branch mult falsy)', () => {
    const p = { country_rules: {} };
    expect(pm.getPricingByCountry(p, 'CO')).toEqual({ multiplier: 1.0 });
  });
});

describe('PB2 -- invalidateCache', () => {
  test('invalidateCache con key -> solo esa key eliminada', async () => {
    const db = makeDb({ globalExists: true });
    pm.__setFirestoreForTests(db);
    await pm.getGlobalPricing();
    pm.invalidateCache('__global__');
    await pm.getGlobalPricing();
    const calls = db.doc.mock.calls.filter(c => c[0] === 'settings/pricing');
    expect(calls.length).toBe(2);
  });

  test('invalidateCache sin key -> limpia todo', async () => {
    const db = makeDb({ globalExists: true });
    pm.__setFirestoreForTests(db);
    await pm.getGlobalPricing();
    pm.invalidateCache();
    await pm.getGlobalPricing();
    const calls = db.doc.mock.calls.filter(c => c[0] === 'settings/pricing');
    expect(calls.length).toBe(2);
  });
});

describe('PB2 -- constantes exportadas', () => {
  test('CACHE_TTL_MS = 5 minutos', () => {
    expect(pm.CACHE_TTL_MS).toBe(5 * 60 * 1000);
  });
  test('GLOBAL_PRICING_DOC = settings/pricing', () => {
    expect(pm.GLOBAL_PRICING_DOC).toBe('settings/pricing');
  });
});
