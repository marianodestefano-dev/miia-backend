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

const waCmd = require('../sports/f1_dashboard/f1_wa_commands');
const cron = require('../sports/f1_dashboard/f1_cron');
const gemini = require('../sports/f1_dashboard/f1_gemini');

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

describe('F1.23 -- WA Commands', function() {
  beforeEach(function() {
    jest.clearAllMocks();
    mockDb({});
    mockCache({});
    paths.result = jest.fn(function(s, id) { return 'f1_data/' + s + '/results/' + id; });
    paths.driver = jest.fn(function(s, id) { return 'f1_data/' + s + '/drivers/' + id; });
  });

  describe('isF1Command', function() {
    test.each([
      ['/f1', true],
      ['/f1 posiciones', true],
      ['/f1 piloto Norris', true],
      ['/f1 help', true],
      ['f1 posiciones', false],
      ['hola como estas', false],
      ['/gp resultado', false],
    ])('"%s" -> %s', function(msg, expected) {
      expect(waCmd.isF1Command(msg)).toBe(expected);
    });
  });

  describe('processF1Command', function() {
    test('retorna null para no-comando', async function() {
      expect(await waCmd.processF1Command('hola', 'uid1')).toBeNull();
    });

    test('/f1 help retorna lista de comandos', async function() {
      const resp = await waCmd.processF1Command('/f1 help', 'uid1');
      expect(resp).toContain('posiciones');
      expect(resp).toContain('resultado');
    });

    test('/f1 posiciones retorna sin carrera live', async function() {
      const resp = await waCmd.processF1Command('/f1 posiciones', 'uid1');
      expect(resp).toContain('No hay carrera en vivo');
    });

    test('/f1 circuito retorna datos si circuito existe', async function() {
      getCircuit.mockReturnValue({ name: 'Circuit de Monaco', country: 'Monaco', laps: 78, length_km: 3.337 });
      const resp = await waCmd.processF1Command('/f1 circuito monaco', 'uid1');
      expect(resp).toContain('Monaco');
      expect(resp).toContain('78');
    });

    test('/f1 siguiente sin GPs retorna mensaje', async function() {
      const resp = await waCmd.processF1Command('/f1 siguiente', 'uid1');
      expect(typeof resp).toBe('string');
      expect(resp.length).toBeGreaterThan(0);
    });
  });
});

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

describe('F1.25 -- Gemini predictions', function() {
  beforeEach(function() {
    jest.clearAllMocks();
    mockDb({});
    paths.result = jest.fn(function(s, id) { return 'f1_data/' + s + '/results/' + id; });
  });

  describe('buildPredictionPrompt', function() {
    test('incluye datos del proximo GP', function() {
      const prompt = gemini.buildPredictionPrompt(
        { name: 'GP Monaco', circuit: 'Monaco', round: 8 },
        [{ position: 1, driver_name: 'Norris', points: 189 }],
        []
      );
      expect(prompt).toContain('GP Monaco');
      expect(prompt).toContain('Norris');
    });

    test('incluye instruccion de espanol', function() {
      const prompt = gemini.buildPredictionPrompt({}, [], []);
      expect(prompt).toContain('espanol');
    });
  });

  describe('generateNextGPPrediction', function() {
    test('retorna null si no hay GP programado', async function() {
      const result = await gemini.generateNextGPPrediction(jest.fn());
      expect(result).toBeNull();
    });
  });
});
