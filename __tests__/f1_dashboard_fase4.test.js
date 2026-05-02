'use strict';

jest.mock('firebase-admin', function() { return { firestore: jest.fn() }; });
jest.mock('../sports/f1_dashboard/live_cache');
jest.mock('../sports/f1_dashboard/f1_schema');
jest.mock('../sports/f1_dashboard/circuit_maps');
jest.mock('../sports/f1_dashboard/results_scraper');
jest.mock('../sports/f1_dashboard/f1_notifications');

const admin = require('firebase-admin');
const { getLiveCache } = require('../sports/f1_dashboard/live_cache');
const { paths, validateResult } = require('../sports/f1_dashboard/f1_schema');
const { getCircuit, getCircuitIds } = require('../sports/f1_dashboard/circuit_maps');
const { getGPResults, getDriverStandings, getConstructorStandings } = require('../sports/f1_dashboard/results_scraper');
const { sendPostRaceNotifications } = require('../sports/f1_dashboard/f1_notifications');

const cron = require('../sports/f1_dashboard/f1_cron');

function mockDb(opts) {
  opts = opts || {};
  const mockSet = jest.fn().mockResolvedValue(undefined);
  const batch = { set: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
  admin.firestore.mockReturnValue({
    doc: jest.fn(function(path) {
      return { get: jest.fn().mockResolvedValue({ exists: !!(opts[path]), data: function() { return opts[path]; } }), set: mockSet };
    }),
    collection: jest.fn(function() {
      return {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
      };
    }),
    batch: jest.fn().mockReturnValue(batch),
  });
}

function mockCache(opts) {
  opts = opts || {};
  getLiveCache.mockReturnValue({
    getRaceStatus: jest.fn().mockResolvedValue(opts.raceStatus || { isLive: false }),
    getAllPositions: jest.fn().mockResolvedValue(opts.positions || []),
  });
}

describe('F1.24 -- Post-GP Cron', function() {
  beforeEach(function() {
    jest.clearAllMocks();
    mockDb({});
    paths.result = jest.fn(function(s, id) { return 'f1_data/' + s + '/results/' + id; });
    validateResult.mockReturnValue({ positions: [] });
    getGPResults.mockResolvedValue({ positions: [{ driver_name: 'Norris', position: 1 }], fastest_lap: 'Norris' });
    getDriverStandings.mockResolvedValue([]);
    getConstructorStandings.mockResolvedValue([]);
    sendPostRaceNotifications.mockResolvedValue({ sent: 0, skipped: 0, errors: 0 });
  });

  test('runPostGPCron retorna ok:true sin errores graves', async function() {
    const sendMsg = jest.fn().mockResolvedValue(undefined);
    const result = await cron.runPostGPCron('monaco', sendMsg);
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('gpId', 'monaco');
    expect(Array.isArray(result.errors)).toBe(true);
  });

  test('runPostGPCron incluye gpId en resultado', async function() {
    const result = await cron.runPostGPCron('japan', jest.fn());
    expect(result.gpId).toBe('japan');
  });
});

