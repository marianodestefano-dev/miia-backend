'use strict';

const billing = require('../routes/f1_billing');

const state = {
  providerResult: { checkoutUrl: 'https://mp/checkout', sessionId: 'ck1', provider: 'mercadopago' },
  providerThrows: false,
  webhookValid: true,
  webhookThrows: false,
  dbAddCalls: [],
  dbThrows: false,
};

const mockProvider = {
  createCheckoutSession: jest.fn(async () => {
    if (state.providerThrows) throw new Error('SDK_NOT_INSTALLED');
    return state.providerResult;
  }),
  verifyWebhook: jest.fn(async () => {
    if (state.webhookThrows) throw new Error('verify_error');
    return state.webhookValid;
  }),
};

const mockDb = {
  collection: () => ({
    add: jest.fn(async (data) => {
      if (state.dbThrows) throw new Error('FS-ADD-ERR');
      state.dbAddCalls.push(data);
      return { id: 'sub_new' };
    }),
  }),
};

beforeAll(() => {
  billing._setProviderResolverForTests(() => mockProvider);
  billing._setDbFactoryForTests(() => mockDb);
});

beforeEach(() => {
  state.providerResult = { checkoutUrl: 'https://mp/checkout', sessionId: 'ck1', provider: 'mercadopago' };
  state.providerThrows = false;
  state.webhookValid = true;
  state.webhookThrows = false;
  state.dbAddCalls = [];
  state.dbThrows = false;
  mockProvider.createCheckoutSession.mockClear();
  mockProvider.verifyWebhook.mockClear();
});

const express = require('express');
const request = require('supertest');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/f1/billing', billing.createF1BillingRouter());
  return app;
}

describe('POST /api/f1/billing/checkout', () => {
  test('400 sin uid', async () => {
    const r = await request(makeApp()).post('/api/f1/billing/checkout').send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('uid_required');
  });

  test('200 happy path con uid + country AR', async () => {
    const r = await request(makeApp()).post('/api/f1/billing/checkout').send({ uid: 'u1', country: 'AR' });
    expect(r.status).toBe(200);
    expect(r.body.checkoutUrl).toBe('https://mp/checkout');
    expect(r.body.provider).toBe('mercadopago');
    expect(r.body.sessionId).toBe('ck1');
  });

  test('200 sin country usa default US', async () => {
    const r = await request(makeApp()).post('/api/f1/billing/checkout').send({ uid: 'u1' });
    expect(r.status).toBe(200);
    expect(mockProvider.createCheckoutSession).toHaveBeenCalled();
  });

  test('200 result fallback init_point + id (PayPal-style)', async () => {
    state.providerResult = { init_point: 'https://paypal/pay', id: 'order123' };
    const r = await request(makeApp()).post('/api/f1/billing/checkout').send({ uid: 'u1' });
    expect(r.body.checkoutUrl).toBe('https://paypal/pay');
    expect(r.body.sessionId).toBe('order123');
  });

  test('200 result vacio - fallbacks null + provider unknown', async () => {
    state.providerResult = {};
    const r = await request(makeApp()).post('/api/f1/billing/checkout').send({ uid: 'u1' });
    expect(r.body.checkoutUrl).toBeNull();
    expect(r.body.sessionId).toBeNull();
    expect(r.body.provider).toBe('unknown');
  });

  test('500 si provider throws SDK_NOT_INSTALLED', async () => {
    state.providerThrows = true;
    const r = await request(makeApp()).post('/api/f1/billing/checkout').send({ uid: 'u1' });
    expect(r.status).toBe(500);
    expect(r.body.error).toContain('SDK');
  });

  test('400 sin body uid undefined', async () => {
    const r = await request(makeApp()).post('/api/f1/billing/checkout');
    expect(r.status).toBe(400);
  });
});

describe('POST /api/f1/billing/webhook', () => {
  test('401 si signature invalida', async () => {
    state.webhookValid = false;
    const r = await request(makeApp()).post('/api/f1/billing/webhook').send({ status: 'approved', uid: 'u1' });
    expect(r.status).toBe(401);
  });

  test('200 ignored si status no es success', async () => {
    state.webhookValid = true;
    const r = await request(makeApp()).post('/api/f1/billing/webhook').send({ status: 'pending', uid: 'u1' });
    expect(r.body.action).toBe('ignored');
  });

  test('400 si payment success pero sin uid', async () => {
    const r = await request(makeApp()).post('/api/f1/billing/webhook').send({ status: 'approved' });
    expect(r.status).toBe(400);
  });

  test('200 activated MP status=approved + uid', async () => {
    const r = await request(makeApp()).post('/api/f1/billing/webhook').send({
      status: 'approved', uid: 'u1', payment_id: 'pay123', provider: 'mercadopago',
    });
    expect(r.body.action).toBe('activated');
    expect(state.dbAddCalls[0].owner_uid).toBe('u1');
  });

  test('200 activated PayPal event_type + metadata.uid', async () => {
    const r = await request(makeApp()).post('/api/f1/billing/webhook').send({
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      metadata: { uid: 'u2' },
      id: 'capture789',
      provider: 'paypal',
    });
    expect(r.body.action).toBe('activated');
    expect(state.dbAddCalls[0].owner_uid).toBe('u2');
  });

  test('200 activated status=completed', async () => {
    const r = await request(makeApp()).post('/api/f1/billing/webhook').send({ status: 'completed', uid: 'u3' });
    expect(r.body.action).toBe('activated');
  });

  test('500 si verifyWebhook throws', async () => {
    state.webhookThrows = true;
    const r = await request(makeApp()).post('/api/f1/billing/webhook').send({});
    expect(r.status).toBe(500);
  });

  test('500 si db.add throws en activacion', async () => {
    state.dbThrows = true;
    const r = await request(makeApp()).post('/api/f1/billing/webhook').send({ status: 'approved', uid: 'u1' });
    expect(r.status).toBe(500);
  });

  test('webhook con header x-mp-signature presente', async () => {
    const r = await request(makeApp())
      .post('/api/f1/billing/webhook')
      .set('x-mp-signature', 's')
      .send({ status: 'pending', uid: 'u1' });
    expect(r.status).toBe(200);
  });

  test('webhook con header paypal-transmission-sig presente', async () => {
    const r = await request(makeApp())
      .post('/api/f1/billing/webhook')
      .set('paypal-transmission-sig', 's')
      .send({ status: 'pending', uid: 'u1' });
    expect(r.status).toBe(200);
  });

  test('webhook con country query param', async () => {
    const r = await request(makeApp())
      .post('/api/f1/billing/webhook?country=BR')
      .send({ status: 'pending', uid: 'u1' });
    expect(r.status).toBe(200);
  });

  test('payload con id fallback cuando payment_id ausente', async () => {
    const r = await request(makeApp()).post('/api/f1/billing/webhook').send({
      status: 'approved', uid: 'u1', id: 'fallback_id',
    });
    expect(state.dbAddCalls[0].payment_id).toBe('fallback_id');
  });

  test('payload sin payment_id ni id - null', async () => {
    const r = await request(makeApp()).post('/api/f1/billing/webhook').send({
      status: 'approved', uid: 'u1',
    });
    expect(state.dbAddCalls[0].payment_id).toBeNull();
  });

  test('payload sin provider - unknown', async () => {
    const r = await request(makeApp()).post('/api/f1/billing/webhook').send({
      status: 'approved', uid: 'u1',
    });
    expect(state.dbAddCalls[0].provider).toBe('unknown');
  });

  test('webhook sin body - 200 ignored', async () => {
    const r = await request(makeApp()).post('/api/f1/billing/webhook');
    expect(r.body.action).toBe('ignored');
  });
});
