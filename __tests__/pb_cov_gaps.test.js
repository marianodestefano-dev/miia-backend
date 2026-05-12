'use strict';

/**
 * COV gaps — PB.1-4 branch coverage complement
 */

const { getPricingByCountry, __setFirestoreForTests: setPricingDb } = require('../core/pricing_manager');

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

afterEach(() => {
  setPricingDb(null);
  jest.clearAllMocks();
});

describe('PB.2 pricing_manager: getPricingByCountry branch gaps', () => {
  test('rules[country] existe => retorna ese rule directamente', () => {
    // Covers line 123 true branch: if (rules[country]) return rules[country]
    const pricing = {
      country_rules: { CO: { price: 10, currency: 'COP' } },
      country_multipliers: {},
    };
    const result = getPricingByCountry(pricing, 'CO');
    expect(result).toEqual({ price: 10, currency: 'COP' });
  });

  test('sin country_multipliers => mult falso => multiplier=1.0', () => {
    // Covers line 126 false branch: mult ? ... : 1.0 (mult is undefined)
    const pricing = {
      country_rules: {},
      // no country_multipliers
    };
    const result = getPricingByCountry(pricing, 'AR');
    expect(result.multiplier).toBe(1.0);
  });

  test('country_multipliers.country no existe => usa default || 1.0', () => {
    // Covers mult[country] || mult.default || 1.0 when both are missing
    const pricing = {
      country_rules: {},
      country_multipliers: { default: 1.2 },
    };
    const result = getPricingByCountry(pricing, 'XX');
    expect(result.multiplier).toBe(1.2);
  });

  test('country_multipliers sin default y sin country => 1.0', () => {
    // mult[country] is undefined, mult.default is undefined -> 1.0
    const pricing = {
      country_rules: {},
      country_multipliers: { BR: 0.9 }, // country is 'XX', not 'BR'
    };
    const result = getPricingByCountry(pricing, 'XX');
    expect(result.multiplier).toBe(1.0);
  });

  test('sin country_rules => usa {} (branch || {} fires)', () => {
    // pricing.country_rules is undefined -> || {} takes the right side (line 123 false branch)
    const pricing = {
      // no country_rules field
      country_multipliers: { default: 1.5 },
    };
    const result = getPricingByCountry(pricing, 'XX');
    // rules = {}, rules['XX'] is undefined -> falls through to mult branch
    expect(result.multiplier).toBe(1.5);
  });
});
