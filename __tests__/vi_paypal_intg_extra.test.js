'use strict';
/**
 * vi_paypal_intg_extra.test.js -- branches faltantes en routes/paypal.js
 * Cubre: lineas 20-21 (ludomiia/f1 || null falsy), 108 (result.status || null),
 *         127-128 (event_type || '' / resource || {}), 134 (resource.id || null)
 * Objetivo: 100% branches en routes/paypal.js
 */

const express = require('express');
const request = require('supertest');

const {
  createPayPalRoutes,
  _setPayPalClientForTests,
  _setDbFactoryForTests,
  _setVerifyTokenForTests,
} = require('../routes/paypal');

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

beforeEach(function() {
  delete process.env.PAYPAL_PLAN_MIIADT;
  delete process.env.PAYPAL_PLAN_LUDOMIIA;
  delete process.env.PAYPAL_PLAN_F1;
  delete process.env.PAYPAL_WEBHOOK_ID;
  _setPayPalClientForTests(null);
  _setDbFactoryForTests(function() { return {}; });
  _setVerifyTokenForTests(function() { return Promise.resolve({ uid: 'uid-test' }); });
});

// -- Lines 20-21: PLAN_RESOLVERS ludomiia y miiaf1 rama || null falsy --------

test('EX.1 ludomiia sin plan configurado: 503 plan_not_configured (linea 20 || null)', async function() {
  // PAYPAL_PLAN_LUDOMIIA no seteado -> PLAN_RESOLVERS.ludomiia() -> undefined || null -> null
  const app = makeApp();
  const res = await request(app).post('/api/paypal/subscribe')
    .set('Authorization', 'Bearer tok').send({ product: 'ludomiia' });
  expect(res.status).toBe(503);
  expect(res.body.error).toBe('plan_not_configured');
});

test('EX.2 miiaf1 sin plan configurado: 503 plan_not_configured (linea 21 || null)', async function() {
  // PAYPAL_PLAN_F1 no seteado -> PLAN_RESOLVERS.f1() -> undefined || null -> null
  const app = makeApp();
  const res = await request(app).post('/api/paypal/subscribe')
    .set('Authorization', 'Bearer tok').send({ product: 'f1' });
  expect(res.status).toBe(503);
  expect(res.body.error).toBe('plan_not_configured');
});

// -- Line 108: result.status || null rama falsy ------------------------------

test('EX.3 createSubscription sin campo status: status=null en respuesta (linea 108 || null)', async function() {
  process.env.PAYPAL_PLAN_MIIADT = 'PLAN-MIIADT-999';
  _setPayPalClientForTests(makeClient({
    createSubscription: jest.fn().mockResolvedValue({
      id: 'SUB-999',
      links: [{ rel: 'approve', href: 'https://paypal.com/approve/SUB-999' }],
      // sin campo status -> undefined -> || null
    }),
  }));
  const app = makeApp();
  const res = await request(app).post('/api/paypal/subscribe')
    .set('Authorization', 'Bearer tok').send({ product: 'miiadt' });
  expect(res.status).toBe(200);
  expect(res.body.subscriptionId).toBe('SUB-999');
  expect(res.body.status).toBeNull();
});

// -- Lines 127-128: webhook sin event_type y sin resource --------------------

test('EX.4 webhook sin event_type: eventType="" -> action=ignored (linea 127 || "")', async function() {
  // payload.event_type ausente -> undefined || "" -> "" -> no match -> ignored
  _setPayPalClientForTests(makeClient());
  const db = makeDb();
  _setDbFactoryForTests(function() { return db; });
  const app = makeApp();
  const res = await request(app).post('/api/paypal/webhook').send({
    resource: { custom_id: 'uid-owner', id: 'SUB-X' },
  });
  expect(res.status).toBe(200);
  expect(res.body.action).toBe('ignored');
  expect(res.body.event_type).toBe('');
});

test('EX.5 webhook sin resource: resource={} -> uid_missing (linea 128 || {})', async function() {
  // payload.resource ausente -> undefined || {} -> {} -> custom_id undefined -> 400
  _setPayPalClientForTests(makeClient());
  const app = makeApp();
  const res = await request(app).post('/api/paypal/webhook').send({
    event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('uid_missing');
});

// -- Line 108: result.id || null rama falsy (subscriptionId sin id) ----------

test('EX.7 createSubscription sin id: subscriptionId=null (linea 108 result.id || null)', async function() {
  process.env.PAYPAL_PLAN_MIIADT = 'PLAN-MIIADT-888';
  _setPayPalClientForTests(makeClient({
    createSubscription: jest.fn().mockResolvedValue({
      // sin id -> undefined -> || null
      status: 'APPROVAL_PENDING',
      links: null,
    }),
  }));
  const app = makeApp();
  const res = await request(app).post('/api/paypal/subscribe')
    .set('Authorization', 'Bearer tok').send({ product: 'miiadt' });
  expect(res.status).toBe(200);
  expect(res.body.subscriptionId).toBeNull();
});

// -- Line 134: resource.id || null rama falsy --------------------------------

test('EX.6 ACTIVATED sin resource.id: paypal_subscription_id=null (linea 134 || null)', async function() {
  // resource tiene custom_id OK pero sin id -> resource.id undefined -> || null -> null
  _setPayPalClientForTests(makeClient());
  const db = makeDb();
  _setDbFactoryForTests(function() { return db; });
  const app = makeApp();
  const res = await request(app).post('/api/paypal/webhook').send({
    event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
    resource: { custom_id: 'uid-owner' },
  });
  expect(res.status).toBe(200);
  expect(res.body.action).toBe('activated');
  expect(db._doc.update).toHaveBeenCalledWith(
    expect.objectContaining({ paypal_subscription_id: null })
  );
});
