'use strict';

jest.mock('./live_scraper', function() {
  return {
    start: jest.fn(),
    stop: jest.fn(),
    getState: jest.fn().mockReturnValue({ isLive: false, circuitOpen: false, lastSuccessAt: null }),
  };
}, { virtual: true });

jest.mock('./live_cache', function() {
  return {
    getLiveCache: jest.fn().mockReturnValue({
      getAllPositions: jest.fn().mockResolvedValue([]),
      getRaceStatus: jest.fn().mockResolvedValue({ isLive: false }),
      getDriverPosition: jest.fn().mockResolvedValue(null),
    }),
  };
}, { virtual: true });

const request = require('supertest');
// Load app directly via require with mocked deps
let app;
beforeAll(function() {
  jest.resetModules();
  jest.mock('../sports/f1_dashboard/live_scraper', function() {
    return {
      start: jest.fn(),
      stop: jest.fn(),
      getState: jest.fn().mockReturnValue({ isLive: false }),
    };
  });
  jest.mock('../sports/f1_dashboard/live_cache', function() {
    return {
      getLiveCache: jest.fn().mockReturnValue({
        getAllPositions: jest.fn().mockResolvedValue([{ position: 1, driverName: 'Norris', team: 'McLaren' }]),
        getRaceStatus: jest.fn().mockResolvedValue({ isLive: true }),
        getDriverPosition: jest.fn().mockImplementation(function(num) {
          if (String(num) === '4') return Promise.resolve({ position: 1, driverName: 'Norris' });
          return Promise.resolve(null);
        }),
      }),
    };
  });
  const svc = require('../sports/f1_dashboard/f1_service');
  app = svc.app;
  svc.server.close();
});

describe('F1.16 -- F1 Railway service', function() {
  test('GET /health retorna status ok', async function() {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET /state retorna estado del scraper', async function() {
    const res = await request(app).get('/state');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('isLive');
  });

  test('GET /positions retorna posiciones', async function() {
    const res = await request(app).get('/positions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('positions');
    expect(res.body).toHaveProperty('raceStatus');
  });

  test('GET /driver/4 retorna datos del driver', async function() {
    const res = await request(app).get('/driver/4');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('driverName');
  });

  test('GET /driver/999 retorna 404', async function() {
    const res = await request(app).get('/driver/999');
    expect(res.status).toBe(404);
  });
});
