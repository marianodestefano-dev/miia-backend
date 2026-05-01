'use strict';

const request = require('supertest');
const express = require('express');
const admin = require('firebase-admin');

jest.mock('firebase-admin', () => {
  const mockFirestore = {
    collection: jest.fn(),
    doc: jest.fn(),
    collectionGroup: jest.fn(),
  };
  return {
    firestore: jest.fn(() => mockFirestore),
    _mockFs: mockFirestore,
  };
});

const createF1Routes = require('../routes/f1');

function buildApp() {
  const app = express();
  app.use(express.json());
  // Mock auth: inject uid into req.user
  app.use((req, res, next) => { req.user = { uid: 'testUid123' }; next(); });
  app.use('/api/f1', createF1Routes({ verifyToken: null }));
  return app;
}

function mockDoc(data, exists = true) {
  return { exists, data: () => data, id: data?.id || 'mockId' };
}

function mockCollection(docs) {
  const snap = { docs: docs.map(d => ({ id: d.id || 'id', data: () => d })), empty: docs.length === 0 };
  return { orderBy: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue(snap) };
}

describe('F1.3 — API endpoints F1', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test('GET /api/f1/calendar/2025 retorna lista de GPs', async () => {
    const fs = admin._mockFs;
    fs.collection.mockReturnValue(mockCollection([
      { id: 'monaco', name: 'GP Monaco', round: 8, date: '2025-05-25', status: 'completed' },
      { id: 'italy',  name: 'GP Italia', round: 16, date: '2025-09-07', status: 'scheduled' },
    ]));
    const res = await request(app).get('/api/f1/calendar/2025');
    expect(res.status).toBe(200);
    expect(res.body.gps).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });

  test('GET /api/f1/results/2025/monaco retorna resultado', async () => {
    const fs = admin._mockFs;
    fs.doc.mockReturnValue({ get: jest.fn().mockResolvedValue(mockDoc({ gp_id: 'monaco', positions: [{ position: 1, driver_name: 'Norris' }] })) });
    const res = await request(app).get('/api/f1/results/2025/monaco');
    expect(res.status).toBe(200);
    expect(res.body.gp_id).toBe('monaco');
  });

  test('GET /api/f1/results/2025/unknown retorna 404', async () => {
    const fs = admin._mockFs;
    fs.doc.mockReturnValue({ get: jest.fn().mockResolvedValue(mockDoc({}, false)) });
    const res = await request(app).get('/api/f1/results/2025/unknown');
    expect(res.status).toBe(404);
  });

  test('GET /api/f1/standings/drivers/2025 retorna pilotos', async () => {
    const fs = admin._mockFs;
    fs.collection.mockReturnValue(mockCollection([
      { id: 'norris', name: 'Lando Norris', team: 'McLaren', number: 4 },
    ]));
    const res = await request(app).get('/api/f1/standings/drivers/2025');
    expect(res.status).toBe(200);
    expect(res.body.drivers).toHaveLength(1);
  });

  test('GET /api/f1/standings/constructors/2025 agrupa por equipo', async () => {
    const fs = admin._mockFs;
    fs.collection.mockReturnValue(mockCollection([
      { id: 'norris',  team: 'McLaren', team_color: '#FF8000' },
      { id: 'piastri', team: 'McLaren', team_color: '#FF8000' },
      { id: 'hamilton',team: 'Ferrari', team_color: '#E8002D' },
    ]));
    const res = await request(app).get('/api/f1/standings/constructors/2025');
    expect(res.status).toBe(200);
    expect(res.body.constructors.length).toBe(2);
    expect(res.body.constructors.find(c => c.team === 'McLaren').drivers).toHaveLength(2);
  });

  test('GET /api/f1/driver/2025/norris retorna piloto', async () => {
    const fs = admin._mockFs;
    fs.doc.mockReturnValue({ get: jest.fn().mockResolvedValue(mockDoc({ name: 'Lando Norris', team: 'McLaren' })) });
    const res = await request(app).get('/api/f1/driver/2025/norris');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Lando Norris');
  });

  test('POST /api/f1/adopt guarda piloto adoptado', async () => {
    const fs = admin._mockFs;
    const setMock = jest.fn().mockResolvedValue(true);
    fs.doc.mockImplementation((path) => {
      if (path.includes('/drivers/')) return { get: jest.fn().mockResolvedValue(mockDoc({ name: 'Hamilton', team: 'Ferrari' })) };
      return { get: jest.fn().mockResolvedValue(mockDoc({})), set: setMock };
    });
    const res = await request(app).post('/api/f1/adopt').send({ driver_id: 'hamilton', season: '2025' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.adopted).toBe('hamilton');
    expect(setMock).toHaveBeenCalled();
  });

  test('POST /api/f1/adopt sin driver_id retorna 400', async () => {
    const res = await request(app).post('/api/f1/adopt').send({});
    expect(res.status).toBe(400);
  });

  test('GET /api/f1/prefs retorna prefs del owner', async () => {
    const fs = admin._mockFs;
    fs.doc.mockReturnValue({ get: jest.fn().mockResolvedValue(mockDoc({ uid: 'testUid123', adopted_driver: 'hamilton', notifications: true })) });
    const res = await request(app).get('/api/f1/prefs');
    expect(res.status).toBe(200);
    expect(res.body.adopted_driver).toBe('hamilton');
  });

  test('PATCH /api/f1/prefs actualiza notifications', async () => {
    const fs = admin._mockFs;
    const setMock = jest.fn().mockResolvedValue(true);
    fs.doc.mockReturnValue({ set: setMock });
    const res = await request(app).patch('/api/f1/prefs').send({ notifications: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ notifications: true }), { merge: true });
  });
});
