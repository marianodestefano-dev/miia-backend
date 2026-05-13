'use strict';

/**
 * Tests endpoint GET /api/f1/live/circuit/:circuit_id — circuitos REALES + dots OpenF1.
 * Firma Mariano 2026-05-12 ~22:30 COT.
 */

// Mock circuit_live_service ANTES de require routes
jest.mock('../sports/f1_dashboard/circuit_live_service', () => ({
  buildLiveCircuitSvg: jest.fn(),
}));
jest.mock('../sports/f1_dashboard/f1_paywall', () => ({
  hasF1Addon: jest.fn().mockResolvedValue(true),
  requireF1Addon: () => (req, res, next) => next(),
}));

// Mock firebase-admin antes de requerir routes
let mockDocExists = true;
let mockDocData = { adopted_driver_number: 4 };
jest.mock('firebase-admin', () => ({
  firestore: () => ({
    doc: () => ({
      get: async () => ({
        exists: mockDocExists,
        data: () => mockDocData,
      }),
    }),
    collection: () => ({
      orderBy: () => ({ get: async () => ({ docs: [] }) }),
      where: () => ({
        where: () => ({
          limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
        }),
      }),
    }),
  }),
}));

const express = require('express');
const request = require('supertest');
const circuitLiveService = require('../sports/f1_dashboard/circuit_live_service');
const createF1Routes = require('../routes/f1');

const auth = (req, res, next) => {
  req.user = { uid: 'uid-test' };
  next();
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/f1', createF1Routes({ verifyToken: auth }));
  return app;
}

beforeEach(() => {
  circuitLiveService.buildLiveCircuitSvg.mockReset();
  mockDocExists = true;
  mockDocData = { adopted_driver_number: 4 };
});

describe('GET /api/f1/live/circuit/:circuit_id — SVG live', () => {
  test('200 con SVG live + headers (isLive=true)', async () => {
    circuitLiveService.buildLiveCircuitSvg.mockResolvedValue({
      svg: '<svg>...drivers...</svg>',
      isLive: true,
      sessionKey: 9999,
      driverCount: 20,
    });
    const r = await request(makeApp()).get('/api/f1/live/circuit/monaco');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/svg/);
    expect(r.headers['cache-control']).toBe('public, max-age=2');
    expect(r.headers['x-miiaf1-live']).toBe('1');
    expect(r.headers['x-miiaf1-session']).toBe('9999');
    expect(r.headers['x-miiaf1-drivers']).toBe('20');
    // supertest entrega svg como Buffer; convertimos a string
    const body = r.body && r.body.toString ? r.body.toString() : r.text;
    expect(body).toContain('<svg');
  });

  test('200 con SVG estático (isLive=false, sin carrera)', async () => {
    circuitLiveService.buildLiveCircuitSvg.mockResolvedValue({
      svg: '<svg>...static...</svg>',
      isLive: false,
      sessionKey: null,
      driverCount: 0,
    });
    const r = await request(makeApp()).get('/api/f1/live/circuit/monaco');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    expect(r.headers['x-miiaf1-live']).toBe('0');
    expect(r.headers['x-miiaf1-session']).toBe('');
    expect(r.headers['x-miiaf1-drivers']).toBe('0');
  });

  test('404 si circuit_id no resoluble (buildLiveCircuitSvg svg=null)', async () => {
    circuitLiveService.buildLiveCircuitSvg.mockResolvedValue({
      svg: null,
      isLive: false,
      sessionKey: null,
      driverCount: 0,
    });
    const r = await request(makeApp()).get('/api/f1/live/circuit/zzz_unknown');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Circuito no encontrado');
  });

  test('owner con adopted_driver_number propaga al service', async () => {
    mockDocData = { adopted_driver_number: 16 };
    circuitLiveService.buildLiveCircuitSvg.mockResolvedValue({
      svg: '<svg/>',
      isLive: true,
      sessionKey: 1,
      driverCount: 1,
    });
    await request(makeApp()).get('/api/f1/live/circuit/monaco');
    const args = circuitLiveService.buildLiveCircuitSvg.mock.calls[0][0];
    expect(args.adoptedDriverNum).toBe(16);
  });

  test('owner sin prefs (doc no exists) → adoptedDriverNum null', async () => {
    mockDocExists = false;
    circuitLiveService.buildLiveCircuitSvg.mockResolvedValue({
      svg: '<svg/>',
      isLive: true,
      sessionKey: 1,
      driverCount: 1,
    });
    await request(makeApp()).get('/api/f1/live/circuit/monaco');
    const args = circuitLiveService.buildLiveCircuitSvg.mock.calls[0][0];
    expect(args.adoptedDriverNum).toBeNull();
  });

  test('owner sin adopted_driver_number en prefs → null', async () => {
    mockDocData = { other: 'x' };
    circuitLiveService.buildLiveCircuitSvg.mockResolvedValue({
      svg: '<svg/>',
      isLive: true,
      sessionKey: 1,
      driverCount: 1,
    });
    await request(makeApp()).get('/api/f1/live/circuit/monaco');
    const args = circuitLiveService.buildLiveCircuitSvg.mock.calls[0][0];
    expect(args.adoptedDriverNum).toBeNull();
  });
});
