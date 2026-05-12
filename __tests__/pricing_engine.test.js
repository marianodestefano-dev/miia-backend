'use strict';

const {
  loadPricing, getPlanPrice, getRecommendedPlan,
  DEFAULT_PRICING, _invalidateCache, __setFirestoreForTests,
} = require('../core/pricing_engine');

let mockExists = true;
let mockData = null;
const mockDoc = {
  get: async () => ({ exists: mockExists, data: () => JSON.parse(JSON.stringify(mockData)) }),
};
const mockDb = { collection: () => ({ doc: () => mockDoc }) };

beforeEach(() => {
  __setFirestoreForTests(mockDb);
  mockExists = true;
  mockData = JSON.parse(JSON.stringify(DEFAULT_PRICING));
});

afterEach(() => {
  _invalidateCache();
});

describe('loadPricing', function () {
  test('cache miss + doc existe → retorna datos Firestore', async function () {
    const data = await loadPricing();
    expect(data.plans.basico.price_usd).toBe(29);
  });

  test('cache hit → retorna misma referencia', async function () {
    const first = await loadPricing();
    const second = await loadPricing();
    expect(second).toBe(first);
  });

  test('doc no existe → DEFAULT_PRICING', async function () {
    mockExists = false;
    const data = await loadPricing();
    expect(data).toEqual(DEFAULT_PRICING);
  });
});
describe('getPlanPrice', function () {
  test('plan null → throw plan_invalido', async function () {
    await expect(getPlanPrice(null, 'CO')).rejects.toThrow('plan_invalido');
  });

  test('plan invalido → throw plan_invalido', async function () {
    await expect(getPlanPrice('gold', 'CO')).rejects.toThrow('plan_invalido');
  });

  test('basico sin country → USD con iva 0', async function () {
    const r = await getPlanPrice('basico', null);
    expect(r).toEqual({ precio: 29, moneda: 'USD', iva: 0 });
  });

  test('country invalido → USD fallback', async function () {
    const r = await getPlanPrice('pro', 'XX');
    expect(r.moneda).toBe('USD');
  });

  test('basico + CO → COP con iva 0.19', async function () {
    const r = await getPlanPrice('basico', 'CO');
    expect(r.moneda).toBe('COP');
    expect(r.iva).toBe(0.19);
    expect(r.precio).toBe(Math.round(29 * 4100));
  });

  test('pro + AR → ARS con iva 0.21', async function () {
    const r = await getPlanPrice('pro', 'AR');
    expect(r.moneda).toBe('ARS');
    expect(r.iva).toBe(0.21);
  });

  test('enterprise + MX → MXN', async function () {
    const r = await getPlanPrice('enterprise', 'MX');
    expect(r.moneda).toBe('MXN');
  });

  test('enterprise + CL → CLP', async function () {
    const r = await getPlanPrice('enterprise', 'CL');
    expect(r.moneda).toBe('CLP');
  });
  test('pricing.plans falsy → DEFAULT_PRICING.plans', async function () {
    mockData = { country_rules: DEFAULT_PRICING.country_rules };
    _invalidateCache();
    const r = await getPlanPrice('enterprise', null);
    expect(r.precio).toBe(199);
  });

  test('planData no encontrado → throw plan_no_encontrado', async function () {
    mockData = { plans: { otro: { price_usd: 1 } }, country_rules: {} };
    _invalidateCache();
    await expect(getPlanPrice('basico', null)).rejects.toThrow('plan_no_encontrado');
  });

  test('planData sin price_usd → precio 0', async function () {
    mockData = { plans: { basico: {} }, country_rules: {} };
    _invalidateCache();
    const r = await getPlanPrice('basico', null);
    expect(r.precio).toBe(0);
  });

  test('country_rules ausente → cr = {} → defaults USD/0', async function () {
    mockData = { plans: DEFAULT_PRICING.plans };
    _invalidateCache();
    const r = await getPlanPrice('basico', 'CO');
    expect(r.moneda).toBe('USD');
    expect(r.iva).toBe(0);
    expect(r.precio).toBe(29);
  });

  test('cc no en country_rules → cr = {} → defaults', async function () {
    mockData = { plans: DEFAULT_PRICING.plans, country_rules: { MX: DEFAULT_PRICING.country_rules.MX } };
    _invalidateCache();
    const r = await getPlanPrice('basico', 'CO');
    expect(r.moneda).toBe('USD');
    expect(r.precio).toBe(29);
  });

  test('cr sin usd_rate → rate=1', async function () {
    mockData = { plans: { basico: { price_usd: 50 } }, country_rules: { CO: { currency: 'COP', iva: 0.19 } } };
    _invalidateCache();
    const r = await getPlanPrice('basico', 'CO');
    expect(r.precio).toBe(50);
  });

  test('cr sin currency → DEFAULT_CURRENCY', async function () {
    mockData = { plans: { basico: { price_usd: 50 } }, country_rules: { CO: { usd_rate: 2, iva: 0.1 } } };
    _invalidateCache();
    const r = await getPlanPrice('basico', 'CO');
    expect(r.moneda).toBe('USD');
  });

  test('cr.iva undefined → DEFAULT_IVA (0)', async function () {
    mockData = { plans: { basico: { price_usd: 50 } }, country_rules: { CO: { currency: 'COP', usd_rate: 100 } } };
    _invalidateCache();
    const r = await getPlanPrice('basico', 'CO');
    expect(r.iva).toBe(0);
  });
});
describe('getRecommendedPlan', function () {
  test('citas > 500 → enterprise', function () {
    expect(getRecommendedPlan('medico', 600)).toBe('enterprise');
  });

  test('type enterprise (citas <= 500) → enterprise', function () {
    expect(getRecommendedPlan('enterprise', 10)).toBe('enterprise');
  });

  test('type corporativo (citas <= 500) → enterprise', function () {
    expect(getRecommendedPlan('corporativo', 50)).toBe('enterprise');
  });

  test('citas > 100 (no enterprise) → pro', function () {
    expect(getRecommendedPlan('medico', 150)).toBe('pro');
  });

  test('type clinica (citas <= 100) → pro', function () {
    expect(getRecommendedPlan('clinica', 10)).toBe('pro');
  });

  test('type hotel (citas <= 100) → pro', function () {
    expect(getRecommendedPlan('hotel', 10)).toBe('pro');
  });

  test('type gimnasio (citas <= 100) → pro', function () {
    expect(getRecommendedPlan('gimnasio', 10)).toBe('pro');
  });

  test('default → basico', function () {
    expect(getRecommendedPlan('tienda', 10)).toBe('basico');
  });

  test('citasMes null → parseInt NaN → || 0 → basico', function () {
    expect(getRecommendedPlan('tienda', null)).toBe('basico');
  });

  test('businessType null → empty string fallback', function () {
    expect(getRecommendedPlan(null, 50)).toBe('basico');
  });
});
