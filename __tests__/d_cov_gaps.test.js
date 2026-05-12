'use strict';

/**
 * COV gaps — D.1-D.8 branch coverage complement
 * Covers: catch blocks + falsy branches
 */

const express = require('express');
const request = require('supertest');
const createDashboard = require('../routes/owner_dashboard');
const createExtended = require('../routes/owner_extended');
const dm = require('../core/daily_metrics');
const em = require('../core/episodic_memory');

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  createDashboard.__setFirestoreForTests(null);
  createExtended.__setFirestoreForTests(null);
  dm.__setFirestoreForTests(null);
  dm.__setAdminForTests(null);
  em.__setFirestoreForTests(null);
  jest.clearAllMocks();
});

// ── Helper: throws DB ─────────────────────────────────────────────────────────
function makeThrowingDb(throwOn) {
  // throwOn: 'get' | 'set' | 'delete'
  const mockFn = jest.fn().mockRejectedValue(new Error('DB error'));
  const mockOk = jest.fn().mockResolvedValue({ exists: false, data: () => ({}) });
  const mockSet = jest.fn().mockResolvedValue(undefined);
  const mockDel = jest.fn().mockResolvedValue(undefined);
  const mdGet = throwOn === 'get' ? mockFn : mockOk;
  const mdSet = throwOn === 'set' ? mockFn : mockSet;
  const mdDel = throwOn === 'delete' ? mockFn : mockDel;
  const md = jest.fn().mockReturnValue({ get: mdGet, set: mdSet, delete: mdDel });
  const snapGet = throwOn === 'get' ? mockFn : jest.fn().mockResolvedValue({ docs: [], size: 0 });
  const mc = jest.fn().mockReturnValue({
    doc: md,
    orderBy: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    get: snapGet,
  });
  const mod = jest.fn().mockReturnValue({ get: mdGet, set: mdSet, collection: mc });
  return { collection: jest.fn().mockReturnValue({ doc: mod }) };
}

function makeOkDb(ownerData, convList) {
  ownerData = ownerData || {};
  convList = convList || [];
  const ownerGet = jest.fn().mockResolvedValue({ exists: true, data: () => ownerData });
  const ownerSet = jest.fn().mockResolvedValue(undefined);
  const convGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({ messages: [] }) });
  const snapGet = jest.fn().mockResolvedValue({ docs: convList.map(function(c) { return { id: c.phone, data: () => c }; }), size: convList.length });
  const memSnapGet = jest.fn().mockResolvedValue({ size: 0 });
  const md = jest.fn().mockReturnValue({ get: convGet, set: ownerSet, delete: jest.fn().mockResolvedValue(undefined) });
  const mc = jest.fn().mockImplementation(function(col) {
    return {
      doc: md,
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: col === 'episodic_memory' ? memSnapGet : snapGet,
    };
  });
  const mod = jest.fn().mockReturnValue({ get: ownerGet, set: ownerSet, collection: mc });
  return { collection: jest.fn().mockReturnValue({ doc: mod }) };
}

function makeApp(uid, db, getWaConnected) {
  createDashboard.__setFirestoreForTests(db);
  const app = express();
  app.use(express.json());
  app.use(function(req, res, next) { req.user = { uid: uid }; next(); });
  app.use('/api', createDashboard({
    requireAuth: function(req, res, next) { next(); },
    getWaConnected: getWaConnected || function() { return true; },
  }));
  return app;
}

function makeExtApp(uid, db) {
  createExtended.__setFirestoreForTests(db);
  const app = express();
  app.use(express.json());
  app.use(function(req, res, next) { req.user = { uid: uid }; next(); });
  app.use('/api', createExtended({ requireAuth: function(req, res, next) { next(); } }));
  return app;
}

// ── D.1 catch block + week metrics true branch ───────────────────────────────
describe('D.1 summary COV gaps', () => {
  test('GET /summary DB throws => 500', async () => {
    const res = await request(makeApp('u1', makeThrowingDb('get'))).get('/api/summary');
    expect(res.status).toBe(500);
  });

  test('GET /summary con metrics semana (if dm true branch)', async () => {
    // Set up daily_metrics to return data
    const dmMockGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({ messages_received: 5, messages_sent: 3, leads_new: 2, leads_responded: 1 }) });
    const dmMockDoc = jest.fn().mockReturnValue({ get: dmMockGet, set: jest.fn() });
    const dmMc = jest.fn().mockReturnValue({ doc: dmMockDoc });
    const dmMod = jest.fn().mockReturnValue({ collection: dmMc });
    dm.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: dmMod }) });
    dm.__setAdminForTests({ firestore: { FieldValue: { increment: function(n) { return n; } } } });

    const res = await request(makeApp('u1', makeOkDb())).get('/api/summary');
    expect(res.status).toBe(200);
    // week metrics should include the dm data
    expect(res.body.stats_week.messages).toBeGreaterThan(0);
  });

  test('GET /summary ownerDoc no existe => plan=free', async () => {
    const db2 = makeOkDb({});
    // Override the owner get to not-exist
    const ownerGet = jest.fn().mockResolvedValue({ exists: false, data: () => ({}) });
    const md2 = jest.fn().mockReturnValue({ get: ownerGet, set: jest.fn(), delete: jest.fn() });
    const mc2 = jest.fn().mockReturnValue({
      doc: md2,
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ docs: [], size: 0 }),
    });
    const mod2 = jest.fn().mockReturnValue({ get: ownerGet, set: jest.fn(), collection: mc2 });
    createDashboard.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod2 }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createDashboard({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).get('/api/summary');
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('free');
    expect(res.body.phone).toBeNull();
  });
});

// ── D.2 catch block ──────────────────────────────────────────────────────────
describe('D.2 conversations list COV gaps', () => {
  test('GET /conversations DB throws => 500', async () => {
    const res = await request(makeApp('u1', makeThrowingDb('get'))).get('/api/conversations');
    expect(res.status).toBe(500);
  });
});

// ── D.3 catch block + memory null branch ─────────────────────────────────────
describe('D.3 conversation detail COV gaps', () => {
  test('GET /conversations/:phone DB throws => 500', async () => {
    const res = await request(makeApp('u1', makeThrowingDb('get'))).get('/api/conversations/%2B57');
    expect(res.status).toBe(500);
  });

  test('GET /conversations/:phone con memory => memory_facts', async () => {
    // memory has key_facts -> hits memory && memory.key_facts true branch
    const emMg = jest.fn().mockResolvedValue({ exists: true, data: () => ({ key_facts: [{ fact: 'a', confidence: 'high' }] }) });
    const emMd = jest.fn().mockReturnValue({ get: emMg });
    const emMc = jest.fn().mockReturnValue({ doc: emMd });
    const emMod = jest.fn().mockReturnValue({ collection: emMc });
    em.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: emMod }) });

    const convGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({ messages: [{ from: '+57', text: 'hola', ts: 1000, fromMe: false }], name: 'Test' }) });
    const md2 = jest.fn().mockReturnValue({ get: convGet });
    const mc2 = jest.fn().mockReturnValue({ doc: md2, orderBy: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ docs: [] }) });
    const mod2 = jest.fn().mockReturnValue({ get: convGet, collection: mc2 });
    createDashboard.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod2 }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createDashboard({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).get('/api/conversations/%2B57123');
    expect(res.status).toBe(200);
    expect(res.body.memory_facts).toHaveLength(1);
  });

  test('GET /conversations/:phone: message con fromMe=true => from MIIA', async () => {
    const convGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({
      messages: [
        { fromMe: true, text: 'respuesta', ts: 2000 },
        { fromMe: false, text: 'hola', ts: 1000, from: '+57' },
      ],
      name: 'Test'
    }) });
    const md2 = jest.fn().mockReturnValue({ get: convGet });
    const mc2 = jest.fn().mockReturnValue({ doc: md2, orderBy: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ docs: [] }) });
    const mod2 = jest.fn().mockReturnValue({ get: convGet, collection: mc2 });
    createDashboard.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod2 }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createDashboard({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).get('/api/conversations/%2B57');
    expect(res.status).toBe(200);
    expect(res.body.messages[0].from).toBe('MIIA');
  });
});

// ── D.4 catch blocks ─────────────────────────────────────────────────────────
describe('D.4 miia status COV gaps', () => {
  test('POST /miia/pause DB throws => 500', async () => {
    const res = await request(makeApp('u1', makeThrowingDb('set'))).post('/api/miia/pause').send({ reason: 'test' });
    expect(res.status).toBe(500);
  });

  test('POST /miia/resume DB throws => 500', async () => {
    const res = await request(makeApp('u1', makeThrowingDb('set'))).post('/api/miia/resume');
    expect(res.status).toBe(500);
  });

  test('GET /miia/status DB throws => 500', async () => {
    const res = await request(makeApp('u1', makeThrowingDb('get'))).get('/api/miia/status');
    expect(res.status).toBe(500);
  });

  test('GET /miia/status doc no existe => active=true', async () => {
    const ownerGet = jest.fn().mockResolvedValue({ exists: false });
    const md2 = jest.fn().mockReturnValue({ get: ownerGet, set: jest.fn() });
    const mc2 = jest.fn().mockReturnValue({ doc: md2, orderBy: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ docs: [] }) });
    const mod2 = jest.fn().mockReturnValue({ get: ownerGet, collection: mc2 });
    createDashboard.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod2 }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createDashboard({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).get('/api/miia/status');
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
  });
});

// ── D.5-D.8 catch blocks ─────────────────────────────────────────────────────
describe('D.5-D.8 extended routes catch blocks', () => {
  function makeExtThrowDb() {
    const throwFn = jest.fn().mockRejectedValue(new Error('DB error'));
    const noopSet = jest.fn().mockResolvedValue(undefined);
    const md = jest.fn().mockReturnValue({ get: throwFn, set: noopSet, delete: throwFn });
    const mc = jest.fn().mockReturnValue({
      doc: md,
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: throwFn,
    });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    return { collection: jest.fn().mockReturnValue({ doc: mod }) };
  }

  function makeExtSetThrowDb() {
    const noopGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({}) });
    const throwSet = jest.fn().mockRejectedValue(new Error('DB error'));
    const noopDel = jest.fn().mockResolvedValue(undefined);
    const md = jest.fn().mockReturnValue({ get: noopGet, set: throwSet, delete: noopDel });
    const mc = jest.fn().mockReturnValue({
      doc: md,
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: noopGet,
    });
    const mod = jest.fn().mockReturnValue({ collection: mc });
    return { collection: jest.fn().mockReturnValue({ doc: mod }) };
  }

  test('GET /leads DB throws => 500', async () => {
    const res = await request(makeExtApp('u1', makeExtThrowDb())).get('/api/leads');
    expect(res.status).toBe(500);
  });

  test('GET /alerts DB throws => 500', async () => {
    const res = await request(makeExtApp('u1', makeExtThrowDb())).get('/api/alerts');
    expect(res.status).toBe(500);
  });

  test('POST /alerts/:id/read DB throws => 500', async () => {
    const res = await request(makeExtApp('u1', makeExtSetThrowDb())).post('/api/alerts/alert1/read');
    expect(res.status).toBe(500);
  });

  test('GET /training DB throws => 500', async () => {
    const res = await request(makeExtApp('u1', makeExtThrowDb())).get('/api/training');
    expect(res.status).toBe(500);
  });

  test('DELETE /training/:id DB throws => 500', async () => {
    const throwDel = jest.fn().mockRejectedValue(new Error('DB error'));
    const md2 = jest.fn().mockReturnValue({ delete: throwDel });
    const mc2 = jest.fn().mockReturnValue({ doc: md2, orderBy: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ docs: [] }) });
    const mod2 = jest.fn().mockReturnValue({ collection: mc2 });
    createExtended.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod2 }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createExtended({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).delete('/api/training/t1');
    expect(res.status).toBe(500);
  });

  test('GET /config DB throws => 500', async () => {
    const res = await request(makeExtApp('u1', makeExtThrowDb())).get('/api/config');
    expect(res.status).toBe(500);
  });

  test('PUT /config DB throws => 500', async () => {
    const res = await request(makeExtApp('u1', makeExtSetThrowDb())).put('/api/config').send({ tone: 'formal' });
    expect(res.status).toBe(500);
  });

  test('PUT /config language invalido => 400', async () => {
    const res = await request(makeExtApp('u1', makeExtSetThrowDb())).put('/api/config').send({ language: 'fr' });
    expect(res.status).toBe(400);
  });

  test('PUT /config response_length invalido => 400', async () => {
    const res = await request(makeExtApp('u1', makeExtSetThrowDb())).put('/api/config').send({ response_length: 'extra-long' });
    expect(res.status).toBe(400);
  });
});


// ── 401 branches for all D routes ────────────────────────────────────────────
describe('D routes 401 no-uid branches', () => {
  function makeNoUidApp(createRoutes, db) {
    createRoutes.__setFirestoreForTests(db || makeOkDb());
    const app = express();
    app.use(express.json());
    // no req.user set
    app.use('/api', createRoutes({ requireAuth: function(req, res, next) { next(); } }));
    return app;
  }

  const noUserDb = makeOkDb;

  test('GET /summary sin usuario => 401', async () => {
    const app = makeNoUidApp(createDashboard);
    const res = await request(app).get('/api/summary');
    expect(res.status).toBe(401);
  });

  test('GET /conversations sin usuario => 401', async () => {
    const app = makeNoUidApp(createDashboard);
    const res = await request(app).get('/api/conversations');
    expect(res.status).toBe(401);
  });

  test('GET /conversations/:phone sin usuario => 401', async () => {
    const app = makeNoUidApp(createDashboard);
    const res = await request(app).get('/api/conversations/%2B57');
    expect(res.status).toBe(401);
  });

  test('POST /miia/pause sin usuario => 401', async () => {
    const app = makeNoUidApp(createDashboard);
    const res = await request(app).post('/api/miia/pause');
    expect(res.status).toBe(401);
  });

  test('POST /miia/resume sin usuario => 401', async () => {
    const app = makeNoUidApp(createDashboard);
    const res = await request(app).post('/api/miia/resume');
    expect(res.status).toBe(401);
  });

  test('GET /miia/status sin usuario => 401', async () => {
    const app = makeNoUidApp(createDashboard);
    const res = await request(app).get('/api/miia/status');
    expect(res.status).toBe(401);
  });

  // Extended routes
  test('GET /leads sin usuario => 401', async () => {
    const app = makeNoUidApp(createExtended);
    const res = await request(app).get('/api/leads');
    expect(res.status).toBe(401);
  });

  test('GET /alerts sin usuario => 401', async () => {
    const app = makeNoUidApp(createExtended);
    const res = await request(app).get('/api/alerts');
    expect(res.status).toBe(401);
  });

  test('POST /alerts/:id/read sin usuario => 401', async () => {
    const app = makeNoUidApp(createExtended);
    const res = await request(app).post('/api/alerts/a1/read');
    expect(res.status).toBe(401);
  });

  test('GET /training sin usuario => 401', async () => {
    const app = makeNoUidApp(createExtended);
    const res = await request(app).get('/api/training');
    expect(res.status).toBe(401);
  });

  test('DELETE /training/:id sin usuario => 401', async () => {
    const app = makeNoUidApp(createExtended);
    const res = await request(app).delete('/api/training/t1');
    expect(res.status).toBe(401);
  });

  test('GET /config sin usuario => 401', async () => {
    const app = makeNoUidApp(createExtended);
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(401);
  });

  test('PUT /config sin usuario => 401', async () => {
    const app = makeNoUidApp(createExtended);
    const res = await request(app).put('/api/config').send({ tone: 'formal' });
    expect(res.status).toBe(401);
  });
});

// ── Falsy field branches ──────────────────────────────────────────────────────
describe('D routes falsy field branches', () => {
  test('GET /conversations: doc sin name ni last_message', async () => {
    // d.name || doc.id, d.last_message || '', d.tag || d.contact_type || unknown, d.unread_count || 0
    const convList = [{ phone: '+57', /* no name, no last_message, no tag */ }];
    const res = await request(makeApp('u1', makeOkDb({}, convList))).get('/api/conversations');
    expect(res.status).toBe(200);
  });

  test('GET /conversations/:phone: message con body y timestamp (no text ni ts)', async () => {
    // m.text is undefined -> m.body || ''; m.ts is undefined -> m.timestamp
    const convGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({
      messages: [{ fromMe: false, body: 'cuerpo', timestamp: 9999 }],
      name: 'Test'
    }) });
    const md2 = jest.fn().mockReturnValue({ get: convGet });
    const mc2 = jest.fn().mockReturnValue({ doc: md2, orderBy: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ docs: [] }) });
    const mod2 = jest.fn().mockReturnValue({ get: convGet, collection: mc2 });
    createDashboard.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod2 }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createDashboard({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).get('/api/conversations/%2B57');
    expect(res.status).toBe(200);
    expect(res.body.messages[0].text).toBe('cuerpo');
    expect(res.body.messages[0].ts).toBe(9999);
  });

  test('D.4 pause: sin body.reason => reason=manual (falsy branch)', async () => {
    const db2 = makeOkDb();
    let capturedData = null;
    const setFn = jest.fn().mockImplementation(function(data) { capturedData = data; return Promise.resolve(); });
    const mdx = jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue({ exists: true, data: () => ({}) }), set: setFn });
    const mcx = jest.fn().mockReturnValue({ doc: mdx, orderBy: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ docs: [] }) });
    const modx = jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue({ exists: true, data: () => ({}) }), set: setFn, collection: mcx });
    createDashboard.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: modx }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createDashboard({ requireAuth: function(req, res, next) { next(); } }));
    // No body -> req.body && req.body.reason is falsy -> 'manual'
    const res = await request(app).post('/api/miia/pause');
    expect(res.status).toBe(200);
  });

  test('D.8 GET /config: doc no existe => usa defaults', async () => {
    const noexist = jest.fn().mockResolvedValue({ exists: false });
    const md3 = jest.fn().mockReturnValue({ get: noexist });
    const mc3 = jest.fn().mockReturnValue({ doc: md3, orderBy: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ docs: [] }) });
    const mod3 = jest.fn().mockReturnValue({ collection: mc3 });
    createExtended.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod3 }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createExtended({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.tone).toBe('friendly');
    expect(res.body.use_emojis).toBe(true);
  });

  test('D.8 GET /config: use_emojis definido en doc => usa el valor del doc', async () => {
    // cfg.use_emojis !== undefined branch (true case)
    const docGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({ tone: 'formal', language: 'en', response_length: 'short', use_emojis: false }) });
    const md4 = jest.fn().mockReturnValue({ get: docGet });
    const mc4 = jest.fn().mockReturnValue({ doc: md4, orderBy: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ docs: [] }) });
    const mod4 = jest.fn().mockReturnValue({ collection: mc4 });
    createExtended.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod4 }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createExtended({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.use_emojis).toBe(false);
  });

  test('D.4 miia/status: wa_connected via opts.getWaConnected', async () => {
    // Covers getWaConnected(uid) call
    const res = await request(makeApp('u1', makeOkDb(), function(uid) { return uid === 'u1'; })).get('/api/miia/status');
    expect(res.status).toBe(200);
    expect(res.body.wa_connected).toBe(true);
  });
});

describe('D routes default opts branches', () => {
  test('createOwnerDashboardRoutes sin opts => usa defaults', () => {
    const routes = createDashboard();
    expect(routes).toBeDefined();
  });

  test('createOwnerExtendedRoutes sin opts => usa defaults', () => {
    const routes = createExtended();
    expect(routes).toBeDefined();
  });
});


// ── Remaining falsy-branch gaps ───────────────────────────────────────────────
describe('D.1 summary falsy field branches', () => {
  test('GET /summary: todayMetrics.messages_received falsy + week dm sin messages', async () => {
    // Hit dm.messages_received || 0 false branch and dm.leads_new || 0 false branch
    const dmMg = jest.fn().mockResolvedValue({ exists: true, data: () => ({
      // no messages_received, no messages_sent, no leads_new, no leads_responded
      gemini_errors: 0,
    }) });
    const dmMd = jest.fn().mockReturnValue({ get: dmMg, set: jest.fn() });
    const dmMc = jest.fn().mockReturnValue({ doc: dmMd });
    const dmMod = jest.fn().mockReturnValue({ collection: dmMc });
    dm.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: dmMod }) });
    dm.__setAdminForTests({ firestore: { FieldValue: { increment: function(n) { return n; } } } });

    const res = await request(makeApp('u1', makeOkDb())).get('/api/summary');
    expect(res.status).toBe(200);
    // All || 0 false branches should fire
    expect(res.body.stats_week.messages).toBe(0);
  });
});

describe('D.3 conversation detail falsy field branches', () => {
  function makeConvApp(uid, convData) {
    const convGet = jest.fn().mockResolvedValue({ exists: true, data: () => convData });
    const md2 = jest.fn().mockReturnValue({ get: convGet });
    const mc2 = jest.fn().mockReturnValue({
      doc: md2,
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ docs: [] }),
    });
    const mod2 = jest.fn().mockReturnValue({ get: convGet, collection: mc2 });
    createDashboard.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod2 }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: uid }; next(); });
    app.use('/api', createDashboard({ requireAuth: function(req, res, next) { next(); } }));
    return app;
  }

  test('message sin text ni body ni ts ni timestamp => defaults', async () => {
    // m.text || m.body || '' -> '' (both falsy)
    // m.ts || m.timestamp || null -> null (both falsy)
    const convData = {
      messages: [{ fromMe: false /* no text, no body, no ts, no timestamp */ }],
      // no name
    };
    const res = await request(makeConvApp('u1', convData)).get('/api/conversations/%2B57');
    expect(res.status).toBe(200);
    expect(res.body.messages[0].text).toBe('');
    expect(res.body.messages[0].ts).toBeNull();
    expect(res.body.contact_info.name).toBe('+57'); // convData.name || phone -> phone
  });

  test('convData sin messages => messages=[]', async () => {
    // convData.messages || [] -> [] false branch
    const convData = { /* no messages field */ name: 'Test' };
    const res = await request(makeConvApp('u1', convData)).get('/api/conversations/%2B57');
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });

  test('message fromMe false without from field => from=phone', async () => {
    // m.from || (m.fromMe ? 'MIIA' : phone) -> phone (m.fromMe false, m.from missing)
    const convData = {
      messages: [{ fromMe: false, text: 'hola' }],
      name: 'Test'
    };
    const res = await request(makeConvApp('u1', convData)).get('/api/conversations/%2B57ABC');
    expect(res.status).toBe(200);
    expect(res.body.messages[0].from).toBe('+57ABC');
  });
});

describe('D.5 leads falsy field branches', () => {
  test('GET /leads: lead sin name, first_contact_ts, last_contact_ts, message_count, memory_facts', async () => {
    // d.name || doc.id, d.first_contact_ts || null, d.last_contact_ts || null,
    // d.message_count || 0, d.memory_facts || []
    const snap = {
      docs: [{ id: '+57lead', data: () => ({ status: 'new' /* nothing else */ }) }],
    };
    const mockGet = jest.fn().mockResolvedValue(snap);
    const md3 = jest.fn().mockReturnValue({ get: jest.fn() });
    const mc3 = jest.fn().mockReturnValue({
      doc: md3,
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: mockGet,
    });
    const mod3 = jest.fn().mockReturnValue({ collection: mc3 });
    createExtended.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod3 }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createExtended({ requireAuth: function(req, res, next) { next(); } }));
    const res = await request(app).get('/api/leads');
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('+57lead'); // uses doc.id
    expect(res.body[0].first_contact_ts).toBeNull();
    expect(res.body[0].message_count).toBe(0);
  });
});

describe('D.8 PUT /config: individual field update branches', () => {
  function makeConfigApp(uid) {
    const docSet = jest.fn().mockResolvedValue(undefined);
    const md3 = jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue({ exists: true, data: () => ({}) }), set: docSet });
    const mc3 = jest.fn().mockReturnValue({ doc: md3 });
    const mod3 = jest.fn().mockReturnValue({ collection: mc3 });
    createExtended.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod3 }) });
    const app = express();
    app.use(express.json());
    app.use(function(req, res, next) { req.user = { uid: uid }; next(); });
    app.use('/api', createExtended({ requireAuth: function(req, res, next) { next(); } }));
    return app;
  }

  test('PUT /config solo response_length valido => ok', async () => {
    // body.response_length !== undefined -> true branch for update.response_length
    const res = await request(makeConfigApp('u1')).put('/api/config').send({ response_length: 'short' });
    expect(res.status).toBe(200);
    expect(res.body.response_length).toBe('short');
  });

  test('PUT /config solo use_emojis => ok', async () => {
    // body.use_emojis !== undefined -> true branch for update.use_emojis
    const res = await request(makeConfigApp('u1')).put('/api/config').send({ use_emojis: false });
    expect(res.status).toBe(200);
    expect(res.body.use_emojis).toBe(false);
  });

  test('PUT /config tone+language invalidos juntos => 400 con ambos errores', async () => {
    // Both tone and language invalid -> errors array has 2 items
    const res = await request(makeConfigApp('u1')).put('/api/config').send({ tone: 'xxxx', language: 'fr' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('tone invalido');
    expect(res.body.error).toContain('language invalido');
  });
});


describe('D.8 PUT /config: req.body falsy branch (line 165)', () => {
  test('PUT /config sin Content-Type => body=undefined -> usa {}', async () => {
    // Without express.json parsing, req.body is undefined -> || {} fires false branch
    const docSet = jest.fn().mockResolvedValue(undefined);
    const md5 = jest.fn().mockReturnValue({ get: jest.fn(), set: docSet });
    const mc5 = jest.fn().mockReturnValue({ doc: md5 });
    const mod5 = jest.fn().mockReturnValue({ collection: mc5 });
    createExtended.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: mod5 }) });

    // Create app WITHOUT express.json() to leave req.body = undefined
    const app = require('express')();
    // No express.json() middleware!
    app.use(function(req, res, next) { req.user = { uid: 'u1' }; next(); });
    app.use('/api', createExtended({ requireAuth: function(req, res, next) { next(); } }));
    // Send raw request without JSON body
    const res = await require('supertest')(app).put('/api/config');
    // Should succeed with empty update (no fields to validate, no errors)
    expect(res.status).toBe(200);
  });
});
