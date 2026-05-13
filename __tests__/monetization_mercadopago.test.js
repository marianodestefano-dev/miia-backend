/**
 * Tests lib/monetization/providers/mercadopago.js — 100% branches.
 *
 * Estrategia: inyección _overrideSDKForTest para no necesitar SDK real durante tests.
 * Cubre: createCheckoutSession (happy + SDK fail), getPaymentDetails, verifyWebhook
 * (firma valida, malformada, missing, mismatched, dataId desde rawBody, timingSafe fail).
 */

'use strict';

const mp = require('../lib/monetization/providers/mercadopago');
const crypto = require('node:crypto');

beforeEach(() => {
  mp._overrideSDKForTest(null); // reset
});

afterAll(() => {
  mp._overrideSDKForTest(null);
});

describe('mercadopago — _isSDKInstalled', () => {
  test('detecta SDK instalado (default)', () => {
    expect(mp._isSDKInstalled()).toBe(true);
  });

  test('override = false → simula NO instalado', () => {
    mp._overrideSDKForTest({ sdkInstalled: false });
    expect(mp._isSDKInstalled()).toBe(false);
  });

  test('override = true → SDK instalado', () => {
    mp._overrideSDKForTest({ sdkInstalled: true });
    expect(mp._isSDKInstalled()).toBe(true);
  });
});

describe('mercadopago — createCheckoutSession happy path', () => {
  test('inyecta mock preference + retorna checkoutUrl', async () => {
    const mockPreference = {
      create: jest.fn(async () => ({
        init_point: 'https://mp.test/checkout/xyz',
        id: 'pref-123',
      })),
    };
    mp._overrideSDKForTest({ preference: mockPreference });
    process.env.API_URL = 'https://api.test';
    process.env.MP_SANDBOX = 'true';

    const r = await mp.createCheckoutSession({
      uid: 'uid-1',
      addon_id: 'f1_addon',
      amount: 3,
      currency: 'USD',
    });

    expect(r.checkoutUrl).toBe('https://mp.test/checkout/xyz');
    expect(r.init_point).toBe('https://mp.test/checkout/xyz');
    expect(r.sessionId).toBe('pref-123');
    expect(r.id).toBe('pref-123');
    expect(r.provider).toBe('mercadopago');
    expect(r.sandbox).toBe(true);

    const callArgs = mockPreference.create.mock.calls[0][0];
    expect(callArgs.body.items[0].id).toBe('f1_addon');
    expect(callArgs.body.items[0].unit_price).toBe(3);
    expect(callArgs.body.items[0].currency_id).toBe('USD');
    expect(callArgs.body.external_reference).toMatch(/^uid-1:f1_addon:/);
    expect(callArgs.body.metadata).toEqual({ uid: 'uid-1', addon_id: 'f1_addon' });
  });

  test('success_url + cancel_url custom', async () => {
    const mockPreference = {
      create: jest.fn(async () => ({ init_point: 'url', id: 'p' })),
    };
    mp._overrideSDKForTest({ preference: mockPreference });
    await mp.createCheckoutSession({
      uid: 'u',
      addon_id: 'a',
      amount: 5,
      success_url: 'https://custom/ok',
      cancel_url: 'https://custom/cancel',
    });
    const args = mockPreference.create.mock.calls[0][0];
    expect(args.body.back_urls.success).toBe('https://custom/ok');
    expect(args.body.back_urls.failure).toBe('https://custom/cancel');
  });

  test('currency default USD si no se pasa', async () => {
    const mockPreference = {
      create: jest.fn(async () => ({ init_point: 'url', id: 'p' })),
    };
    mp._overrideSDKForTest({ preference: mockPreference });
    await mp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: 5 });
    expect(mockPreference.create.mock.calls[0][0].body.items[0].currency_id).toBe('USD');
  });

  test('sandbox=false cuando MP_SANDBOX != "true"', async () => {
    const mockPreference = {
      create: jest.fn(async () => ({ init_point: 'url', id: 'p' })),
    };
    mp._overrideSDKForTest({ preference: mockPreference });
    delete process.env.MP_SANDBOX;
    const r = await mp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: 5 });
    expect(r.sandbox).toBe(false);
  });

  test('API_URL ausente → paths funcionan con string vacío', async () => {
    const mockPreference = {
      create: jest.fn(async () => ({ init_point: 'url', id: 'p' })),
    };
    mp._overrideSDKForTest({ preference: mockPreference });
    delete process.env.API_URL;
    await mp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: 5 });
    const args = mockPreference.create.mock.calls[0][0];
    expect(args.body.back_urls.success).toContain('/api/f1/billing/checkout/success');
  });
});

describe('mercadopago — createCheckoutSession SDK fail', () => {
  test('SDK init fail override → throw SDK_NOT_INSTALLED', async () => {
    mp._overrideSDKForTest({ client: null, sdkInitFail: true });
    await expect(
      mp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: 5 }),
    ).rejects.toThrow('SDK_NOT_INSTALLED');
  });

  test('getPaymentDetails con sdkInitFail → throw SDK_NOT_INSTALLED', async () => {
    mp._overrideSDKForTest({ client: null, sdkInitFail: true });
    await expect(mp.getPaymentDetails('p-x')).rejects.toThrow('SDK_NOT_INSTALLED');
  });
});

describe('mercadopago — _initSDK real path (SDK instalado)', () => {
  test('createCheckoutSession con SDK real + MP_ACCESS_TOKEN set', async () => {
    mp._overrideSDKForTest(null);
    process.env.MP_ACCESS_TOKEN = 'TEST-FAKE-TOKEN-12345';
    await expect(
      mp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: 1 }),
    ).rejects.toBeDefined();
    mp._overrideSDKForTest(null);
  });

  test('createCheckoutSession con SDK real + MP_ACCESS_TOKEN unset → fallback ""', async () => {
    mp._overrideSDKForTest(null);
    delete process.env.MP_ACCESS_TOKEN;
    await expect(
      mp.createCheckoutSession({ uid: 'u', addon_id: 'a', amount: 1 }),
    ).rejects.toBeDefined();
    mp._overrideSDKForTest(null);
  });
});

describe('mercadopago — getPaymentDetails', () => {
  test('happy path retorna payment data', async () => {
    const mockPayment = {
      get: jest.fn(async ({ id }) => ({ id, status: 'approved', amount: 3 })),
    };
    mp._overrideSDKForTest({ payment: mockPayment });
    const r = await mp.getPaymentDetails('pay-123');
    expect(r.id).toBe('pay-123');
    expect(r.status).toBe('approved');
  });

  test('SDK fail → throw SDK_NOT_INSTALLED', async () => {
    mp._overrideSDKForTest({ client: null, sdkInitFail: true });
    await expect(mp.getPaymentDetails('p')).rejects.toThrow('SDK_NOT_INSTALLED');
  });
});

describe('mercadopago — verifyWebhook (firma HMAC-SHA256)', () => {
  const SECRET = 'mp-webhook-secret-test';
  const dataId = 'payment-456';
  const xRequestId = 'req-xyz';
  const ts = '1700000000';

  function makeValidSignature() {
    const template = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const hash = crypto.createHmac('sha256', SECRET).update(template).digest('hex');
    return `ts=${ts},v1=${hash}`;
  }

  test('false si signature falta', () => {
    expect(mp.verifyWebhook('body', '', SECRET)).toBe(false);
    expect(mp.verifyWebhook('body', null, SECRET)).toBe(false);
  });

  test('false si secret falta', () => {
    expect(mp.verifyWebhook('body', 'ts=x,v1=y', '')).toBe(false);
    expect(mp.verifyWebhook('body', 'ts=x,v1=y', null)).toBe(false);
  });

  test('false si signature malformada (sin ts)', () => {
    expect(mp.verifyWebhook('body', 'v1=onlyhash', SECRET)).toBe(false);
  });

  test('false si signature malformada (sin v1)', () => {
    expect(mp.verifyWebhook('body', 'ts=12345', SECRET)).toBe(false);
  });

  test('true con firma válida + extra explícito', () => {
    const sig = makeValidSignature();
    expect(mp.verifyWebhook('body', sig, SECRET, { dataId, xRequestId })).toBe(true);
  });

  test('false con firma inválida (hash mismatch)', () => {
    const sig = `ts=${ts},v1=` + 'a'.repeat(64); // hash fake
    expect(mp.verifyWebhook('body', sig, SECRET, { dataId, xRequestId })).toBe(false);
  });

  test('dataId desde rawBody.data.id', () => {
    const rawBody = JSON.stringify({ data: { id: dataId } });
    const template = `id:${dataId};ts:${ts};`;
    const hash = crypto.createHmac('sha256', SECRET).update(template).digest('hex');
    const sig = `ts=${ts},v1=${hash}`;
    expect(mp.verifyWebhook(rawBody, sig, SECRET)).toBe(true);
  });

  test('dataId desde rawBody.id top-level', () => {
    const rawBody = JSON.stringify({ id: dataId });
    const template = `id:${dataId};ts:${ts};`;
    const hash = crypto.createHmac('sha256', SECRET).update(template).digest('hex');
    const sig = `ts=${ts},v1=${hash}`;
    expect(mp.verifyWebhook(rawBody, sig, SECRET)).toBe(true);
  });

  test('rawBody como objeto (no string)', () => {
    const rawBody = { data: { id: dataId } };
    const template = `id:${dataId};ts:${ts};`;
    const hash = crypto.createHmac('sha256', SECRET).update(template).digest('hex');
    const sig = `ts=${ts},v1=${hash}`;
    expect(mp.verifyWebhook(rawBody, sig, SECRET)).toBe(true);
  });

  test('rawBody parse fail → template sin dataId, sigue intentando', () => {
    const rawBody = 'not-valid-json{{{';
    const template = `ts:${ts};`;
    const hash = crypto.createHmac('sha256', SECRET).update(template).digest('hex');
    const sig = `ts=${ts},v1=${hash}`;
    expect(mp.verifyWebhook(rawBody, sig, SECRET)).toBe(true);
  });

  test('hash hex length mismatch → false sin throw (timingSafe defensive)', () => {
    // v1=abc (length 3, hex inválido para hash 64 chars)
    const sig = `ts=${ts},v1=abc`;
    expect(mp.verifyWebhook('body', sig, SECRET, { dataId, xRequestId })).toBe(false);
  });

  test('sin extra y sin rawBody → template solo ts, valida si hash coincide', () => {
    const template = `ts:${ts};`;
    const hash = crypto.createHmac('sha256', SECRET).update(template).digest('hex');
    const sig = `ts=${ts},v1=${hash}`;
    expect(mp.verifyWebhook(null, sig, SECRET)).toBe(true);
  });
});

describe('mercadopago — _overrideSDKForTest helpers', () => {
  test('null reset limpia todo', () => {
    mp._overrideSDKForTest({ client: {}, preference: {}, sdkInstalled: true });
    mp._overrideSDKForTest(null);
    expect(mp._isSDKInstalled()).toBe(true); // back to default real-detection
  });

  test('mock parcial sin client → default {}', () => {
    mp._overrideSDKForTest({});
    expect(mp._isSDKInstalled()).toBe(true);
  });
});
