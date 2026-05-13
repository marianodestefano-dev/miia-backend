'use strict';
/**
 * product_status.test.js -- C.6 endpoints status por producto
 */

const express = require('express');
const request = require('supertest');

const productStatus = require('../routes/product_status');

function makeApp(subsMock) {
  productStatus.__setSubscriptionsManagerForTests(subsMock);
  const app = express();
  app.use('/api', productStatus.createProductStatusRoutes());
  return app;
}

function makeSubsMock(seedMap) {
  return {
    VALID_PRODUCTS: ['miia', 'miiadt', 'ludomiia', 'f1'],
    readSubscription: jest.fn(async (uid, product) => seedMap[uid + ':' + product] || null),
    isProductActive: jest.fn(async (uid, product) => {
      const sub = seedMap[uid + ':' + product];
      return !!(sub && sub.active);
    }),
  };
}

describe('product_status routes', () => {
  describe('GET /api/<producto>/status', () => {
    test('uid faltante -> 400', async () => {
      const app = makeApp(makeSubsMock({}));
      const res = await request(app).get('/api/miia/status');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('uid_required');
    });

    test('uid no string (objeto) -> 400', async () => {
      const app = makeApp(makeSubsMock({}));
      const res = await request(app).get('/api/miia/status').query({ 'uid[a]': '1' });
      expect(res.status).toBe(400);
    });

    test('producto sin subscription -> active=false', async () => {
      const app = makeApp(makeSubsMock({}));
      const res = await request(app).get('/api/miia/status?uid=u1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ product: 'miia', active: false, plan: null, expiresAt: null });
    });

    test('producto con subscription activa', async () => {
      const app = makeApp(makeSubsMock({
        'u1:miiadt': { active: true, plan: 'monthly', expiresAt: '2027-01-01' },
      }));
      const res = await request(app).get('/api/miiadt/status?uid=u1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ product: 'miiadt', active: true, plan: 'monthly', expiresAt: '2027-01-01' });
    });

    test('producto con subscription sin plan -> null fallback', async () => {
      const app = makeApp(makeSubsMock({
        'u1:ludomiia': { active: false },
      }));
      const res = await request(app).get('/api/ludomiia/status?uid=u1');
      expect(res.status).toBe(200);
      expect(res.body.plan).toBe(null);
      expect(res.body.expiresAt).toBe(null);
    });

    test('error interno -> 500', async () => {
      const subsMock = {
        VALID_PRODUCTS: ['miia', 'miiadt', 'ludomiia', 'f1'],
        readSubscription: jest.fn().mockRejectedValue(new Error('fs-down')),
        isProductActive: jest.fn(),
      };
      const app = makeApp(subsMock);
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(app).get('/api/miia/status?uid=u1');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('fs-down');
      err.mockRestore();
    });
  });

  describe('GET /api/products/status (agregado)', () => {
    test('uid faltante -> 400', async () => {
      const app = makeApp(makeSubsMock({}));
      const res = await request(app).get('/api/products/status');
      expect(res.status).toBe(400);
    });

    test('owner con miia + miiadt activos, otros no -> object con 4 keys', async () => {
      const app = makeApp(makeSubsMock({
        'u1:miia':     { active: true,  plan: 'monthly' },
        'u1:miiadt':   { active: true,  plan: 'monthly' },
        'u1:ludomiia': { active: false },
      }));
      const res = await request(app).get('/api/products/status?uid=u1');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['f1', 'ludomiia', 'miia', 'miiadt']);
      expect(res.body.miia.active).toBe(true);
      expect(res.body.miiadt.active).toBe(true);
      expect(res.body.ludomiia.active).toBe(false);
      expect(res.body.f1.active).toBe(false);
    });

    test('error interno aggregado -> 500', async () => {
      const subsMock = {
        VALID_PRODUCTS: ['miia', 'miiadt', 'ludomiia', 'f1'],
        readSubscription: jest.fn().mockRejectedValue(new Error('agg-down')),
        isProductActive: jest.fn(),
      };
      const app = makeApp(subsMock);
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(app).get('/api/products/status?uid=u1');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('agg-down');
      err.mockRestore();
    });
  });
});
