'use strict';

/**
 * CAT.1-4 — Tests Catalogo + Search + Onboarding
 */

const express = require('express');
const request = require('supertest');
const createCatalog = require('../routes/catalog');
const { __setFirestoreForTests: setCatalogDb } = require('../routes/catalog');
const { searchCatalog, buildCatalogContext, __setFirestoreForTests: setSearchDb } = require('../core/catalog_search');
const createOnboarding = require('../routes/onboarding');
const { __setFirestoreForTests: setOnboardDb } = require('../routes/onboarding');

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

function makeApp(uid, db, routeFn) {
  if (db) routeFn.__setFirestoreForTests(db);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { uid }; next(); });
  app.use('/api', routeFn({ requireAuth: (req, res, next) => next() }));
  return app;
}

afterEach(() => {
  setCatalogDb(null);
  setSearchDb(null);
  setOnboardDb(null);
  jest.clearAllMocks();
});

// ── CAT.1 ─────────────────────────────────────────────
describe('CAT.1 CRUD catalog', () => {
  let mockAdd, mockSet, mockGet;

  function makeCatDb(items) {
    mockAdd = jest.fn().mockResolvedValue({ id: 'new-item-id' });
    mockSet = jest.fn().mockResolvedValue(undefined);
    mockGet = jest.fn().mockResolvedValue({
      docs: (items || []).map((item) => ({ id: item.id, data: () => item })),
      empty: !items || items.length === 0,
    });
    return {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            add: mockAdd,
            orderBy: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            get: mockGet,
            doc: jest.fn(() => ({ set: mockSet })),
          })),
        })),
      })),
    };
  }

  test('POST /catalog con campos validos => 201', async () => {
    const res = await request(makeApp('u1', makeCatDb([]), createCatalog))
      .post('/api')
      .send({ name: 'Producto A', description: 'Desc A', price: 10, currency: 'USD' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.active).toBe(true);
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });

  test('POST /catalog sin nombre => 400', async () => {
    const res = await request(makeApp('u1', makeCatDb([]), createCatalog))
      .post('/api')
      .send({ description: 'sin nombre' });
    expect(res.status).toBe(400);
  });

  test('GET /catalog => lista items activos', async () => {
    const items = [
      { id: 'i1', name: 'A', description: 'dA', active: true, created_at: '2026-05-12' },
      { id: 'i2', name: 'B', description: 'dB', active: true, created_at: '2026-05-11' },
    ];
    const res = await request(makeApp('u1', makeCatDb(items), createCatalog)).get('/api');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  test('PUT /catalog/:id => 200', async () => {
    const res = await request(makeApp('u1', makeCatDb([]), createCatalog))
      .put('/api/item1')
      .send({ price: 99 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ price: 99 }), { merge: true });
  });

  test('DELETE /catalog/:id => soft-delete (active=false)', async () => {
    const res = await request(makeApp('u1', makeCatDb([]), createCatalog)).delete('/api/item1');
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ active: false }), { merge: true });
  });
});

// ── CAT.2 ─────────────────────────────────────────────
describe('CAT.2 catalog_search', () => {
  function mockCatalogDb(items) {
    setSearchDb({
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            where: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue({
              empty: !items || items.length === 0,
              docs: (items || []).map((item) => ({ data: () => item })),
            }),
          })),
        })),
      })),
    });
  }

  test('con catalogo => retorna items relevantes', async () => {
    mockCatalogDb([
      { name: 'Camisa azul', description: 'Camisa de algodon', keywords: ['camisa', 'azul'], active: true, category: 'ropa' },
      { name: 'Pantalon', description: 'Pantalon negro', keywords: ['pantalon'], active: true, category: 'ropa' },
    ]);
    const items = await searchCatalog('u1', 'quiero una camisa');
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].name).toBe('Camisa azul');
  });

  test('sin catalogo => []', async () => {
    mockCatalogDb([]);
    const items = await searchCatalog('u1', 'hola');
    expect(items).toEqual([]);
  });

  test('message null => []', async () => {
    const items = await searchCatalog('u1', null);
    expect(items).toEqual([]);
  });

  test('buildCatalogContext con items => string correcto', () => {
    const items = [
      { name: 'Camisa', description: 'Camisa azul', price: 15, currency: 'USD' },
      { name: 'Pantalon', description: 'Pantalon negro', price: null, currency: 'USD' },
    ];
    const ctx = buildCatalogContext(items);
    expect(ctx).toMatch(/^Tienes disponible:/);
    expect(ctx).toContain('Camisa');
    expect(ctx).toContain('USD 15');
  });

  test('buildCatalogContext sin items => null', () => {
    expect(buildCatalogContext([])).toBeNull();
    expect(buildCatalogContext(null)).toBeNull();
  });
});

// ── CAT.3 ─────────────────────────────────────────────
describe('CAT.3 onboarding', () => {
  let mockSet, mockGet;

  function makeOnboardDb(state) {
    mockSet = jest.fn().mockResolvedValue(undefined);
    mockGet = jest.fn().mockResolvedValue({ exists: !!state, data: () => state });
    setOnboardDb({
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            doc: jest.fn(() => ({ get: mockGet, set: mockSet })),
          })),
        })),
      })),
    });
  }

  function makeOnboardApp(uid, state) {
    makeOnboardDb(state);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { uid }; next(); });
    app.use('/api/owner/onboarding', createOnboarding({ requireAuth: (req, res, next) => next() }));
    return app;
  }

  test('POST /start nuevo user => step 1', async () => {
    const res = await request(makeOnboardApp('u1', null)).post('/api/owner/onboarding/start');
    expect(res.status).toBe(200);
    expect(res.body.step).toBe(1);
    expect(mockSet).toHaveBeenCalledTimes(1);
  });

  test('POST /start ya completado => already_completed', async () => {
    const res = await request(makeOnboardApp('u1', { completed: true, step: 5 })).post('/api/owner/onboarding/start');
    expect(res.status).toBe(200);
    expect(res.body.already_completed).toBe(true);
  });

  test('GET /status sin wizard => step 1, not completed', async () => {
    const res = await request(makeOnboardApp('u1', null)).get('/api/owner/onboarding/status');
    expect(res.status).toBe(200);
    expect(res.body.step).toBe(1);
    expect(res.body.completed).toBe(false);
  });

  test('POST /complete-step/1 => next_step 2', async () => {
    const res = await request(makeOnboardApp('u1', { step: 1, steps_done: [] })).post('/api/owner/onboarding/complete-step/1');
    expect(res.status).toBe(200);
    expect(res.body.step_completed).toBe(1);
    expect(res.body.next_step).toBe(2);
    expect(res.body.completed).toBe(false);
  });

  test('complete todos los steps => completed=true', async () => {
    const res = await request(makeOnboardApp('u1', { step: 5, steps_done: [1,2,3,4] })).post('/api/owner/onboarding/complete-step/5');
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
  });

  test('step invalido => 400', async () => {
    const res = await request(makeOnboardApp('u1', null)).post('/api/owner/onboarding/complete-step/99');
    expect(res.status).toBe(400);
  });
});
