'use strict';

const {
  createPaymentIntent, processStripeWebhook, isPaymentSucceeded, getIntentHistory,
  INTENT_STATUSES, SUPPORTED_CURRENCIES, MIN_AMOUNT_CENTS,
  __setFirestoreForTests, __setHttpClientForTests,
} = require('../core/stripe_handler');

const UID = 'testUid1234567890';
const INTENT_RESP = { id: 'pi_123', client_secret: 'pi_123_secret', status: 'requires_payment_method', amount: 5000, currency: 'usd' };

function makeMockDb({ throwSet = false } = {}) {
  const doc = {
    set: async (data, opts) => { if (throwSet) throw new Error('set error'); },
    get: async () => ({ forEach: fn => {} }),
  };
  const coll = {
    doc: () => doc,
    get: async () => ({ forEach: fn => {} }),
  };
  const subDoc = { collection: () => coll };
  return { collection: () => ({ doc: () => subDoc }) };
}

function makeHttpClient(response) {
  return async (url, body, headers, signal) => response;
}

beforeEach(() => {
  __setFirestoreForTests(null);
  __setHttpClientForTests(null);
  delete process.env.STRIPE_SECRET_KEY;
});
afterEach(() => {
  __setFirestoreForTests(null);
  __setHttpClientForTests(null);
  delete process.env.STRIPE_SECRET_KEY;
});

describe('INTENT_STATUSES y constants', () => {
  test('incluye succeeded y canceled', () => {
    expect(INTENT_STATUSES).toContain('succeeded');
    expect(INTENT_STATUSES).toContain('canceled');
  });
  test('es frozen', () => {
    expect(() => { INTENT_STATUSES.push('nuevo'); }).toThrow();
  });
  test('SUPPORTED_CURRENCIES incluye usd y brl', () => {
    expect(SUPPORTED_CURRENCIES).toContain('usd');
    expect(SUPPORTED_CURRENCIES).toContain('brl');
  });
  test('MIN_AMOUNT_CENTS es 50', () => {
    expect(MIN_AMOUNT_CENTS).toBe(50);
  });
});

describe('createPaymentIntent', () => {
  test('lanza si uid undefined', async () => {
    await expect(createPaymentIntent(undefined, { amount: 100 })).rejects.toThrow('uid requerido');
  });
  test('lanza si opts undefined', async () => {
    await expect(createPaymentIntent(UID, null)).rejects.toThrow('opts requerido');
  });
  test('lanza si amount < MIN_AMOUNT_CENTS', async () => {
    await expect(createPaymentIntent(UID, { amount: 10 })).rejects.toThrow('centavos');
  });
  test('lanza si currency no soportada', async () => {
    await expect(createPaymentIntent(UID, { amount: 100, currency: 'XYZ' })).rejects.toThrow('currency no soportada');
  });
  test('lanza si sin STRIPE_SECRET_KEY', async () => {
    await expect(createPaymentIntent(UID, { amount: 100 })).rejects.toThrow('STRIPE_SECRET_KEY');
  });
  test('crea intent con cliente inyectado', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    __setFirestoreForTests(makeMockDb());
    __setHttpClientForTests(makeHttpClient(INTENT_RESP));
    const r = await createPaymentIntent(UID, { amount: 5000, currency: 'usd' });
    expect(r.intentId).toBe('pi_123');
    expect(r.clientSecret).toBe('pi_123_secret');
    expect(r.status).toBe('requires_payment_method');
  });
  test('lanza si respuesta sin id', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    __setFirestoreForTests(makeMockDb());
    __setHttpClientForTests(makeHttpClient({ no_id: true }));
    await expect(createPaymentIntent(UID, { amount: 5000 })).rejects.toThrow('sin id');
  });
  test('lanza si respuesta con error Stripe', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    __setFirestoreForTests(makeMockDb());
    __setHttpClientForTests(makeHttpClient({ id: 'pi_x', error: { message: 'card declined' } }));
    await expect(createPaymentIntent(UID, { amount: 5000 })).rejects.toThrow('card declined');
  });
  test('acepta metadata', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    __setFirestoreForTests(makeMockDb());
    __setHttpClientForTests(makeHttpClient(INTENT_RESP));
    const r = await createPaymentIntent(UID, { amount: 5000, metadata: { order_id: '123' } });
    expect(r.intentId).toBeDefined();
  });
});


describe('processStripeWebhook', () => {
  test('lanza si uid undefined', async () => {
    await expect(processStripeWebhook(undefined, {})).rejects.toThrow('uid requerido');
  });
  test('lanza si event undefined', async () => {
    await expect(processStripeWebhook(UID, null)).rejects.toThrow('event requerido');
  });
  test('ignora tipo que no es payment_intent.*', async () => {
    const r = await processStripeWebhook(UID, { type: 'customer.created' });
    expect(r.processed).toBe(false);
    expect(r.reason).toContain('no procesable');
  });
  test('lanza si sin data.object.id', async () => {
    await expect(processStripeWebhook(UID, { type: 'payment_intent.succeeded', data: {} })).rejects.toThrow('data.object.id requerido');
  });
  test('procesa webhook payment_intent.succeeded', async () => {
    __setFirestoreForTests(makeMockDb());
    const event = {
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_123', status: 'succeeded', amount: 5000, currency: 'usd' } },
    };
    const r = await processStripeWebhook(UID, event);
    expect(r.processed).toBe(true);
    expect(r.intentId).toBe('pi_123');
    expect(r.status).toBe('succeeded');
  });
  test('procesa webhook payment_intent.payment_failed', async () => {
    __setFirestoreForTests(makeMockDb());
    const event = {
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_456', status: 'requires_payment_method' } },
    };
    const r = await processStripeWebhook(UID, event);
    expect(r.processed).toBe(true);
    expect(r.status).toBe('requires_payment_method');
  });
});

describe('isPaymentSucceeded', () => {
  test('retorna true para succeeded', () => {
    expect(isPaymentSucceeded('succeeded')).toBe(true);
  });
  test('retorna false para otros estados', () => {
    expect(isPaymentSucceeded('canceled')).toBe(false);
    expect(isPaymentSucceeded('processing')).toBe(false);
    expect(isPaymentSucceeded('requires_payment_method')).toBe(false);
  });
});

describe('getIntentHistory', () => {
  test('lanza si uid undefined', async () => {
    await expect(getIntentHistory(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si sin intents', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getIntentHistory(UID);
    expect(r).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ get: async () => { throw new Error('err'); } }) }) }),
    });
    const r = await getIntentHistory(UID);
    expect(r).toEqual([]);
  });
});
