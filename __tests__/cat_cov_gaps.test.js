'use strict';

/**
 * COV gaps — CAT.1-4 branch coverage complement
 */

const express = require('express');
const request = require('supertest');
const createCatalog = require('../routes/catalog');
const { searchCatalog, buildCatalogContext, __setFirestoreForTests: setSearchDb } = require('../core/catalog_search');
const createOnboarding = require('../routes/onboarding');

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

afterEach(() => {
  createCatalog.__setFirestoreForTests(null);
  setSearchDb(null);
  createOnboarding.__setFirestoreForTests(null);
  jest.clearAllMocks();
});

// ── CAT.1 catch blocks ────────────────────────────────────────────────────────
describe('CAT.1 catalog catch blocks', () => {
  function makeThrowDb(throwOn) {
    const throwFn = jest.fn().mockRejectedValue(new Error('DB error'));
    const noopFn = jest.fn().mockResolvedValue(undefined);
    const md = jest.fn().mockReturnValue({
      add: throwOn === 'add' ? throwFn : noopFn,
      get: throwOn === 'get' ? throwFn : jest.fn().mockResolvedValue({ docs: [], empty: true }),
      set: throwOn === 'set' ? throwFn : noopFn,
    });
    const mc = jest.fn().mockReturnValue({
      add: throwOn === 'add' ? throwFn : noopFn,
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      get: throwOn === 'get' ? throwFn : jest.fn().mockResolvedValue({ docs: [] }),
      doc: md,
    });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    return { collection: jest.fn().mockReturnValue({ doc: mod }) };
  }

  function makeApp(uid, db) {
    createCatalog.__setFirestoreForTests(db);
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: uid }; next(); });
    app.use('/api', createCatalog({ requireAuth: function(req, res, next) { next(); } }));
    return app;
  }

  test('POST /catalog DB throws => 500', async () => {
    // Need to make the add() throw
    const throwAdd = jest.fn().mockRejectedValue(new Error('DB error'));
    const md = jest.fn().mockReturnValue({ add: throwAdd });
    const mc = jest.fn().mockReturnValue({ add: throwAdd, doc: md });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    createCatalog.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createCatalog({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).post('/api').send({ name: 'X', description: 'Y' });
    expect(res.status).toBe(500);
  });

  test('GET /catalog DB throws => 500', async () => {
    const res = await request(makeApp('u1', makeThrowDb('get'))).get('/api');
    expect(res.status).toBe(500);
  });

  test('PUT /catalog/:id DB throws => 500', async () => {
    const throwSet = jest.fn().mockRejectedValue(new Error('DB error'));
    const md = jest.fn().mockReturnValue({ set: throwSet });
    const mc = jest.fn().mockReturnValue({ doc: md });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    createCatalog.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createCatalog({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).put('/api/item1').send({ price: 5 });
    expect(res.status).toBe(500);
  });

  test('DELETE /catalog/:id DB throws => 500', async () => {
    const throwSet = jest.fn().mockRejectedValue(new Error('DB error'));
    const md = jest.fn().mockReturnValue({ set: throwSet });
    const mc = jest.fn().mockReturnValue({ doc: md });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    createCatalog.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createCatalog({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).delete('/api/item1');
    expect(res.status).toBe(500);
  });

  test('GET /catalog?active=false => incluye inactivos', async () => {
    // activeOnly = false branch (req.query.active === 'false')
    const mockGet = jest.fn().mockResolvedValue({ docs: [] });
    const mc = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      get: mockGet,
      doc: jest.fn(),
    });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    createCatalog.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createCatalog({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).get('/api?active=false');
    expect(res.status).toBe(200);
  });

  test('GET /catalog?category=ropa => filtra por category', async () => {
    // category truthy branch
    const mockGet = jest.fn().mockResolvedValue({ docs: [] });
    const mc = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      get: mockGet,
      doc: jest.fn(),
    });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    createCatalog.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createCatalog({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).get('/api?category=ropa');
    expect(res.status).toBe(200);
  });

  test('POST /catalog sin uid => 401', async () => {
    createCatalog.__setFirestoreForTests({ collection: jest.fn() });
    const app = express();
    app.use(express.json());
    // no req.user
    app.use('/api', createCatalog({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).post('/api').send({ name: 'X', description: 'Y' });
    expect(res.status).toBe(401);
  });

  test('POST /catalog con keywords array y campos opcionales', async () => {
    // keywords array branch + image_url + price + category (all set)
    const mockAdd = jest.fn().mockResolvedValue({ id: 'new-id' });
    const mc = jest.fn().mockReturnValue({ add: mockAdd, doc: jest.fn() });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    createCatalog.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createCatalog({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).post('/api').send({
      name: 'X', description: 'Y', price: 10, currency: 'COP',
      category: 'ropa', image_url: 'http://img', keywords: ['camiseta'],
    });
    expect(res.status).toBe(201);
    expect(res.body.keywords).toEqual(['camiseta']);
    expect(res.body.category).toBe('ropa');
  });
});

// ── CAT.2 catalog_search catch block ─────────────────────────────────────────
describe('CAT.2 catalog_search catch block', () => {
  test('searchCatalog DB throws => []', async () => {
    setSearchDb({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnThis(),
            get: jest.fn().mockRejectedValue(new Error('DB error')),
          }),
        }),
      }),
    });
    const items = await searchCatalog('u1', 'hola');
    expect(items).toEqual([]);
  });

  test('_scoreItem: item sin keywords => score solo por name', async () => {
    // keywords || [] false branch + category false branch
    setSearchDb({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue({
              empty: false,
              docs: [{ data: () => ({ name: 'camisa', description: 'ropa', active: true, /* no keywords, no category */ }) }],
            }),
          }),
        }),
      }),
    });
    const items = await searchCatalog('u1', 'camisa');
    expect(items).toHaveLength(1);
  });
});

// ── CAT.3 onboarding catch blocks + branch gaps ───────────────────────────────
describe('CAT.3 onboarding catch blocks', () => {
  function makeThrowOnboardDb() {
    const throwFn = jest.fn().mockRejectedValue(new Error('DB error'));
    const md = jest.fn().mockReturnValue({ get: throwFn, set: throwFn });
    createOnboarding.__setFirestoreForTests({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            doc: jest.fn().mockReturnValue({ get: throwFn, set: throwFn }),
          }),
        }),
      }),
    });
  }

  function makeOnboardApp(uid, state) {
    const mockSet = jest.fn().mockResolvedValue(undefined);
    const mockGet = jest.fn().mockResolvedValue({ exists: !!state, data: () => state });
    createOnboarding.__setFirestoreForTests({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            doc: jest.fn().mockReturnValue({ get: mockGet, set: mockSet }),
          }),
        }),
      }),
    });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: uid }; next(); });
    app.use('/api/owner/onboarding', createOnboarding({ requireAuth: function(req, res, next) { next(); } }));
    return { app, mockSet, mockGet };
  }

  function makeThrowApp(uid) {
    makeThrowOnboardDb();
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: uid }; next(); });
    app.use('/api/owner/onboarding', createOnboarding({ requireAuth: function(req, res, next) { next(); } }));
    return app;
  }

  test('POST /start DB throws => 500', async () => {
    const res = await request(makeThrowApp('u1')).post('/api/owner/onboarding/start');
    expect(res.status).toBe(500);
  });

  test('GET /status DB throws => 500', async () => {
    const res = await request(makeThrowApp('u1')).get('/api/owner/onboarding/status');
    expect(res.status).toBe(500);
  });

  test('GET /status doc existe con step y steps_done', async () => {
    // doc.exists = true branch -> returns step, completed, steps_done
    const { app } = makeOnboardApp('u1', { step: 2, completed: false, steps_done: [1] });
    const res = await request(app).get('/api/owner/onboarding/status');
    expect(res.status).toBe(200);
    expect(res.body.step).toBe(2);
    expect(res.body.steps_done).toEqual([1]);
  });

  test('GET /status doc existe sin step ni steps_done => usa defaults', async () => {
    // d.step || 1 false branch, d.steps_done || [] false branch
    const { app } = makeOnboardApp('u1', { completed: false });
    const res = await request(app).get('/api/owner/onboarding/status');
    expect(res.status).toBe(200);
    expect(res.body.step).toBe(1);
    expect(res.body.steps_done).toEqual([]);
  });

  test('POST /complete-step/:n DB throws => 500', async () => {
    const res = await request(makeThrowApp('u1')).post('/api/owner/onboarding/complete-step/1');
    expect(res.status).toBe(500);
  });

  test('POST /complete-step/:n: doc no existe => current defaults', async () => {
    // doc.exists ? ... : { step: 1, steps_done: [] } false branch
    const { app } = makeOnboardApp('u1', null); // doc no existe
    const res = await request(app).post('/api/owner/onboarding/complete-step/3');
    expect(res.status).toBe(200);
    expect(res.body.step_completed).toBe(3);
  });

  test('POST /complete-step/:n: current.steps_done undefined => usa []', async () => {
    // (current.steps_done || []) false branch when steps_done is missing
    const { app } = makeOnboardApp('u1', { step: 1, /* no steps_done */ });
    const res = await request(app).post('/api/owner/onboarding/complete-step/2');
    expect(res.status).toBe(200);
  });

  test('POST /start: doc existe sin step ni steps_done => usa defaults', async () => {
    // doc.data().step -> undefined -> uses step as is
    const { app } = makeOnboardApp('u1', { completed: false /* no step, no steps_done */ });
    const res = await request(app).post('/api/owner/onboarding/start');
    expect(res.status).toBe(200);
  });
});

describe('CAT routes sin uid => 401', () => {
  function makeNoUidApp(createFn, path) {
    createFn.__setFirestoreForTests({ collection: jest.fn() });
    const app = express();
    app.use(express.json());
    app.use(path, createFn({ requireAuth: function(req, res, next) { next(); } }));
    return app;
  }

  test('GET /catalog sin uid => 401', async () => {
    const res = await request(makeNoUidApp(createCatalog, '/api')).get('/api');
    expect(res.status).toBe(401);
  });

  test('PUT /catalog/:id sin uid => 401', async () => {
    const res = await request(makeNoUidApp(createCatalog, '/api')).put('/api/i1').send({});
    expect(res.status).toBe(401);
  });

  test('DELETE /catalog/:id sin uid => 401', async () => {
    const res = await request(makeNoUidApp(createCatalog, '/api')).delete('/api/i1');
    expect(res.status).toBe(401);
  });

  test('POST /onboarding/start sin uid => 401', async () => {
    createOnboarding.__setFirestoreForTests({ collection: jest.fn() });
    const app = express();
    app.use('/api', createOnboarding({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).post('/api/start');
    expect(res.status).toBe(401);
  });

  test('GET /onboarding/status sin uid => 401', async () => {
    createOnboarding.__setFirestoreForTests({ collection: jest.fn() });
    const app = express();
    app.use('/api', createOnboarding({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(401);
  });

  test('POST /onboarding/complete-step sin uid => 401', async () => {
    createOnboarding.__setFirestoreForTests({ collection: jest.fn() });
    const app = express();
    app.use('/api', createOnboarding({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).post('/api/complete-step/1');
    expect(res.status).toBe(401);
  });
});


// ── CAT.4 extra branch coverage ──────────────────────────────────────────────
describe('CAT.4 catalog no-opts + req.body falsy branches', () => {
  test('createCatalogRoutes sin opts => usa default requireAuth', () => {
    createCatalog.__setFirestoreForTests({ collection: jest.fn() });
    const routes = createCatalog();
    expect(routes).toBeDefined();
  });

  test('POST /catalog sin express.json => req.body=undefined -> || {} -> 400', async () => {
    // req.body || {} fires the false branch when body is undefined
    const mockAdd = jest.fn().mockResolvedValue({ id: 'x' });
    const mc = jest.fn().mockReturnValue({ add: mockAdd, doc: jest.fn() });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    createCatalog.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod }) });
    const app = require('express')();
    // NO express.json() so req.body = undefined
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createCatalog({ requireAuth: function(req, res, next) { next(); } }));
    const res = await require('supertest')(app).post('/api').send('raw');
    // body = {} => missing name+description => 400
    expect(res.status).toBe(400);
  });

  test('PUT /catalog/:id sin express.json => req.body=undefined -> || {} -> 200', async () => {
    const mockSet = jest.fn().mockResolvedValue(undefined);
    const md = jest.fn().mockReturnValue({ set: mockSet });
    const mc = jest.fn().mockReturnValue({ doc: md });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    createCatalog.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod }) });
    const app = require('express')();
    // NO express.json() -> req.body = undefined -> || {}
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createCatalog({ requireAuth: function(req, res, next) { next(); } }));
    const res = await require('supertest')(app).put('/api/item1');
    expect(res.status).toBe(200);
  });
});

describe('CAT.4 createOnboardingRoutes sin opts', () => {
  test('createOnboardingRoutes sin opts => usa default requireAuth', () => {
    createOnboarding.__setFirestoreForTests({ collection: jest.fn() });
    const routes = createOnboarding();
    expect(routes).toBeDefined();
  });
});

describe('CAT.4 catalog_search branch gaps', () => {
  test('searchCatalog con limit explicito => respeta el limit (branch limit!==undefined)', async () => {
    // limit is explicitly passed -> the "if (limit === undefined)" branch is NOT taken
    setSearchDb({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue({
              empty: false,
              docs: [
                { data: () => ({ name: 'A', description: 'a', active: true }) },
                { data: () => ({ name: 'B', description: 'b', active: true }) },
                { data: () => ({ name: 'C', description: 'c', active: true }) },
              ],
            }),
          }),
        }),
      }),
    });
    const items = await searchCatalog('u1', 'a b c', 2);
    expect(items.length).toBeLessThanOrEqual(2);
  });

  test('searchCatalog item con category que coincide con mensaje => score += 1', async () => {
    // item.category = 'ropa', message includes 'ropa' -> category && includes() both true
    setSearchDb({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue({
              empty: false,
              docs: [{ data: () => ({ name: 'Camisa', description: 'tela', active: true, category: 'ropa' }) }],
            }),
          }),
        }),
      }),
    });
    const items = await searchCatalog('u1', 'quiero ropa');
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Camisa');
  });

  test('searchCatalog uid falsy => []', async () => {
    const items = await searchCatalog(null, 'hola');
    expect(items).toEqual([]);
  });
});
