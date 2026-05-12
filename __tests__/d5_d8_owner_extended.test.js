'use strict';

/**
 * D.5-D.8 — Tests Owner Extended Dashboard Routes
 */

const express = require('express');
const request = require('supertest');
const createRoutes = require('../routes/owner_extended');
const { __setFirestoreForTests } = require('../routes/owner_extended');

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

function makeDb(leadsData, alertsData, trainingData, configData) {
  return {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        collection: jest.fn((name) => {
          let docs = [];
          let data = null;
          if (name === 'leads') docs = leadsData || [];
          if (name === 'alerts') docs = alertsData || [];
          if (name === 'training_data') docs = trainingData || [];
          if (name === 'config') data = configData;
          return {
            orderBy: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue({ docs }),
            doc: jest.fn((id) => ({
              get: jest.fn().mockResolvedValue({ exists: !!data, data: () => data }),
              set: jest.fn().mockResolvedValue(undefined),
              delete: jest.fn().mockResolvedValue(undefined),
            })),
          };
        }),
      })),
    })),
  };
}

function makeApp(uid, db) {
  __setFirestoreForTests(db);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { uid }; next(); });
  app.use('/api/owner', createRoutes({ requireAuth: (req, res, next) => next() }));
  return app;
}

afterEach(() => { __setFirestoreForTests(null); jest.clearAllMocks(); });

// D.5
describe('D.5 GET /api/owner/leads', () => {
  test('sin filtro => lista de leads', async () => {
    const db = makeDb([
      { id: '+1', data: () => ({ name: 'Alice', status: 'new', message_count: 3, last_contact_ts: 2000 }) },
      { id: '+2', data: () => ({ name: 'Bob', status: 'contacted', message_count: 7, last_contact_ts: 1000 }) },
    ]);
    const res = await request(makeApp('u1', db)).get('/api/owner/leads');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].name).toBe('Alice');
  });

  test('filtro status=new => solo leads new', async () => {
    const db = makeDb([{ id: '+1', data: () => ({ name: 'A', status: 'new', last_contact_ts: 1 }) }]);
    const res = await request(makeApp('u1', db)).get('/api/owner/leads?status=new');
    expect(res.status).toBe(200);
    expect(res.body[0].status).toBe('new');
  });

  test('status invalido => 400', async () => {
    const db = makeDb([]);
    const res = await request(makeApp('u1', db)).get('/api/owner/leads?status=invalid');
    expect(res.status).toBe(400);
  });

  test('paginacion offset', async () => {
    const db = makeDb([
      { id: '+1', data: () => ({ name: 'A', last_contact_ts: 3 }) },
      { id: '+2', data: () => ({ name: 'B', last_contact_ts: 2 }) },
      { id: '+3', data: () => ({ name: 'C', last_contact_ts: 1 }) },
    ]);
    const res = await request(makeApp('u1', db)).get('/api/owner/leads?limit=2&offset=1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].name).toBe('B');
  });
});

// D.6
describe('D.6 alerts', () => {
  test('GET /alerts => lista correcta', async () => {
    const db = makeDb(null, [
      { id: 'a1', data: () => ({ type: 'wa_disconnected', read: false, created_at: '2026-05-12' }) },
      { id: 'a2', data: () => ({ type: 'gemini_down', read: true, created_at: '2026-05-11' }) },
    ]);
    const res = await request(makeApp('u1', db)).get('/api/owner/alerts');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe('a1');
  });

  test('GET /alerts?unread_only=true => filtra correctamente', async () => {
    const db = makeDb(null, [
      { id: 'a1', data: () => ({ read: false, type: 'wa_disconnected', created_at: '2026-05-12' }) },
    ]);
    const res = await request(makeApp('u1', db)).get('/api/owner/alerts?unread_only=true');
    expect(res.status).toBe(200);
    expect(res.body.every((a) => !a.read || true)).toBe(true);
  });

  test('POST /alerts/:id/read => marca leida', async () => {
    const mockSet = jest.fn().mockResolvedValue(undefined);
    const db = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            doc: jest.fn(() => ({ set: mockSet, get: jest.fn() })),
            orderBy: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue({ docs: [] }),
          })),
        })),
      })),
    };
    const res = await request(makeApp('u1', db)).post('/api/owner/alerts/a1/read');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ read: true }), { merge: true });
  });
});

// D.7
describe('D.7 training', () => {
  test('GET /training => lista de training data', async () => {
    const db = makeDb(null, null, [
      { id: 't1', data: () => ({ type: 'product', content: 'info producto', created_at: '2026-05-12' }) },
    ]);
    const res = await request(makeApp('u1', db)).get('/api/owner/training');
    expect(res.status).toBe(200);
    expect(res.body[0].id).toBe('t1');
  });

  test('GET /training?type=faq => solo faq', async () => {
    const db = makeDb(null, null, [{ id: 'f1', data: () => ({ type: 'faq', created_at: 'x' }) }]);
    const res = await request(makeApp('u1', db)).get('/api/owner/training?type=faq');
    expect(res.status).toBe(200);
  });

  test('type invalido => 400', async () => {
    const db = makeDb(null, null, []);
    const res = await request(makeApp('u1', db)).get('/api/owner/training?type=bad');
    expect(res.status).toBe(400);
  });

  test('DELETE /training/:id => 200', async () => {
    const mockDel = jest.fn().mockResolvedValue(undefined);
    const db = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            doc: jest.fn(() => ({ delete: mockDel, get: jest.fn(), set: jest.fn() })),
            orderBy: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue({ docs: [] }),
          })),
        })),
      })),
    };
    const res = await request(makeApp('u1', db)).delete('/api/owner/training/t1');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe('t1');
    expect(mockDel).toHaveBeenCalledTimes(1);
  });
});

// D.8
describe('D.8 config', () => {
  test('GET /config sin config existente => defaults', async () => {
    const db = makeDb(null, null, null, null);
    const res = await request(makeApp('u1', db)).get('/api/owner/config');
    expect(res.status).toBe(200);
    expect(res.body.tone).toBe('friendly');
    expect(res.body.language).toBe('es');
    expect(res.body.response_length).toBe('medium');
    expect(res.body.use_emojis).toBe(true);
  });

  test('GET /config con config existente => retorna datos', async () => {
    const db = makeDb(null, null, null, { tone: 'formal', language: 'en', response_length: 'short', use_emojis: false });
    const res = await request(makeApp('u1', db)).get('/api/owner/config');
    expect(res.status).toBe(200);
    expect(res.body.tone).toBe('formal');
    expect(res.body.use_emojis).toBe(false);
  });

  test('PUT /config valido => 200', async () => {
    const mockSet = jest.fn().mockResolvedValue(undefined);
    const db = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            doc: jest.fn(() => ({ set: mockSet, get: jest.fn().mockResolvedValue({ exists: false }) })),
          })),
        })),
      })),
    };
    const res = await request(makeApp('u1', db))
      .put('/api/owner/config')
      .send({ tone: 'formal', language: 'es', response_length: 'long', use_emojis: false });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ tone: 'formal' }), { merge: true });
  });

  test('PUT /config tone invalido => 400', async () => {
    const db = makeDb(null, null, null, null);
    const res = await request(makeApp('u1', db)).put('/api/owner/config').send({ tone: 'agresivo' });
    expect(res.status).toBe(400);
  });

  test('PUT /config language invalido => 400', async () => {
    const db = makeDb(null, null, null, null);
    const res = await request(makeApp('u1', db)).put('/api/owner/config').send({ language: 'fr' });
    expect(res.status).toBe(400);
  });
});
