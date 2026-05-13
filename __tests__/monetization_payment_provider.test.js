/**
 * Tests lib/monetization/payment-provider.js — selector + factory.
 *
 * Coverage objetivo 100% branches (regla Mariano 2026-05-02 supersede 95.65%).
 * Patron Jest miia-backend (--coverageProvider=babel).
 */

'use strict';

const pp = require('../lib/monetization/payment-provider');

describe('payment-provider — selectProvider (country routing)', () => {
  test('LATAM core countries → mercadopago', () => {
    expect(pp.selectProvider('AR')).toBe('mercadopago');
    expect(pp.selectProvider('BR')).toBe('mercadopago');
    expect(pp.selectProvider('CL')).toBe('mercadopago');
    expect(pp.selectProvider('CO')).toBe('mercadopago');
    expect(pp.selectProvider('MX')).toBe('mercadopago');
    expect(pp.selectProvider('PE')).toBe('mercadopago');
    expect(pp.selectProvider('UY')).toBe('mercadopago');
  });

  test('países explícitos PayPal', () => {
    expect(pp.selectProvider('US')).toBe('paypal');
    expect(pp.selectProvider('ES')).toBe('paypal');
    expect(pp.selectProvider('GB')).toBe('paypal');
    expect(pp.selectProvider('DE')).toBe('paypal');
    expect(pp.selectProvider('FR')).toBe('paypal');
    expect(pp.selectProvider('IT')).toBe('paypal');
  });

  test('country code desconocido → paypal default', () => {
    expect(pp.selectProvider('JP')).toBe('paypal');
    expect(pp.selectProvider('ZZ')).toBe('paypal');
    expect(pp.selectProvider('XX')).toBe('paypal');
  });

  test('country code en minúsculas → uppercase normalizado', () => {
    expect(pp.selectProvider('ar')).toBe('mercadopago');
    expect(pp.selectProvider('us')).toBe('paypal');
  });

  test('country code más largo que 2 → slice(0,2)', () => {
    expect(pp.selectProvider('ARG')).toBe('mercadopago');
    expect(pp.selectProvider('BRA')).toBe('mercadopago');
  });

  test('country falsy → paypal fallback', () => {
    expect(pp.selectProvider(null)).toBe('paypal');
    expect(pp.selectProvider(undefined)).toBe('paypal');
    expect(pp.selectProvider('')).toBe('paypal');
    expect(pp.selectProvider(0)).toBe('paypal');
    expect(pp.selectProvider(false)).toBe('paypal');
  });

  test('country no-string → paypal fallback', () => {
    expect(pp.selectProvider(42)).toBe('paypal');
    expect(pp.selectProvider({})).toBe('paypal');
    expect(pp.selectProvider([])).toBe('paypal');
  });
});

describe('payment-provider — isProviderSupported', () => {
  test('providers válidos', () => {
    expect(pp.isProviderSupported('mercadopago')).toBe(true);
    expect(pp.isProviderSupported('paypal')).toBe(true);
  });

  test('providers no soportados', () => {
    expect(pp.isProviderSupported('stripe')).toBe(false);
    expect(pp.isProviderSupported('paddle')).toBe(false);
    expect(pp.isProviderSupported('')).toBe(false);
    expect(pp.isProviderSupported(null)).toBe(false);
  });
});

describe('payment-provider — getPaymentProvider factory', () => {
  test('AR → módulo mercadopago', () => {
    const provider = pp.getPaymentProvider('AR');
    expect(provider.name).toBe('mercadopago');
    expect(typeof provider.createCheckoutSession).toBe('function');
    expect(typeof provider.verifyWebhook).toBe('function');
  });

  test('US → módulo paypal', () => {
    const provider = pp.getPaymentProvider('US');
    expect(provider.name).toBe('paypal');
    expect(typeof provider.createCheckoutSession).toBe('function');
    expect(typeof provider.verifyWebhook).toBe('function');
  });

  test('null/undefined → paypal fallback', () => {
    expect(pp.getPaymentProvider(null).name).toBe('paypal');
    expect(pp.getPaymentProvider().name).toBe('paypal');
  });

  test('country desconocido → paypal fallback', () => {
    expect(pp.getPaymentProvider('JP').name).toBe('paypal');
  });
});

describe('payment-provider — paymentProviderFor alias', () => {
  test('alias semántico = selectProvider', () => {
    expect(pp.paymentProviderFor).toBe(pp.selectProvider);
    expect(pp.paymentProviderFor('AR')).toBe('mercadopago');
    expect(pp.paymentProviderFor('US')).toBe('paypal');
  });
});

describe('payment-provider — constants exportados', () => {
  test('SUPPORTED_PROVIDERS es array frozen', () => {
    expect(Array.isArray(pp.SUPPORTED_PROVIDERS)).toBe(true);
    expect(Object.isFrozen(pp.SUPPORTED_PROVIDERS)).toBe(true);
    expect(pp.SUPPORTED_PROVIDERS).toEqual(['mercadopago', 'paypal']);
  });

  test('PROVIDER_BY_COUNTRY es objeto frozen', () => {
    expect(Object.isFrozen(pp.PROVIDER_BY_COUNTRY)).toBe(true);
    expect(pp.PROVIDER_BY_COUNTRY.AR).toBe('mercadopago');
    expect(pp.PROVIDER_BY_COUNTRY.US).toBe('paypal');
  });
});
