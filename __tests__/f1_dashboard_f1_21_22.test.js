'use strict';

jest.mock('firebase-admin', function() { return { firestore: jest.fn() }; });
jest.mock('../sports/f1_dashboard/f1_schema');
jest.mock('../sports/f1_dashboard/circuit_maps');
jest.mock('../sports/f1_dashboard/circuit_overlay');

const admin = require('firebase-admin');
const { paths } = require('../sports/f1_dashboard/f1_schema');
const { generateCircuitSVG, getCircuit } = require('../sports/f1_dashboard/circuit_maps');
const history = require('../sports/f1_dashboard/f1_history');

function mockFirestore(schedule, results) {
  schedule = schedule || [];
  results = results || {};
  admin.firestore.mockReturnValue({
    collection: jest.fn(function(path) {
      return {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({
          empty: schedule.length === 0,
          docs: schedule.map(function(s) { return { id: s.id, data: function() { return s; } }; }),
        }),
      };
    }),
    doc: jest.fn(function(path) {
      const key = path.split('/').pop();
      const data = results[key];
      return { get: jest.fn().mockResolvedValue({ exists: !!data, data: function() { return data; } }) };
    }),
  });
}

describe('F1.22 -- Historical GP view', function() {
  beforeEach(function() {
    jest.clearAllMocks();
    paths.result = jest.fn(function(s, id) { return 'f1_data/' + s + '/results/' + id; });
  });

  describe('formatPodium', function() {
    test('formatea podio correctamente', function() {
      const result = {
        positions: [
          { driver_name: 'Norris', team: 'McLaren' },
          { driver_name: 'Verstappen', team: 'Red Bull' },
          { driver_name: 'Leclerc', team: 'Ferrari' },
        ],
      };
      const podium = history.formatPodium(result);
      expect(podium).toContain('Norris');
      expect(podium).toContain('Verstappen');
      expect(podium).toContain('Leclerc');
    });

    test('retorna "Sin datos" si no hay resultado', function() {
      expect(history.formatPodium(null)).toBe('Sin datos');
      expect(history.formatPodium({ positions: [] })).toBe('Sin datos');
    });
  });

  describe('getRecentCompletedGPs', function() {
    test('retorna array vacio si no hay GPs completados', async function() {
      mockFirestore([], {});
      const result = await history.getRecentCompletedGPs('2025', 5);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    test('incluye resultado null si no hay datos del GP', async function() {
      mockFirestore([{ id: 'monaco', round: 8, name: 'GP Monaco', status: 'completed' }], {});
      const result = await history.getRecentCompletedGPs('2025', 5);
      expect(result.length).toBe(1);
      expect(result[0].result).toBeNull();
    });
  });

  describe('getDriverSeasonHistory', function() {
    test('retorna historial vacio si no hay GPs completados', async function() {
      mockFirestore([], {});
      const result = await history.getDriverSeasonHistory('norris', '2025');
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });
  });
});
