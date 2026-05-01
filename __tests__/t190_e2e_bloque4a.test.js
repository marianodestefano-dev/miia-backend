'use strict';

/**
 * T190 - Tests E2E Bloque 4A (T181-T189)
 * Flujos combinados: pagos, analytics, reputacion, handoff, growth.
 */

const { isPaymentApproved } = require('../core/mercadopago_v2');
const { isPaymentSucceeded } = require('../core/stripe_handler');
const { normalizeWooProduct, normalizeShopifyProduct } = require('../core/ecommerce_connector');
const { getInactiveContacts } = require('../core/growth_tools');
const { buildOOOResponse } = require('../core/out_of_office');
const { buildReviewRequestMessage, parseRatingFromText } = require('../core/reputation_manager');
const { detectLanguage } = require('../core/language_detector');

const NOW = new Date('2026-05-04T15:00:00.000Z').getTime();

describe('E2E: Flujo de pagos multi-plataforma', () => {
  test('MP isPaymentApproved cubre todos los estados', () => {
    expect(isPaymentApproved('approved')).toBe(true);
    expect(isPaymentApproved('pending')).toBe(false);
    expect(isPaymentApproved('rejected')).toBe(false);
    expect(isPaymentApproved('cancelled')).toBe(false);
  });

  test('Stripe isPaymentSucceeded cubre todos los estados', () => {
    expect(isPaymentSucceeded('succeeded')).toBe(true);
    expect(isPaymentSucceeded('processing')).toBe(false);
    expect(isPaymentSucceeded('canceled')).toBe(false);
    expect(isPaymentSucceeded('requires_payment_method')).toBe(false);
  });
});

describe('E2E: Flujo ecommerce normalizacion', () => {
  test('normaliza producto WooCommerce con todos los campos', () => {
    const woo = {
      id: 1, name: 'Remera Basica', short_description: 'Algodón 100%',
      price: '1500', regular_price: '2000', sale_price: '1500',
      sku: 'REM001', stock_quantity: 10, in_stock: true,
      categories: [{ name: 'Ropa' }, { name: 'Basico' }],
      images: [{ src: 'https://img1.jpg' }, { src: 'https://img2.jpg' }],
    };
    const p = normalizeWooProduct(woo);
    expect(p.platform).toBe('woocommerce');
    expect(p.price).toBe(1500);
    expect(p.regularPrice).toBe(2000);
    expect(p.categories).toHaveLength(2);
    expect(p.inStock).toBe(true);
    expect(p.sourceId).toBe('1');
  });

  test('normaliza producto Shopify con variante', () => {
    const shopify = {
      id: 9876, title: 'Premium Shirt',
      body_html: '<p>High quality</p>',
      variants: [{ price: '49.99', compare_at_price: '69.99', sku: 'PS001', inventory_quantity: 5 }],
      product_type: 'Apparel',
      images: [{ src: 'https://img.jpg' }],
    };
    const p = normalizeShopifyProduct(shopify);
    expect(p.platform).toBe('shopify');
    expect(p.price).toBe(49.99);
    expect(p.regularPrice).toBe(69.99);
    expect(p.description).toBe('High quality');
    expect(p.categories).toContain('Apparel');
  });

  test('ambas normalizaciones generan sourceId string', () => {
    const woo = normalizeWooProduct({ id: 42, name: 'Test' });
    const shop = normalizeShopifyProduct({ id: 99, title: 'Test' });
    expect(typeof woo.sourceId).toBe('string');
    expect(typeof shop.sourceId).toBe('string');
  });
});

describe('E2E: Flujo reviews y reputacion', () => {
  test('pipeline completo: idioma -> solicitud review -> parse rating', () => {
    const leadMsg = 'hello how are you good morning what is the price please';
    const { language } = detectLanguage(leadMsg);

    const requestMsg = buildReviewRequestMessage(language);
    expect(requestMsg).toBeDefined();
    expect(requestMsg.length).toBeGreaterThan(0);

    const leadResponse = 'I give it a 5 stars';
    const rating = parseRatingFromText(leadResponse);
    expect(rating).toBe(5);
  });

  test('parsea varios formatos de rating en espanol', () => {
    expect(parseRatingFromText('Le doy un 4 de 5')).toBe(4);
    expect(parseRatingFromText('Mi nota: 3')).toBe(3);
    expect(parseRatingFromText('Excelente, merece un 5!')).toBe(5);
    expect(parseRatingFromText('Bueno')).toBeNull();
  });

  test('mensaje de review en ingles es diferente al espanol', () => {
    const es = buildReviewRequestMessage('es');
    const en = buildReviewRequestMessage('en');
    expect(es).not.toBe(en);
  });
});

describe('E2E: Flujo growth y reactivacion', () => {
  test('identifica correctamente inactivos vs activos', () => {
    const contacts = [
      { phone: '+1', lastContactAt: new Date(NOW - 60 * 24 * 60 * 60 * 1000).toISOString() },
      { phone: '+2', lastContactAt: new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString() },
      { phone: '+3', lastContactAt: new Date(NOW - 35 * 24 * 60 * 60 * 1000).toISOString() },
      { phone: '+4' },
    ];
    const inactive = getInactiveContacts(contacts, 30, NOW);
    expect(inactive.length).toBe(2);
    expect(inactive.map(c => c.phone)).toEqual(expect.arrayContaining(['+1', '+3']));
  });

  test('umbral de reactivacion configurable', () => {
    const contacts = [
      { phone: '+1', lastContactAt: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString() },
    ];
    expect(getInactiveContacts(contacts, 7, NOW).length).toBe(1);
    expect(getInactiveContacts(contacts, 30, NOW).length).toBe(0);
  });
});

describe('E2E: Flujo OOO + handoff integration', () => {
  test('OOO response incluye mensaje y opcionalmente fecha', () => {
    const r1 = buildOOOResponse({ active: true, message: 'Estoy viajando.' }, {});
    expect(r1).toBe('Estoy viajando.');

    const returnAt = new Date(NOW + 2 * 60 * 60 * 1000).toISOString();
    const r2 = buildOOOResponse({ active: true, message: 'Fuera.', returnAt }, {});
    expect(r2).toContain('Fuera.');
    expect(r2).toContain('disponible');
  });

  test('OOO falla correctamente para estado inactivo', () => {
    expect(() => buildOOOResponse({ active: false }, {})).toThrow('no esta activo');
    expect(() => buildOOOResponse(null, {})).toThrow('oooState requerido');
  });
});
