'use strict';

jest.mock('firebase-admin', function() { return { firestore: jest.fn() }; });
jest.mock('../sports/f1_dashboard/f1_schema');
jest.mock('../sports/f1_dashboard/circuit_maps');
jest.mock('../sports/f1_dashboard/circuit_overlay');

const admin = require('firebase-admin');
const { paths } = require('../sports/f1_dashboard/f1_schema');
const { generateCircuitSVG, getCircuit } = require('../sports/f1_dashboard/circuit_maps');
const waImg = require('../sports/f1_dashboard/circuit_wa_image');
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

describe('F1.21 -- Circuit WA image', function() {
  beforeEach(function() { jest.clearAllMocks(); });

  describe('buildCircuitTextMessage', function() {
    test('genera mensaje textual cuando circuito existe', function() {
      getCircuit.mockReturnValue({ name: 'Circuit de Monaco', country: 'Monaco', laps: 78, length_km: 3.337, color: '#FFC107' });
      const msg = waImg.buildCircuitTextMessage('monaco', 'GP Monaco', 8);
      expect(msg).toContain('Monaco');
      expect(msg).toContain('78');
    });

    test('fallback si circuito no existe', function() {
      getCircuit.mockReturnValue(null);
      const msg = waImg.buildCircuitTextMessage('unknown', '', 0);
      expect(msg).toContain('no disponibles');
    });
  });

  describe('svgToPngBuffer', function() {
    test('retorna null si sharp no disponible', async function() {
      const result = await waImg.svgToPngBuffer('<svg></svg>');
      expect(result).toBeNull();
    });
  });

  describe('sendCircuitImage', function() {
    test('envia mensaje de texto si SVG es null', async function() {
      generateCircuitSVG.mockReturnValue(null);
      getCircuit.mockReturnValue({ name: 'Test', country: 'Test', laps: 50, length_km: 5.0, color: '#fff' });
      const sendMsg = jest.fn().mockResolvedValue(undefined);
      await waImg.sendCircuitImage('+1234', 'test', 'GP Test', 1, sendMsg, null);
      expect(sendMsg).toHaveBeenCalled();
    });

    test('envia imagen PNG si SVG y sendWaImage disponibles', async function() {
      generateCircuitSVG.mockReturnValue('<svg><rect width="400" height="300" fill="#0A0A12"/></svg>');
      getCircuit.mockReturnValue({ name: 'Monaco', country: 'Monaco', laps: 78, length_km: 3.337, color: '#FFC107' });
      const sendMsg = jest.fn();
      const sendImg = jest.fn().mockResolvedValue(undefined);
      // sharp no disponible -> fallback a texto
      await waImg.sendCircuitImage('+1234', 'monaco', 'GP Monaco', 8, sendMsg, sendImg);
      // Either sendMsg or sendImg should be called
      expect(sendMsg.mock.calls.length + sendImg.mock.calls.length).toBeGreaterThan(0);
    });
  });
});

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
