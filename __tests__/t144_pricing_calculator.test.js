'use strict';
const { calculatePrice, recommendPlan, PLANS, VALID_PLAN_IDS, COUNTRY_MULTIPLIERS } = require('../core/pricing_calculator');

describe('PLANS y VALID_PLAN_IDS', () => {
  test('contiene planes esperados', () => {
    expect(VALID_PLAN_IDS).toContain('starter');
    expect(VALID_PLAN_IDS).toContain('professional');
    expect(VALID_PLAN_IDS).toContain('business');
    expect(VALID_PLAN_IDS).toContain('enterprise');
  });
  test('starter tiene precio en USD', () => {
    expect(PLANS.starter.priceUSD).toBeGreaterThan(0);
  });
  test('enterprise tiene precio null', () => {
    expect(PLANS.enterprise.priceUSD).toBeNull();
  });
});

describe('calculatePrice — validacion', () => {
  test('lanza si planId invalido', () => {
    expect(() => calculatePrice('invalido')).toThrow('planId invalido');
  });
  test('enterprise retorna custom=true', () => {
    const r = calculatePrice('enterprise');
    expect(r.custom).toBe(true);
    expect(r.priceUSD).toBeNull();
  });
});

describe('calculatePrice — starter', () => {
  test('starter CO = precio base', () => {
    const r = calculatePrice('starter', 'CO');
    expect(r.total).toBe(PLANS.starter.priceUSD * COUNTRY_MULTIPLIERS.CO);
    expect(r.months).toBe(1);
  });
  test('starter AR tiene descuento por pais', () => {
    const rCO = calculatePrice('starter', 'CO');
    const rAR = calculatePrice('starter', 'AR');
    expect(rAR.total).toBeLessThan(rCO.total);
  });
  test('pais desconocido usa multiplier default 1.0', () => {
    const r = calculatePrice('starter', 'ZZ');
    expect(r.multiplier).toBe(1.0);
  });
  test('3 meses calcula total correcto', () => {
    const r = calculatePrice('professional', 'CO', { months: 3 });
    expect(r.total).toBeCloseTo(r.monthlyNet * 3, 2);
    expect(r.months).toBe(3);
  });
  test('descuento 10% se aplica', () => {
    const rSin = calculatePrice('starter', 'CO');
    const rCon = calculatePrice('starter', 'CO', { discount: 0.1 });
    expect(rCon.total).toBeLessThan(rSin.total);
    expect(rCon.discountAmount).toBeGreaterThan(0);
  });
  test('retorna features del plan', () => {
    const r = calculatePrice('business');
    expect(Array.isArray(r.features)).toBe(true);
    expect(r.features.length).toBeGreaterThan(0);
  });
  test('retorna breakdown con breakdown correcto', () => {
    const r = calculatePrice('starter', 'CO');
    expect(r.breakdown.total).toBe(r.total);
    expect(r.breakdown.months).toBe(1);
  });
});

describe('recommendPlan', () => {
  test('volumen bajo = starter', () => {
    const r = recommendPlan({ estimatedContacts: 50, estimatedMessages: 500 });
    expect(r.recommended).toBe('starter');
  });
  test('volumen medio = professional', () => {
    const r = recommendPlan({ estimatedContacts: 200, estimatedMessages: 2000 });
    expect(r.recommended).toBe('professional');
  });
  test('volumen alto = business', () => {
    const r = recommendPlan({ estimatedContacts: 1000, estimatedMessages: 10000 });
    expect(r.recommended).toBe('business');
  });
  test('volumen muy alto = enterprise', () => {
    const r = recommendPlan({ estimatedContacts: 5000 });
    expect(r.recommended).toBe('enterprise');
  });
  test('sin params = starter', () => {
    const r = recommendPlan({});
    expect(r.recommended).toBe('starter');
  });
  test('retorna reason', () => {
    const r = recommendPlan({ estimatedContacts: 200 });
    expect(typeof r.reason).toBe('string');
    expect(r.reason.length).toBeGreaterThan(0);
  });
});
