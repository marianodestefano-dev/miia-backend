'use strict';

/**
 * Tests P1.2 — routes/privacy.js endpoints MMC (my-mmc-data, export-mmc, delete-mmc-category)
 */

const request = require('supertest');
const express = require('express');

// Mock mmc_view via jest.mock
let mockGetReturn = null;
let mockGetThrow = false;
let mockExportReturn = null;
let mockExportThrow = false;
let mockDeleteReturn = null;
let mockDeleteThrow = null; // string message si throw

jest.mock('../core/privacy/mmc_view', () => ({
  getMyMmcData: jest.fn(async (uid) => {
    if (mockGetThrow) throw new Error('MMC_GET_ERROR');
    return mockGetReturn || { uid, summary: { totalEpisodios: 0 } };
  }),
  exportMmc: jest.fn(async (uid) => {
    if (mockExportThrow) throw new Error('MMC_EXPORT_ERROR');
    return mockExportReturn || { uid, exportFormat: 'gdpr_v1', episodios: [], graduadas: [], baseline: null };
  }),
  deleteMmcCategory: jest.fn(async (uid, category) => {
    if (mockDeleteThrow) throw new Error(mockDeleteThrow);
    return mockDeleteReturn || { ok: true, deleted: 0, category };
  }),
  __setFirestoreForTests: jest.fn(),
}));

jest.mock('../core/privacy_report', () => ({
  buildPrivacyReport: jest.fn(),
  __setFirestoreForTests: jest.fn(),
}));

jest.mock('firebase-admin', () => ({
  firestore: () => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({ add: jest.fn().mockResolvedValue({}) }),
      }),
    }),
  }),
}));

const createPrivacyRoutes = require('../routes/privacy');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/privacy', createPrivacyRoutes({}));
  return app;
}

beforeEach(() => {
  mockGetReturn = null;
  mockGetThrow = false;
  mockExportReturn = null;
  mockExportThrow = false;
  mockDeleteReturn = null;
  mockDeleteThrow = null;
});

// ── GET /api/privacy/my-mmc-data ──────────────────────────────────────────────

describe('GET /api/privacy/my-mmc-data', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  test('400 sin uid', async () => {
    const res = await request(app).get('/api/privacy/my-mmc-data');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('uid_required');
  });

  test('200 con datos', async () => {
    mockGetReturn = {
      uid: 'owner1',
      summary: { totalEpisodios: 5, totalLessons: 12 },
      episodios: [{ episodeId: 'e1' }],
      graduadas: ['g1'],
      baseline: { idiomaBase: 'es' },
    };
    const res = await request(app).get('/api/privacy/my-mmc-data?uid=owner1');
    expect(res.status).toBe(200);
    expect(res.body.summary.totalEpisodios).toBe(5);
  });

  test('500 cuando getMyMmcData lanza', async () => {
    mockGetThrow = true;
    const res = await request(app).get('/api/privacy/my-mmc-data?uid=owner2');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('MMC_GET_ERROR');
  });
});

// ── GET /api/privacy/export-mmc ───────────────────────────────────────────────

describe('GET /api/privacy/export-mmc', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  test('400 sin uid', async () => {
    const res = await request(app).get('/api/privacy/export-mmc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('uid_required');
  });

  test('200 con headers de attachment', async () => {
    mockExportReturn = {
      uid: 'owner1',
      exportFormat: 'gdpr_v1',
      exportedAt: '2026-05-12',
      episodios: [],
      graduadas: [],
      baseline: null,
      disclaimer: 'X',
    };
    const res = await request(app).get('/api/privacy/export-mmc?uid=owner1');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('miia-export-');
    expect(res.body.exportFormat).toBe('gdpr_v1');
  });

  test('500 cuando exportMmc lanza', async () => {
    mockExportThrow = true;
    const res = await request(app).get('/api/privacy/export-mmc?uid=owner2');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('MMC_EXPORT_ERROR');
  });
});

// ── POST /api/privacy/delete-mmc-category ────────────────────────────────────

describe('POST /api/privacy/delete-mmc-category', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  test('400 sin uid', async () => {
    const res = await request(app)
      .post('/api/privacy/delete-mmc-category')
      .send({ category: 'episodios' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('uid_required');
  });

  test('400 sin category', async () => {
    const res = await request(app)
      .post('/api/privacy/delete-mmc-category')
      .send({ uid: 'owner1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('category_required');
  });

  test('200 OK con uid y category', async () => {
    mockDeleteReturn = { ok: true, deleted: 5, category: 'episodios' };
    const res = await request(app)
      .post('/api/privacy/delete-mmc-category')
      .send({ uid: 'owner1', category: 'episodios' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(5);
  });

  test('400 cuando category_invalido (mmc_view lanza)', async () => {
    mockDeleteThrow = 'category_invalido: foo';
    const res = await request(app)
      .post('/api/privacy/delete-mmc-category')
      .send({ uid: 'owner1', category: 'foo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('category_invalido');
  });

  test('500 cuando otro error', async () => {
    mockDeleteThrow = 'firestore_dead';
    const res = await request(app)
      .post('/api/privacy/delete-mmc-category')
      .send({ uid: 'owner1', category: 'episodios' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('firestore_dead');
  });
});
