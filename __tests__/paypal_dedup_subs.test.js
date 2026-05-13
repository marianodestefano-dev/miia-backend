'use strict';
/**
 * paypal_dedup_subs.test.js -- A.7 + A.2/A.3 wire-in en paypal webhook
 * Cubre: lineas 138-140 (DUPLICATE branch), 153-159 (ACTIVATED product), 161-167 (CANCELLED product)
 */

const express = require('express');
const request = require('supertest');

const {
  createPayPalRoutes,
  _setPayPalClientForTests,
  _setDbFactoryForTests,
  _setVerifyTokenForTests,
} = require('../routes/paypal');
const webhookDedup = require('../core/webhook_dedup');
const subscriptionsManager = require('../core/subscriptions_manager');

function makeApp() {
  const app = express();
  app.use('/api/paypal', createPayPalRoutes());
  return app;
}

function makeFsMock(seedEvents, seedSubs) {
  const events = Object.assign({}, seedEvents || {});
  const subs = Object.assign({}, seedSubs || {});
  return {
    collection: jest.fn((name) => {
      if (name === 'webhook_events') {
        return {
          doc: jest.fn((key) => ({
            get: jest.fn().mockResolvedValue({ exists: !!events[key], data: () => events[key] || {} }),
            set: jest.fn((payload) => { events[key] = payload; return Promise.resolve(); }),
          })),
        };
      }
      if (name === 'users') {
        return {
          doc: jest.fn(() => ({
            collection: jest.fn((sub) => sub === 'subscriptions' ? {
              doc: jest.fn((product) => ({
                get: jest.fn().mockResolvedValue({ exists: !!subs[product], data: () => subs[product] || {} }),
                set: jest.fn((p) => { subs[product] = Object.assign({}, subs[product], p); return Promise.resolve(); }),
              })),
            } : null),
          })),
        };
      }
      return null;
    }),
    _events: events,
    _subs: subs,
  };
}

beforeEach(() => {
  delete process.env.PAYPAL_PLAN_MIIADT;
  delete process.env.PAYPAL_PLAN_LUDOMIIA;
  delete process.env.PAYPAL_PLAN_F1;
  _setPayPalClientForTests({
    verifyWebhook: jest.fn().mockResolvedValue(true),
  });
  _setDbFactoryForTests(() => ({
    collection: jest.fn(() => ({ doc: jest.fn(() => ({ update: jest.fn().mockResolvedValue({}) })) })),
  }));
  webhookDedup.__setFirestoreForTests(null);
  subscriptionsManager.__setFirestoreForTests(null);
});

describe('paypal webhook -- dedup + subscriptions wire-in', () => {
  test('duplicate event -> action=duplicate_skipped', async () => {
    const fsMock = makeFsMock({ 'paypal__evt-XYZ': { eventId: 'evt-XYZ' } }, {});
    webhookDedup.__setFirestoreForTests(fsMock);
    const app = makeApp();
    const res = await request(app).post('/api/paypal/webhook').send({
      id: 'evt-XYZ',
      event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resource: { id: 'SUB-1', custom_id: 'uid-A' },
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('duplicate_skipped');
    expect(res.body.eventId).toBe('evt-XYZ');
  });

  test('ACTIVATED + plan_id matchea -> addProductPermission llamado, product retornado', async () => {
    process.env.PAYPAL_PLAN_MIIADT = 'PLAN-MIIADT-001';
    const fsMock = makeFsMock({}, {});
    webhookDedup.__setFirestoreForTests(fsMock);
    subscriptionsManager.__setFirestoreForTests(fsMock);
    const app = makeApp();
    const res = await request(app).post('/api/paypal/webhook').send({
      id: 'evt-A',
      event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resource: { id: 'SUB-1', custom_id: 'uid-B', plan_id: 'PLAN-MIIADT-001' },
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('activated');
    expect(res.body.product).toBe('miiadt');
    expect(fsMock._subs.miiadt.active).toBe(true);
    expect(fsMock._subs.miiadt.plan).toBe('monthly');
  });

  test('CANCELLED + plan_id matchea -> writeSubscription con active=false', async () => {
    process.env.PAYPAL_PLAN_LUDOMIIA = 'PLAN-LUDO-001';
    const fsMock = makeFsMock({}, { ludomiia: { active: true, plan: 'monthly' } });
    webhookDedup.__setFirestoreForTests(fsMock);
    subscriptionsManager.__setFirestoreForTests(fsMock);
    const app = makeApp();
    const res = await request(app).post('/api/paypal/webhook').send({
      id: 'evt-C',
      event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
      resource: { id: 'SUB-2', custom_id: 'uid-C', plan_id: 'PLAN-LUDO-001' },
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('cancelled');
    expect(res.body.product).toBe('ludomiia');
    expect(fsMock._subs.ludomiia.active).toBe(false);
    expect(fsMock._subs.ludomiia.cancelledAt).toBeTruthy();
  });

  test('ACTIVATED sin plan_id matcheable -> product=null, sin addProductPermission', async () => {
    const fsMock = makeFsMock({}, {});
    webhookDedup.__setFirestoreForTests(fsMock);
    subscriptionsManager.__setFirestoreForTests(fsMock);
    const app = makeApp();
    const res = await request(app).post('/api/paypal/webhook').send({
      id: 'evt-D',
      event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resource: { id: 'SUB-3', custom_id: 'uid-D', plan_id: 'PLAN-DESCONOCIDO' },
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('activated');
    expect(res.body.product).toBe(null);
    expect(Object.keys(fsMock._subs).length).toBe(0);
  });

  test('CANCELLED sin plan_id -> product=null, sin writeSubscription', async () => {
    const fsMock = makeFsMock({}, {});
    webhookDedup.__setFirestoreForTests(fsMock);
    subscriptionsManager.__setFirestoreForTests(fsMock);
    const app = makeApp();
    const res = await request(app).post('/api/paypal/webhook').send({
      id: 'evt-E',
      event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
      resource: { id: 'SUB-4', custom_id: 'uid-E' },
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('cancelled');
    expect(res.body.product).toBe(null);
  });

  test('dedup error -> warn + sigue procesando (no rompe)', async () => {
    const breakMock = {
      collection: jest.fn(() => ({ doc: jest.fn(() => ({ get: jest.fn().mockRejectedValue(new Error('fs-down')) })) })),
    };
    webhookDedup.__setFirestoreForTests(breakMock);
    const app = makeApp();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).post('/api/paypal/webhook').send({
      id: 'evt-F',
      event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
      resource: { id: 'SUB-5', custom_id: 'uid-F' },
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('payment_failed');
    warn.mockRestore();
  });
});
