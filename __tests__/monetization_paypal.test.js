/**
 * Tests lib/monetization/providers/paypal.js — 100% branches.
 *
 * Estrategia: inyección _overrideSDKForTest con mocks PayPal SDK.
 * Cubre: createCheckoutSession (happy + SDK fail), getPaymentDetails,
 * verifyWebhook (todas las ramas defensive).
 */

'use strict';

const pp = require('../lib/monetization/providers/paypal');

beforeEach(() => {
  pp._overrideSDKForTest(null);
});

afterAll(() => {
  pp._overrideSDKForTest(null);
});

describe('paypal — _isSDKInstalled', () => {
  test('detecta SDK instalado (default)', () => {
    expect(pp._isSDKInstalled()).toBe(true);
  });

  test('override = false', () => {
    pp._overrideSDKForTest({ sdkInstalled: false });
    expect(pp._isSDKInstalled()).toBe(false);
  });

  test('override = true', () => {
    pp._overrideSDKForTest({ sdkInstalled: true });
    expect(pp._isSDKInstalled()).toBe(true);
  });
});

describe('paypal — createCheckoutSession happy path', () => {
  function makeMockSdk(approveHref = 'https://paypal.test/approve/order-xyz') {
    return {
      sdk: {
        orders: {
          OrdersCreateRequest: function () {
            this.prefer = jest.fn();
            this.requestBody = jest.fn();
          },
        },
        core: {
          SandboxEnvironment: function () {},
          LiveEnvironment: function () {},
          PayPalHttpClient: function () {},
        },
      },
      client: {
        execute: jest.fn(async () => ({
          result: {
            id: 'order-xyz',
            links: approveHref ? [{ rel: 'approve', href: approveHref }] : [],
          },
        })),
      },
    };
  }

  test('happy path retorna checkoutUrl + orderId', async () => {
    process.env.API_URL = 'https://api.test';
    process.env.PAYPAL_MODE = 'sandbox';
    pp._overrideSDKForTest(makeMockSdk());

    const r = await pp.createCheckoutSession({
      uid: 'uid-1',
      addon_id: 'f1_addon',
      amount: 3,
      currency: 'USD',
    });

    expect(r.checkoutUrl).toBe('https://paypal.test/approve/order-xyz');
    expect(r.init_point).toBe('https://paypal.test/approve/order-xyz');
    expect(r.sessionId).toBe('order-xyz');
    expect(r.id).toBe('order-xyz');
    expect(r.provider).toBe('paypal');
    expect(r.sandbox).toBe(true);
  });

  test('production mode → sandbox=false', async () => {
    process.env.PAYPAL_MODE = 'production';
    pp._overrideSDKForTest(makeMockSdk());
    const r = await pp.createCheckoutSession({
      uid: 'u',
      addon_id: 'a',
      amount: 5,
    });
    expect(r.sandbox).toBe(false);
  });

  test('order sin link approve → checkoutUrl null', async () => {
    pp._overrideSDKForTest(makeMockSdk(null));
    const r = await pp.createCheckoutSession({
      uid: 'u',
      addon_id: 'a',
      amount: 5,
    });
    expect(r.checkoutUrl).toBeNull();
    expect(r.init_point).toBeNull();
    expect(r.id).toBe('order-xyz');
  });

  test('amount como número se formatea con toFixed(2)', async () => {
    let capturedBody = null;
    const mock = makeMockSdk();
    mock.sdk.orders.OrdersCreateRequest = function () {
      this.prefer = jest.fn();
      this.requestBody = jest.fn((body) => {
        capturedBody = body;
      });
    };
    pp._overrideSDKForTest(mock);
    await pp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: 3.5 });
    expect(capturedBody.purchase_units[0].amount.value).toBe('3.50');
  });

  test('amount como string queda como String', async () => {
    let capturedBody = null;
    const mock = makeMockSdk();
    mock.sdk.orders.OrdersCreateRequest = function () {
      this.prefer = jest.fn();
      this.requestBody = jest.fn((body) => {
        capturedBody = body;
      });
    };
    pp._overrideSDKForTest(mock);
    await pp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: '5.00' });
    expect(capturedBody.purchase_units[0].amount.value).toBe('5.00');
  });

  test('currency default USD', async () => {
    let capturedBody = null;
    const mock = makeMockSdk();
    mock.sdk.orders.OrdersCreateRequest = function () {
      this.prefer = jest.fn();
      this.requestBody = jest.fn((body) => {
        capturedBody = body;
      });
    };
    pp._overrideSDKForTest(mock);
    await pp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: 5 });
    expect(capturedBody.purchase_units[0].amount.currency_code).toBe('USD');
  });

  test('currency lowercase se uppercasea', async () => {
    let capturedBody = null;
    const mock = makeMockSdk();
    mock.sdk.orders.OrdersCreateRequest = function () {
      this.prefer = jest.fn();
      this.requestBody = jest.fn((body) => {
        capturedBody = body;
      });
    };
    pp._overrideSDKForTest(mock);
    await pp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: 5, currency: 'eur' });
    expect(capturedBody.purchase_units[0].amount.currency_code).toBe('EUR');
  });

  test('success_url + cancel_url custom', async () => {
    let capturedBody = null;
    const mock = makeMockSdk();
    mock.sdk.orders.OrdersCreateRequest = function () {
      this.prefer = jest.fn();
      this.requestBody = jest.fn((body) => {
        capturedBody = body;
      });
    };
    pp._overrideSDKForTest(mock);
    await pp.createCheckoutSession({
      uid: 'u',
      addon_id: 'a',
      amount: 5,
      success_url: 'https://custom/ok',
      cancel_url: 'https://custom/cancel',
    });
    expect(capturedBody.application_context.return_url).toBe('https://custom/ok');
    expect(capturedBody.application_context.cancel_url).toBe('https://custom/cancel');
  });

  test('API_URL ausente → paths con vacío', async () => {
    delete process.env.API_URL;
    let capturedBody = null;
    const mock = makeMockSdk();
    mock.sdk.orders.OrdersCreateRequest = function () {
      this.prefer = jest.fn();
      this.requestBody = jest.fn((body) => {
        capturedBody = body;
      });
    };
    pp._overrideSDKForTest(mock);
    await pp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: 5 });
    expect(capturedBody.application_context.return_url).toContain('/api/f1/billing');
  });
});

describe('paypal — createCheckoutSession SDK fail', () => {
  test('sdkInitFail override → throw SDK_NOT_INSTALLED', async () => {
    pp._overrideSDKForTest({ client: null, sdkInitFail: true });
    await expect(
      pp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: 5 }),
    ).rejects.toThrow('SDK_NOT_INSTALLED');
  });

  test('getPaymentDetails con sdkInitFail → throw SDK_NOT_INSTALLED', async () => {
    pp._overrideSDKForTest({ client: null, sdkInitFail: true });
    await expect(pp.getPaymentDetails('order-x')).rejects.toThrow('SDK_NOT_INSTALLED');
  });
});

describe('paypal — _initSDK real path (SDK instalado)', () => {
  test('createCheckoutSession con SDK real instalado — PAYPAL_MODE sandbox', async () => {
    // Sin override → _initSDK ejecuta require real + Environment ternary
    pp._overrideSDKForTest(null);
    process.env.PAYPAL_MODE = 'sandbox';
    process.env.PAYPAL_CLIENT_ID = 'TEST-CLIENT-ID';
    process.env.PAYPAL_CLIENT_SECRET = 'TEST-CLIENT-SECRET';
    // La llamada lanzará error real (auth fail) pero pasará por _initSDK real path.
    await expect(
      pp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: 5 }),
    ).rejects.toBeDefined();
    // Reset estado para no contaminar tests siguientes.
    pp._overrideSDKForTest(null);
  });

  test('createCheckoutSession con SDK real instalado — PAYPAL_MODE production', async () => {
    pp._overrideSDKForTest(null);
    process.env.PAYPAL_MODE = 'production';
    process.env.PAYPAL_CLIENT_ID = 'TEST-CLIENT-ID';
    process.env.PAYPAL_CLIENT_SECRET = 'TEST-CLIENT-SECRET';
    await expect(
      pp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: 5 }),
    ).rejects.toBeDefined();
    pp._overrideSDKForTest(null);
    process.env.PAYPAL_MODE = 'sandbox';
  });

  test('createCheckoutSession con SDK real + PAYPAL_CLIENT_ID/SECRET unset → fallback ""', async () => {
    pp._overrideSDKForTest(null);
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    await expect(
      pp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: 5 }),
    ).rejects.toBeDefined();
    pp._overrideSDKForTest(null);
  });

  test('order sin links field → fallback (order.links || []).find', async () => {
    const mockNoLinks = {
      sdk: {
        orders: {
          OrdersCreateRequest: function () {
            this.prefer = jest.fn();
            this.requestBody = jest.fn();
          },
        },
        core: {
          SandboxEnvironment: function () {},
          PayPalHttpClient: function () {},
        },
      },
      client: {
        execute: jest.fn(async () => ({
          result: { id: 'order-no-links' }, // sin field 'links'
        })),
      },
    };
    pp._overrideSDKForTest(mockNoLinks);
    const r = await pp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: 5 });
    expect(r.checkoutUrl).toBeNull();
    expect(r.sessionId).toBe('order-no-links');
  });
});

describe('paypal — getPaymentDetails', () => {
  test('happy path', async () => {
    const mock = {
      sdk: {
        orders: {
          OrdersGetRequest: function (id) {
            this.id = id;
          },
        },
        core: {
          SandboxEnvironment: function () {},
          PayPalHttpClient: function () {},
        },
      },
      client: {
        execute: jest.fn(async (req) => ({
          result: { id: req.id, status: 'COMPLETED' },
        })),
      },
    };
    pp._overrideSDKForTest(mock);
    const r = await pp.getPaymentDetails('order-abc');
    expect(r.id).toBe('order-abc');
    expect(r.status).toBe('COMPLETED');
  });
});

describe('paypal — verifyWebhook defensive guards', () => {
  test('false si signature y headers falta', () => {
    expect(pp.verifyWebhook('body', null, 'secret')).toBe(false);
    expect(pp.verifyWebhook('body', '', 'secret')).toBe(false);
  });

  test('false si secret y webhookId falta', () => {
    expect(pp.verifyWebhook('body', 'sig', null)).toBe(false);
    expect(pp.verifyWebhook('body', 'sig', '')).toBe(false);
  });

  test('false si rawBody falta', () => {
    expect(pp.verifyWebhook(null, 'sig', 'secret')).toBe(false);
    expect(pp.verifyWebhook('', 'sig', 'secret')).toBe(false);
  });

  test('false si extra.headers ausente (modo defensive sin full validation)', () => {
    expect(pp.verifyWebhook('body', 'sig', 'secret')).toBe(false);
  });

  test('false si falta paypal-transmission-id', () => {
    const headers = {
      'paypal-transmission-time': 't',
      'paypal-cert-url': 'https://api.paypal.com/cert',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-transmission-sig': 'sig',
    };
    expect(pp.verifyWebhook('body', 'sig', 'secret', { headers })).toBe(false);
  });

  test('false si falta paypal-cert-url', () => {
    const headers = {
      'paypal-transmission-id': 'id',
      'paypal-transmission-time': 't',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-transmission-sig': 'sig',
    };
    expect(pp.verifyWebhook('body', 'sig', 'secret', { headers })).toBe(false);
  });

  test('false si cert-url no es origen oficial PayPal (anti-SSRF)', () => {
    const headers = {
      'paypal-transmission-id': 'id',
      'paypal-transmission-time': 't',
      'paypal-cert-url': 'https://malicious.example.com/cert',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-transmission-sig': 'sig',
    };
    expect(pp.verifyWebhook('body', 'sig', 'secret', { headers })).toBe(false);
  });

  test('false con cert-url válido + SDK ausente → sdk_required', () => {
    pp._overrideSDKForTest({ sdkInstalled: false });
    const headers = {
      'paypal-transmission-id': 'id',
      'paypal-transmission-time': 't',
      'paypal-cert-url': 'https://api.paypal.com/cert',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-transmission-sig': 'sig',
    };
    expect(pp.verifyWebhook('body', 'sig', 'secret', { headers })).toBe(false);
  });

  test('cert-url sandbox válido', () => {
    const headers = {
      'paypal-transmission-id': 'id',
      'paypal-transmission-time': 't',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-transmission-sig': 'sig',
    };
    // SDK instalado por default — devuelve false porque wire pendiente.
    expect(pp.verifyWebhook('body', 'sig', 'secret', { headers })).toBe(false);
  });

  test('webhookId via extra (sin secret)', () => {
    const headers = {
      'paypal-transmission-id': 'id',
      'paypal-transmission-time': 't',
      'paypal-cert-url': 'https://api.paypal.com/cert',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-transmission-sig': 'sig',
    };
    expect(pp.verifyWebhook('body', 'sig', '', { headers, webhookId: 'WH-123' })).toBe(false);
  });
});

describe('paypal — PAYPAL_CERT_ORIGINS export', () => {
  test('exporta whitelist frozen anti-SSRF', () => {
    expect(Array.isArray(pp.PAYPAL_CERT_ORIGINS)).toBe(true);
    expect(Object.isFrozen(pp.PAYPAL_CERT_ORIGINS)).toBe(true);
    expect(pp.PAYPAL_CERT_ORIGINS).toContain('https://api.paypal.com/');
    expect(pp.PAYPAL_CERT_ORIGINS).toContain('https://api.sandbox.paypal.com/');
  });
});

describe('paypal — _overrideSDKForTest', () => {
  test('null reset', () => {
    pp._overrideSDKForTest({ sdkInstalled: true });
    pp._overrideSDKForTest(null);
    expect(pp._isSDKInstalled()).toBe(true);
  });

  test('mock parcial (solo client)', () => {
    pp._overrideSDKForTest({ client: { x: 1 } });
    expect(pp._isSDKInstalled()).toBe(true);
  });
});
