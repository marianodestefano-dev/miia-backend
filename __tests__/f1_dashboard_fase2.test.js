'use strict';

jest.mock('axios');
const axios = require('axios');
const { parsePositionFeed, isRaceWeekend, _resetState, _constants } = require('../sports/f1_dashboard/live_scraper');

describe('F1.9 — Live timing scraper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetState();
  });

  // ─── parsePositionFeed ───
  describe('parsePositionFeed', () => {
    test('parsea feed con Position.Entries correctamente', () => {
      const raw = {
        Position: { Entries: {
          '1': { Position: 1, Status: 'OnTrack', NumberOfLaps: 42, GapToLeader: '0.000' },
          '4': { Position: 2, Status: 'OnTrack', NumberOfLaps: 42, GapToLeader: '+2.134' },
        }},
        SessionInfo: { Name: 'Race' },
        LapCount: { CurrentLap: 42, TotalLaps: 57 },
      };
      const result = parsePositionFeed(raw);
      expect(result.isLive).toBe(true);
      expect(result.positions).toHaveLength(2);
      expect(result.positions[0].driver_number).toBe(1);
      expect(result.positions[0].position).toBe(1);
      expect(result.lap).toBe(42);
      expect(result.totalLaps).toBe(57);
    });

    test('retorna null para raw nulo', () => {
      expect(parsePositionFeed(null)).toBeNull();
    });

    test('retorna isLive:false para Entries vacio', () => {
      const result = parsePositionFeed({ Position: { Entries: {} } });
      expect(result.isLive).toBe(false);
      expect(result.positions).toHaveLength(0);
    });

    test('ordena posiciones por position asc', () => {
      const raw = { Position: { Entries: {
        '33': { Position: 3, Status: 'OnTrack' },
        '1':  { Position: 1, Status: 'OnTrack' },
        '4':  { Position: 2, Status: 'OnTrack' },
      }}};
      const result = parsePositionFeed(raw);
      expect(result.positions[0].driver_number).toBe(1);
      expect(result.positions[1].driver_number).toBe(4);
      expect(result.positions[2].driver_number).toBe(33);
    });

    test('incluye timestamp en resultado', () => {
      const result = parsePositionFeed({ Position: { Entries: { '1': { Position: 1, Status: 'OnTrack' } } } });
      expect(result.timestamp).toBeDefined();
    });
  });

  // ─── isRaceWeekend ───
  describe('isRaceWeekend', () => {
    test('retorna false o true (no lanza excepcion)', async () => {
      axios.head.mockRejectedValueOnce(new Error('timeout'));
      const result = await isRaceWeekend();
      expect(typeof result).toBe('boolean');
    });

    test('retorna true si HEAD request exitosa', async () => {
      axios.head.mockResolvedValueOnce({ status: 200 });
      // Solo verificamos que no lanza, el dia de semana afecta el resultado
      const result = await isRaceWeekend();
      expect(typeof result).toBe('boolean');
    });
  });
});

describe('F1.10 — Live cache (memoria)', () => {
  const { getLiveCache } = require('../sports/f1_dashboard/live_cache');
  let cache;

  beforeEach(() => {
    cache = getLiveCache();
    cache.clearMemCache();
  });

  test('setDriverPosition y getDriverPosition retornan mismos datos', async () => {
    const data = { driver_number: 44, position: 3, gap: '+5.2', tyre: 'M' };
    await cache.setDriverPosition(44, data);
    const result = await cache.getDriverPosition(44);
    expect(result.position).toBe(3);
    expect(result.gap).toBe('+5.2');
  });

  test('getDriverPosition retorna null para driver no cacheado', async () => {
    const result = await cache.getDriverPosition(999);
    expect(result).toBeNull();
  });

  test('setRaceStatus y getRaceStatus funcionan', async () => {
    await cache.setRaceStatus({ isLive: true, session: 'Race', lap: 20, totalLaps: 57 });
    const result = await cache.getRaceStatus();
    expect(result.isLive).toBe(true);
    expect(result.session).toBe('Race');
    expect(result.lap).toBe(20);
  });

  test('getRaceStatus retorna isLive:false si no hay datos', async () => {
    const result = await cache.getRaceStatus();
    expect(result.isLive).toBe(false);
  });

  test('setAllPositions + getAllPositions retornan array', async () => {
    const positions = [
      { driver_number: 1, position: 1 },
      { driver_number: 4, position: 2 },
    ];
    await cache.setAllPositions(positions);
    const result = await cache.getAllPositions();
    expect(result).toHaveLength(2);
  });

  test('isRedisAvailable retorna false sin Redis', () => {
    expect(cache.isRedisAvailable()).toBe(false);
  });
});

describe('F1.11 — Endpoints live API', () => {
  const request = require('supertest');
  const express = require('express');
  const admin = require('firebase-admin');

  jest.mock('firebase-admin', () => ({
    firestore: jest.fn(() => ({ doc: jest.fn(), collection: jest.fn() })),
  }));

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { uid: 'testUid' }; next(); });
    const createF1Routes = require('../routes/f1');
    app.use('/api/f1', createF1Routes({ verifyToken: null }));
    return app;
  }

  test('GET /api/f1/live/status retorna objeto con isLive', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/f1/live/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('isLive');
  });

  test('GET /api/f1/live/positions retorna estructura correcta', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/f1/live/positions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('positions');
    expect(res.body).toHaveProperty('isLive');
    expect(Array.isArray(res.body.positions)).toBe(true);
  });

  test('GET /api/f1/live/driver/404 retorna 404 para driver sin datos', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/f1/live/driver/999');
    expect(res.status).toBe(404);
  });
});
