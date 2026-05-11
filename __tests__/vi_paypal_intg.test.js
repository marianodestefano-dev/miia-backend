'use strict';

/**
 * VI-PAYPAL-INTG -- tests routes/paypal.js
 * 100% branches: subscribe / webhook / cancel endpoints.
 */

const express = require('express');
const request = require('supertest');

const {
  createPayPalRoutes,
  _setPayPalClientForTests,
  _setDbFactoryForTests,
  _setVerifyTokenForTests,
  VALID_PRODUCTS,
} = require('../routes/paypal');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use('/api/paypal', createPayPalRoutes());
  return app;
}

function makeClient(overrides) {
  return Object.assign({
    createSubscription: jest.fn().mockResolvedValue({
      id: 'SUB-123',
      status: 'APPROVAL_PENDING',
      links: [{ rel: 'approve', href: 'https://paypal.com/approve/SUB-123' }],
    }),
    cancelSubscription: jest.fn().mockResolvedValue(204),
    verifyWebhook: jest.fn().mockResolvedValue(true),
  }, overrides);
}

function makeDb() {
  const doc = { update: jest.fn().mockResolvedValue({}) };
  const col = { doc: jest.fn().mockReturnValue(doc) };
  return { collection: jest.fn().mockReturnValue(col), _doc: doc };
}

function setEnvPlan(product, value) {
  if (product === 'miiadt')   process.env.PAYPAL_PLAN_MIIADT   = value;
  if (product === 'ludomiia') process.env.PAYPAL_PLAN_LUDOMIIA = value;
  if (product === 'miiaf1')   process.env.PAYPAL_PLAN_F1       = value;
}

beforeEach(function() {
  delete process.env.PAYPAL_PLAN_MIIADT;
  delete process.env.PAYPAL_PLAN_LUDOMIIA;
  delete process.env.PAYPAL_PLAN_F1;
  delete process.env.PAYPAL_WEBHOOK_ID;
  _setPayPalClientForTests(null);
  _setDbFactoryForTests(function() { return {}; });
  _setVerifyTokenForTests(function() { return Promise.resolve({ uid: 'uid-test' }); });
});

// ── VALID_PRODUCTS export ────────────────────────────────────────────────────

test('VALID_PRODUCTS incluye los 3 productos', function() {
  expect(VALID_PRODUCTS).toContain('miiadt');
  expect(VALID_PRODUCTS).toContain('ludomiia');
  expect(VALID_PRODUCTS).toContain('miiaf1');
});

// ── POST /subscribe ──────────────────────────────────────────────────────────

describe('POST /api/paypal/subscribe', function() {
  test('S.1 sin token: 401 no_token', async function() {
    const app = makeApp();
    const res = await request(app).post('/api/paypal/subscribe').send({ product: 'miiadt' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('no_token');
  });

  test('S.2 token invalido: 401 invalid_token', async function() {
    _setVerifyTokenForTests(function() { return Promise.reject(new Error('bad_token')); });
    const app = makeApp();
    const res = await request(app).post('/api/paypal/subscribe')
      .set('Authorization', 'Bearer bad').send({ product: 'miiadt' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  test('S.3 producto invalido: 400 invalid_product', async function() {
    const app = makeApp();
    const res = await request(app).post('/api/paypal/subscribe')
      .set('Authorization', 'Bearer tok').send({ product: 'desconocido' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_product');
  });

  test('S.4 producto sin plan configurado: 503 plan_not_configured', async function() {
    const app = makeApp();
    const res = await request(app).post('/api/paypal/subscribe')
      .set('Authorization', 'Bearer tok').send({ product: 'miiadt' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('plan_not_configured');
  });

  test('S.5 happy path con approve link: 200 con approvalUrl', async function() {
    setEnvPlan('miiadt', 'PLAN-MIIADT-123');
    _setPayPalClientForTests(makeClient());
    const app = makeApp();
    const res = await request(app).post('/api/paypal/subscribe')
      .set('Authorization', 'Bearer tok').send({ product: 'miiadt' });
    expect(res.status).toBe(200);
    expect(res.body.subscriptionId).toBe('SUB-123');
    expect(res.body.approvalUrl).toBe('https://paypal.com/approve/SUB-123');
    expect(res.body.status).toBe('APPROVAL_PENDING');
  });

  test('S.6 sin link approve: approvalUrl null', async function() {
    setEnvPlan('ludomiia', 'PLAN-LUDOMIIA-456');
    _setPayPalClientForTests(makeClient({
      createSubscription: jest.fn().mockResolvedValue({ id: 'SUB-456', status: 'ACTIVE', links: null }),
    }));
    const app = makeApp();
    const res = await request(app).post('/api/paypal/subscribe')
      .set('Authorization', 'Bearer tok').send({ product: 'ludomiia' });
    expect(res.status).toBe(200);
    expect(res.body.approvalUrl).toBeNull();
  });

  test('S.7 PayPal API lanza: 500', async function() {
    setEnvPlan('miiaf1', 'PLAN-F1-789');
    _setPayPalClientForTests(makeClient({
      createSubscription: jest.fn().mockRejectedValue(new Error('paypal_down')),
    }));
    const app = makeApp();
    const res = await request(app).post('/api/paypal/subscribe')
      .set('Authorization', 'Bearer tok').send({ product: 'miiaf1' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('paypal_down');
  });
});

// ── POST /webhook ────────────────────────────────────────────────────────────

describe('POST /api/paypal/webhook', function() {
  test('W.1 firma invalida: 401 invalid_signature', async function() {
    _setPayPalClientForTests(makeClient({ verifyWebhook: jest.fn().mockResolvedValue(false) }));
    const app = makeApp();
    const res = await request(app).post('/api/paypal/webhook').send({ event_type: 'X' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_signature');
  });

  test('W.2 verify lanza: 500 signature_verify_failed', async function() {
    _setPayPalClientForTests(makeClient({ verifyWebhook: jest.fn().mockRejectedValue(new Error('cert_error')) }));
    const app = makeApp();
    const res = await request(app).post('/api/paypal/webhook').send({ event_type: 'X' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('signature_verify_failed');
  });

  test('W.3 uid faltante en resource: 400 uid_missing', async function() {
    _setPayPalClientForTests(makeClient());
    const app = makeApp();
    const res = await request(app).post('/api/paypal/webhook')
      .send({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('uid_missing');
  });

  test('W.4 ACTIVATED: 200 action=activated', async function() {
    _setPayPalClientForTests(makeClient());
    const db = makeDb();
    _setDbFactoryForTests(function() { return db; });
    const app = makeApp();
    const res = await request(app).post('/api/paypal/webhook').send({
      event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resource: { id: 'SUB-123', custom_id: 'uid-owner' },
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('activated');
    expect(db._doc.update).toHaveBeenCalledWith(expect.objectContaining({ payment_status: 'active' }));
  });

  test('W.5 CANCELLED: 200 action=cancelled', async function() {
    _setPayPalClientForTests(makeClient());
    const db = makeDb();
    _setDbFactoryForTests(function() { return db; });
    const app = makeApp();
    const res = await request(app).post('/api/paypal/webhook').send({
      event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
      resource: { custom_id: 'uid-owner' },
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('cancelled');
    expect(db._doc.update).toHaveBeenCalledWith(expect.objectContaining({ payment_status: 'cancelled' }));
  });

  test('W.6 PAYMENT.FAILED: 200 action=payment_failed', async function() {
    _setPayPalClientForTests(makeClient());
    const db = makeDb();
    _setDbFactoryForTests(function() { return db; });
    const app = makeApp();
    const res = await request(app).post('/api/paypal/webhook').send({
      event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
      resource: { custom_id: 'uid-owner' },
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('payment_failed');
  });

  test('W.7 evento desconocido: 200 action=ignored', async function() {
    _setPayPalClientForTests(makeClient());
    const db = makeDb();
    _setDbFactoryForTests(function() { return db; });
    const app = makeApp();
    const res = await request(app).post('/api/paypal/webhook').send({
      event_type: 'BILLING.SUBSCRIPTION.SUSPENDED',
      resource: { custom_id: 'uid-owner' },
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('ignored');
  });

  test('W.8 db.update lanza: 500', async function() {
    _setPayPalClientForTests(makeClient());
    const badDoc = { update: jest.fn().mockRejectedValue(new Error('db_fail')) };
    _setDbFactoryForTests(function() { return { collection: function() { return { doc: function() { return badDoc; } }; } }; });
    const app = makeApp();
    const res = await request(app).post('/api/paypal/webhook').send({
      event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resource: { id: 'SUB-X', custom_id: 'uid-owner' },
    });
    expect(res.status).toBe(500);
  });
});

// ── POST /cancel ─────────────────────────────────────────────────────────────

describe('POST /api/paypal/cancel', function() {
  test('C.1 sin token: 401 no_token', async function() {
    const app = makeApp();
    const res = await request(app).post('/api/paypal/cancel').send({ subscriptionId: 'SUB-123' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('no_token');
  });

  test('C.2 token invalido: 401 invalid_token', async function() {
    _setVerifyTokenForTests(function() { return Promise.reject(new Error('bad')); });
    const app = makeApp();
    const res = await request(app).post('/api/paypal/cancel')
      .set('Authorization', 'Bearer bad').send({ subscriptionId: 'SUB-123' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  test('C.3 sin subscriptionId: 400 subscription_id_required', async function() {
    const app = makeApp();
    const res = await request(app).post('/api/paypal/cancel')
      .set('Authorization', 'Bearer tok').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('subscription_id_required');
  });

  test('C.4 PayPal devuelve 4xx: reenviar ese status', async function() {
    _setPayPalClientForTests(makeClient({ cancelSubscription: jest.fn().mockResolvedValue(404) }));
    const app = makeApp();
    const res = await request(app).post('/api/paypal/cancel')
      .set('Authorization', 'Bearer tok').send({ subscriptionId: 'SUB-BAD' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('paypal_cancel_failed');
  });

  test('C.5 PayPal devuelve >=600: cap a 500', async function() {
    _setPayPalClientForTests(makeClient({ cancelSubscription: jest.fn().mockResolvedValue(999) }));
    const app = makeApp();
    const res = await request(app).post('/api/paypal/cancel')
      .set('Authorization', 'Bearer tok').send({ subscriptionId: 'SUB-BAD' });
    expect(res.status).toBe(500);
  });

  test('C.6 happy path: 200 cancelled + Firestore actualizado', async function() {
    _setPayPalClientForTests(makeClient());
    const db = makeDb();
    _setDbFactoryForTests(function() { return db; });
    const app = makeApp();
    const res = await request(app).post('/api/paypal/cancel')
      .set('Authorization', 'Bearer tok').send({ subscriptionId: 'SUB-123', reason: 'test' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(db._doc.update).toHaveBeenCalledWith(expect.objectContaining({ payment_status: 'cancelled' }));
  });

  test('C.7 PayPal cancel lanza excepcion: 500', async function() {
    _setPayPalClientForTests(makeClient({ cancelSubscription: jest.fn().mockRejectedValue(new Error('network_err')) }));
    const app = makeApp();
    const res = await request(app).post('/api/paypal/cancel')
      .set('Authorization', 'Bearer tok').send({ subscriptionId: 'SUB-123' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('network_err');
  });
});
