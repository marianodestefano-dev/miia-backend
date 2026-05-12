"use strict";

// Cubre GET /api/f1/status — routes/f1.js lineas 338-342

jest.mock('firebase-admin', () => {
  const fsFn = () => ({
    doc: () => ({
      get: jest.fn().mockResolvedValue({ exists: false, data: () => null }),
      set: jest.fn().mockResolvedValue(undefined),
    }),
    collection: () => {
      const c = {
        where: function() { return this; }, orderBy: function() { return this; },
        limit: function() { return this; },
        get: jest.fn().mockResolvedValue({ docs: [], empty: true }),
        add: jest.fn().mockResolvedValue({ id: 'x' }),
      };
      return c;
    },
    collectionGroup: () => {
      const c = { where: function() { return this; }, get: jest.fn().mockResolvedValue({ docs: [] }) };
      return c;
    },
    batch: () => ({ set: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) }),
  });
  fsFn.FieldValue = { arrayUnion: () => ({}), arrayRemove: () => ({}), increment: () => ({}) };
  return { firestore: fsFn };
});

jest.mock('../sports/f1_dashboard/f1_schema', () => ({
  paths: {
    f1Prefs: uid => `owners/${uid}/f1_prefs/current`,
    driver: (s, d) => `f1_data/${s}/drivers/${d}`,
    gp: (s, g) => `f1_data/${s}/schedule/${g}`,
    result: (s, g) => `f1_data/${s}/results/${g}`,
  },
  validateF1Prefs: () => ({ valid: true }),
}));

jest.mock('../sports/f1_dashboard/live_cache', () => ({
  getLiveCache: () => ({
    getPosition: jest.fn().mockResolvedValue(null),
    getAllPositions: jest.fn().mockResolvedValue([]),
  }),
}));

jest.mock('../sports/f1_dashboard/circuit_maps', () => ({
  generateCircuitSVG: jest.fn().mockReturnValue('<svg/>'),
  getCircuitIds: jest.fn().mockReturnValue([]),
  getCircuit: jest.fn().mockReturnValue({ name: 'x', country: 'y', laps: 10 }),
}));

jest.mock('../sports/f1_dashboard/circuit_overlay', () => ({
  renderAllDriversOnCircuit: jest.fn().mockReturnValue('<svg/>'),
}));

jest.mock('../sports/f1_dashboard/f1_fantasy', () => ({
  calculateFantasyPoints: jest.fn().mockReturnValue({ points: 0, breakdown: {} }),
  getFantasyLeaderboard: jest.fn().mockResolvedValue([]),
  updateOwnerFantasyScore: jest.fn().mockResolvedValue({}),
  F1_POINTS: {},
}));

jest.mock('../sports/f1_dashboard/f1_paywall', () => ({
  hasF1Addon: jest.fn().mockResolvedValue(false),
  requireF1Addon: jest.fn().mockReturnValue((req, res, next) => next()),
  getF1Status: jest.fn().mockResolvedValue({ active: true, plan: 'standalone', expiresAt: null, source: 'standalone' }),
  F1_ADDON_ID: 'f1_dashboard',
  F1_ADDON_PRICE_USD: 3,
}));

jest.mock('../sports/f1_dashboard/f1_telemetry', () => ({
  getCurrentSession: jest.fn().mockResolvedValue(null),
  isSessionLive: jest.fn().mockReturnValue(false),
  getDriverIntervals: jest.fn().mockResolvedValue(null),
  getDriverLapData: jest.fn().mockResolvedValue([]),
  getCurrentStint: jest.fn().mockResolvedValue(null),
  getDriverPits: jest.fn().mockResolvedValue([]),
  getDriverLocation: jest.fn().mockResolvedValue(null),
  getDriverTelemetry: jest.fn().mockResolvedValue(null),
  getAllDriversLocation: jest.fn().mockResolvedValue([]),
  getFastestLap: jest.fn().mockReturnValue(null),
  buildDriverSnapshot: jest.fn().mockReturnValue({}),
}));

const express = require('express');
const request = require('supertest');
const createF1Routes = require('../routes/f1');
const paywall = require('../sports/f1_dashboard/f1_paywall');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/f1', createF1Routes({
    verifyToken: (req, res, next) => { req.user = { uid: 'test_uid' }; next(); },
  }));
  return app;
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  paywall.getF1Status.mockResolvedValue({
    active: true, plan: 'standalone', expiresAt: null, source: 'standalone',
  });
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/f1/status — routes/f1.js lineas 338-342', () => {
  test('sin ?uid → 400 uid_required (req.query.uid falsy branch)', async () => {
    const r = await request(makeApp()).get('/api/f1/status');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('uid_required');
  });

  test('con ?uid=owner123 → 200 con status del addon (happy path)', async () => {
    const r = await request(makeApp()).get('/api/f1/status?uid=owner123');
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(true);
    expect(paywall.getF1Status).toHaveBeenCalledWith('owner123');
  });
});
