'use strict';

/**
 * Tests R13-A — routes/privacy.js
 * 100% branch: GET /my-data (sin uid, OK, dateRange null, error 500),
 *              POST /request-deletion (sin uid, OK, error 500),
 *              createPrivacyRoutes sin opts (default requireAuth).
 */

const request = require('supertest');
const express = require('express');

// Variables prefijadas 'mock' para poder usarlas dentro de jest.mock() factory
let mockAddResolve = true;
let mockReportResolve = true;
let mockReportDateRange = '2026-01-01T00:00:00.000Z';

const mockFsMock = {
  collection: () => ({
    doc: () => ({
      collection: () => ({
        add: () => {
          if (!mockAddResolve) return Promise.reject(new Error('DB-ERROR-DELETION'));
          return Promise.resolve({ id: 'del_123' });
        },
      }),
    }),
  }),
};

jest.mock('firebase-admin', () => ({ firestore: () => mockFsMock }));

jest.mock('../core/privacy_report', () => ({
  buildPrivacyReport: jest.fn(async (uid) => {
    if (!mockReportResolve) throw new Error('REPORT-ERROR');
    return {
      uid,
      conversationsCount: 5,
      oldestConversationDate: mockReportDateRange,
      generatedAt: '2026-05-12T10:00:00.000Z',
      trainingDataSize: 512,
      personalBrainSize: 256,
      contactTypesCount: 3,
      staleCacheCount: 1,
    };
  }),
  __setFirestoreForTests: jest.fn(),
}));

// ── Setup app ──────────────────────────────────────────────────────────────
const createPrivacyRoutes = require('../routes/privacy');

// Inyectar DB mock
if (typeof createPrivacyRoutes.__setDbForTests === 'function') {
  createPrivacyRoutes.__setDbForTests(mockFsMock);
}

function buildApp(opts) {
  const app = express();
  app.use(express.json());
  app.use('/api/privacy', createPrivacyRoutes(opts));
  return app;
}

beforeEach(() => {
  mockAddResolve = true;
  mockReportResolve = true;
  mockReportDateRange = '2026-01-01T00:00:00.000Z';
});

// ── createPrivacyRoutes sin opts ───────────────────────────────────────────
describe('createPrivacyRoutes sin opts', () => {
  it('no lanza cuando se llama sin argumentos', () => {
    expect(() => createPrivacyRoutes()).not.toThrow();
  });

  it('no lanza cuando opts no tiene requireAuth', () => {
    expect(() => createPrivacyRoutes({})).not.toThrow();
  });
});

// ── GET /api/privacy/my-data ───────────────────────────────────────────────
describe('GET /api/privacy/my-data', () => {
  let app;
  beforeAll(() => { app = buildApp({}); });

  it('400 cuando no hay uid', async () => {
    const res = await request(app).get('/api/privacy/my-data');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('uid_required');
  });

  it('200 con datos y dateRange correcto', async () => {
    const res = await request(app).get('/api/privacy/my-data?uid=owner1');
    expect(res.status).toBe(200);
    expect(res.body.uid).toBe('owner1');
    expect(res.body.totalConversations).toBe(5);
    expect(res.body.dateRange).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-05-12T10:00:00.000Z',
    });
    expect(res.body.requestedAt).toBe('2026-05-12T10:00:00.000Z');
    expect(res.body.trainingDataSize).toBe(512);
    expect(res.body.contactTypesCount).toBe(3);
  });

  it('200 con dateRange null cuando oldestConversationDate es null', async () => {
    mockReportDateRange = null;
    const res = await request(app).get('/api/privacy/my-data?uid=owner2');
    expect(res.status).toBe(200);
    expect(res.body.dateRange).toBeNull();
  });

  it('500 cuando buildPrivacyReport lanza error', async () => {
    mockReportResolve = false;
    const res = await request(app).get('/api/privacy/my-data?uid=owner3');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('REPORT-ERROR');
  });

  it('200 con || 0 defaults cuando campos son undefined/null', async () => {
    // Cubrir ramas falsy de: conversationsCount||0, trainingDataSize||0, etc.
    const { buildPrivacyReport } = require('../core/privacy_report');
    buildPrivacyReport.mockResolvedValueOnce({
      uid: 'owner4',
      conversationsCount: 0,
      oldestConversationDate: null,
      generatedAt: '2026-05-12T11:00:00.000Z',
      trainingDataSize: 0,
      personalBrainSize: undefined,
      contactTypesCount: null,
      staleCacheCount: undefined,
    });
    const res = await request(app).get('/api/privacy/my-data?uid=owner4');
    expect(res.status).toBe(200);
    expect(res.body.totalConversations).toBe(0);
    expect(res.body.trainingDataSize).toBe(0);
    expect(res.body.personalBrainSize).toBe(0);
    expect(res.body.contactTypesCount).toBe(0);
    expect(res.body.staleCacheCount).toBe(0);
    expect(res.body.dateRange).toBeNull();
  });
});

// ── POST /api/privacy/request-deletion ────────────────────────────────────
describe('POST /api/privacy/request-deletion', () => {
  let app;
  beforeAll(() => { app = buildApp({}); });

  it('400 cuando no hay uid en body', async () => {
    const res = await request(app)
      .post('/api/privacy/request-deletion')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('uid_required');
  });

  it('200 con status pending cuando uid OK', async () => {
    mockAddResolve = true;
    const res = await request(app)
      .post('/api/privacy/request-deletion')
      .send({ uid: 'ownerX' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.uid).toBe('ownerX');
    expect(res.body.status).toBe('pending');
    expect(typeof res.body.requestedAt).toBe('string');
  });

  it('500 cuando Firestore lanza error', async () => {
    mockAddResolve = false;
    const res = await request(app)
      .post('/api/privacy/request-deletion')
      .send({ uid: 'ownerY' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DB-ERROR-DELETION');
  });
});
