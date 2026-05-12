'use strict';

/**
 * D.1-D.4 — Tests Owner Dashboard Routes
 */

const express = require('express');
const request = require('supertest');
const createRoutes = require('../routes/owner_dashboard');
const { __setFirestoreForTests } = require('../routes/owner_dashboard');
const dm = require('../core/daily_metrics');
const em = require('../core/episodic_memory');

jest.spyOn(console, 'log').mockImplementation(() => {});

// Helper to build mock Firestore
function makeMockDb(ownerData, convData, convDetailData, memSnap) {
  const docMocks = {};

  // owners/{uid}
  docMocks['owner'] = {
    get: jest.fn().mockResolvedValue({ exists: !!ownerData, data: () => ownerData }),
    set: jest.fn().mockResolvedValue(undefined),
    collection: jest.fn((name) => {
      if (name === 'metrics') {
        return {
          doc: jest.fn().mockReturnValue({
            get: jest.fn().mockResolvedValue({ exists: false, data: () => null }),
            set: jest.fn().mockResolvedValue(undefined),
          }),
        };
      }
      if (name === 'episodic_memory') {
        return {
          get: jest.fn().mockResolvedValue({ size: memSnap || 0, docs: [] }),
          doc: jest.fn().mockReturnValue({
            get: jest.fn().mockResolvedValue({ exists: false }),
          }),
        };
      }
      if (name === 'tenant_conversations') {
        return {
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          get: jest.fn().mockResolvedValue({
            docs: convData || [],
          }),
          doc: jest.fn((phone) => ({
            get: jest.fn().mockResolvedValue({
              exists: !!convDetailData,
              data: () => convDetailData,
            }),
          })),
        };
      }
      return { get: jest.fn().mockResolvedValue({ docs: [], size: 0 }) };
    }),
  };

  const mockDb = {
    collection: jest.fn((coll) => ({
      doc: jest.fn(() => docMocks['owner']),
    })),
  };
  return mockDb;
}

function makeApp(uid, ownerData, opts) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { uid }; next(); });
  app.use('/api/owner', createRoutes({
    requireAuth: (req, res, next) => next(),
    getWaConnected: opts && opts.getWaConnected,
  }));
  return app;
}

afterEach(() => {
  __setFirestoreForTests(null);
  dm.__setFirestoreForTests(null);
  em.__setFirestoreForTests(null);
  jest.clearAllMocks();
});

// ── D.1 ──────────────────────────────────────────────────────────
describe('D.1 GET /api/owner/summary', () => {
  test('con datos => 200 con estructura correcta', async () => {
    const mockDb = makeMockDb({ phone: '+573', plan: 'pro', f1_active: true }, null, null, 5);
    __setFirestoreForTests(mockDb);
    dm.__setFirestoreForTests({
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            doc: jest.fn(() => ({
              set: jest.fn().mockResolvedValue(undefined),
              get: jest.fn().mockResolvedValue({ exists: false }),
            })),
          })),
        })),
      })),
    });
    const app = makeApp('uid1', null, { getWaConnected: () => true });
    const res = await request(app).get('/api/owner/summary');
    expect(res.status).toBe(200);
    expect(res.body.uid).toBe('uid1');
    expect(res.body.plan).toBe('pro');
    expect(res.body.wa_connected).toBe(true);
    expect(res.body.f1_active).toBe(true);
    expect(res.body.stats_today).toBeDefined();
    expect(res.body.stats_week).toBeDefined();
    expect(res.body.memory_contacts_count).toBeDefined();
  });

  test('sin datos => zeros', async () => {
    const mockDb = makeMockDb(null, null, null, 0);
    __setFirestoreForTests(mockDb);
    dm.__setFirestoreForTests({
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            doc: jest.fn(() => ({
              get: jest.fn().mockResolvedValue({ exists: false }),
              set: jest.fn().mockResolvedValue(undefined),
            })),
          })),
        })),
      })),
    });
    const app = makeApp('uid1', null, {});
    const res = await request(app).get('/api/owner/summary');
    expect(res.status).toBe(200);
    expect(res.body.stats_today.messages).toBe(0);
    expect(res.body.stats_today.leads_new).toBe(0);
    expect(res.body.f1_active).toBe(false);
  });

  test('wa disconnected => wa_connected falsy', async () => {
    const mockDb = makeMockDb({}, null, null, 0);
    __setFirestoreForTests(mockDb);
    dm.__setFirestoreForTests({
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            doc: jest.fn(() => ({
              get: jest.fn().mockResolvedValue({ exists: false }),
              set: jest.fn().mockResolvedValue(undefined),
            })),
          })),
        })),
      })),
    });
    const app = makeApp('uid1', null, { getWaConnected: () => false });
    const res = await request(app).get('/api/owner/summary');
    expect(res.status).toBe(200);
    expect(res.body.wa_connected).toBe(false);
  });
});

// ── D.2 ──────────────────────────────────────────────────────────
describe('D.2 GET /api/owner/conversations', () => {
  test('retorna lista paginada ordenada por last_ts', async () => {
    const convDocs = [
      { id: '+573A', data: () => ({ name: 'Alice', last_message: 'Hola', last_ts: 2000, tag: 'lead', unread_count: 2 }) },
      { id: '+573B', data: () => ({ name: 'Bob', last_message: 'Info', last_ts: 1000, tag: 'client', unread_count: 0 }) },
    ];
    const mockDb = makeMockDb({}, convDocs);
    __setFirestoreForTests(mockDb);
    const app = makeApp('uid1', null, {});
    const res = await request(app).get('/api/owner/conversations?limit=10&offset=0');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].phone).toBe('+573A');
    expect(res.body[0].tag).toBe('lead');
    expect(res.body[0].unread_count).toBe(2);
  });

  test('paginacion offset correcto', async () => {
    const convDocs = [
      { id: '+1', data: () => ({ last_ts: 3, last_message: 'a', tag: 'lead' }) },
      { id: '+2', data: () => ({ last_ts: 2, last_message: 'b', tag: 'client' }) },
      { id: '+3', data: () => ({ last_ts: 1, last_message: 'c', tag: 'unknown' }) },
    ];
    const mockDb = makeMockDb({}, convDocs);
    __setFirestoreForTests(mockDb);
    const app = makeApp('uid1', null, {});
    const res = await request(app).get('/api/owner/conversations?limit=2&offset=1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].phone).toBe('+2');
  });
});

// ── D.3 ──────────────────────────────────────────────────────────
describe('D.3 GET /api/owner/conversations/:phone', () => {
  test('conversacion existente => 200 con messages y memory_facts', async () => {
    const convDetail = {
      name: 'Alice',
      tag: 'lead',
      messages: [
        { fromMe: false, text: 'Hola', ts: 1000 },
        { fromMe: true, text: 'Bienvenida', ts: 2000 },
      ],
    };
    const mockDb = makeMockDb({}, null, convDetail);
    __setFirestoreForTests(mockDb);
    em.__setFirestoreForTests({
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            doc: jest.fn(() => ({
              get: jest.fn().mockResolvedValue({ exists: false }),
            })),
          })),
        })),
      })),
    });
    const app = makeApp('uid1', null, {});
    const res = await request(app).get('/api/owner/conversations/%2B573A');
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.contact_info.tag).toBe('lead');
    expect(Array.isArray(res.body.memory_facts)).toBe(true);
  });

  test('no existente => 404', async () => {
    const mockDb = makeMockDb({}, null, null);
    __setFirestoreForTests(mockDb);
    const app = makeApp('uid1', null, {});
    const res = await request(app).get('/api/owner/conversations/%2B000');
    expect(res.status).toBe(404);
  });
});

// ── D.4 ──────────────────────────────────────────────────────────
describe('D.4 MIIA pause/resume/status', () => {
  let mockSet, mockGet;

  beforeEach(() => {
    mockSet = jest.fn().mockResolvedValue(undefined);
    mockGet = jest.fn();
    const mockOwnerDoc = {
      get: mockGet,
      set: mockSet,
      collection: jest.fn(() => ({
        get: jest.fn().mockResolvedValue({ size: 0 }),
        doc: jest.fn(() => ({ get: jest.fn().mockResolvedValue({ exists: false }) })),
      })),
    };
    __setFirestoreForTests({
      collection: jest.fn(() => ({ doc: jest.fn(() => mockOwnerDoc) })),
    });
  });

  test('POST /miia/pause => miia_paused=true', async () => {
    const app = makeApp('uid1', null, {});
    const res = await request(app).post('/api/owner/miia/pause');
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(true);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ miia_paused: true }),
      { merge: true }
    );
  });

  test('POST /miia/resume => miia_paused=false', async () => {
    const app = makeApp('uid1', null, {});
    const res = await request(app).post('/api/owner/miia/resume');
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(false);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ miia_paused: false }),
      { merge: true }
    );
  });

  test('GET /miia/status con paused=true', async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ miia_paused: true, paused_at: '2026-05-12T10:00:00Z', paused_reason: 'manual' }),
    });
    const app = makeApp('uid1', null, {});
    const res = await request(app).get('/api/owner/miia/status');
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(res.body.paused_at).toBeTruthy();
  });

  test('GET /miia/status con paused=false => active=true', async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ miia_paused: false }),
    });
    const app = makeApp('uid1', null, {});
    const res = await request(app).get('/api/owner/miia/status');
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
  });
});
