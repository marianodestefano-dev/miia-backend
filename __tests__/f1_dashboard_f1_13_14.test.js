'use strict';

jest.mock('firebase-admin', function() {
  return { firestore: jest.fn() };
});
jest.mock('../sports/f1_dashboard/live_cache');
jest.mock('../sports/f1_dashboard/f1_schema');

const admin = require('firebase-admin');
const { getLiveCache } = require('../sports/f1_dashboard/live_cache');
const { paths } = require('../sports/f1_dashboard/f1_schema');
const notifier = require('../sports/f1_dashboard/f1_live_notifier');
const detector = require('../sports/f1_dashboard/f1_query_detector');

function mockFirestore(docs) {
  docs = docs || {};
  const mockDb = {
    doc: jest.fn(function(path) {
      return { get: jest.fn().mockResolvedValue({ exists: !!(docs[path]), data: function() { return docs[path]; } }) };
    }),
    collection: jest.fn(function() {
      return {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
      };
    }),
    collectionGroup: jest.fn(function() {
      return {
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({
          empty: false,
          docs: [{ data: function() { return { uid: 'uid1', adopted_driver: 'norris', notifications: true }; } }]
        }),
      };
    }),
  };
  admin.firestore.mockReturnValue(mockDb);
}

function mockCache(opts) {
  opts = opts || {};
  getLiveCache.mockReturnValue({
    getRaceStatus: jest.fn().mockResolvedValue(opts.raceStatus || { isLive: false }),
    getAllPositions: jest.fn().mockResolvedValue(opts.positions || []),
    getDriverPosition: jest.fn().mockResolvedValue(null),
  });
}

describe('F1.13 -- Live race notifier', function() {
  beforeEach(function() {
    notifier._lastNotifiedLap.clear();
    jest.clearAllMocks();
    paths.driver = jest.fn(function(s, id) { return 'f1_data/' + s + '/drivers/' + id; });
  });

  describe('buildLiveMessage', function() {
    test('mensaje cuando piloto lidera', function() {
      const msg = notifier.buildLiveMessage('Lando Norris', 'McLaren', 1, 3, 'GP Monaco', 45, 78);
      expect(msg).toContain('EN VIVO');
      expect(msg).toContain('LIDERA');
    });

    test('mensaje cuando piloto sube', function() {
      const msg = notifier.buildLiveMessage('Max Verstappen', 'Red Bull', 2, 4, 'GP Monaco', 30, 78);
      expect(msg).toContain('P2');
    });

    test('mensaje cuando piloto baja', function() {
      const msg = notifier.buildLiveMessage('Lewis Hamilton', 'Ferrari', 5, 3, 'GP Monaco', 60, 78);
      expect(msg).toContain('P5');
    });
  });

  describe('checkDriverPositionChange', function() {
    test('retorna null si no hay adopted_driver', async function() {
      const result = await notifier.checkDriverPositionChange('uid1', null, [], {}, 10, 78, 'GP Test');
      expect(result).toBeNull();
    });

    test('retorna null si driver no existe en Firestore', async function() {
      mockFirestore({});
      const result = await notifier.checkDriverPositionChange('uid1', 'norris', [{ position: 1, driver_number: 4 }], {}, 10, 78, 'GP Test');
      expect(result).toBeNull();
    });

    test('retorna null si no hay cambio de posicion', async function() {
      mockFirestore({ 'f1_data/2025/drivers/norris': { name: 'Lando Norris', team: 'McLaren', number: 4 } });
      const result = await notifier.checkDriverPositionChange('uid1', 'norris', [{ driver_number: 4, position: 3 }], { 4: 3 }, 10, 78, 'GP Test');
      expect(result).toBeNull();
    });

    test('retorna null si rate limit activo', async function() {
      mockFirestore({ 'f1_data/2025/drivers/norris': { name: 'Lando Norris', team: 'McLaren', number: 4 } });
      notifier._lastNotifiedLap.set('uid1', 10);
      const result = await notifier.checkDriverPositionChange('uid1', 'norris', [{ driver_number: 4, position: 2 }], { 4: 5 }, 12, 78, 'GP Test');
      expect(result).toBeNull();
    });

    test('retorna mensaje si hay cambio y rate limit libre', async function() {
      mockFirestore({ 'f1_data/2025/drivers/norris': { name: 'Lando Norris', team: 'McLaren', number: 4 } });
      const result = await notifier.checkDriverPositionChange('uid1', 'norris', [{ driver_number: 4, position: 2 }], { 4: 5 }, 20, 78, 'GP Monaco');
      expect(result).not.toBeNull();
      expect(result).toContain('EN VIVO');
    });
  });
});

describe('F1.14 -- F1 query detector', function() {
  beforeEach(function() {
    jest.clearAllMocks();
    mockCache({ raceStatus: { isLive: false } });
    mockFirestore({});
  });

  describe('isF1Query', function() {
    test('detecta "como va Verstappen"', function() { expect(detector.isF1Query('como va Verstappen')).toBe(true); });
    test('detecta "resultado del GP"', function() { expect(detector.isF1Query('resultado del GP de Monaco')).toBe(true); });
    test('detecta "formula 1 hoy"', function() { expect(detector.isF1Query('formula 1 hoy')).toBe(true); });
    test('ignora "quiero pizza"', function() { expect(detector.isF1Query('quiero pizza')).toBe(false); });
    test('ignora "cual es el clima"', function() { expect(detector.isF1Query('cual es el clima')).toBe(false); });
  });

  describe('detectMentionedDriver', function() {
    test('detecta verstappen', function() { expect(detector.detectMentionedDriver('va Verstappen')).toBe('verstappen'); });
    test('detecta norris', function() { expect(detector.detectMentionedDriver('norris va primero')).toBe('norris'); });
    test('null si no hay piloto', function() { expect(detector.detectMentionedDriver('resultado del GP')).toBeNull(); });
  });

  describe('enrichF1Prompt', function() {
    test('retorna null para mensaje no-F1', async function() {
      expect(await detector.enrichF1Prompt('quiero pizza')).toBeNull();
    });

    test('incluye sin carrera cuando no hay live', async function() {
      const result = await detector.enrichF1Prompt('como va el GP de Monaco?');
      expect(result).toContain('No hay carrera en vivo');
    });

    test('incluye posiciones en vivo cuando hay carrera', async function() {
      mockCache({
        raceStatus: { isLive: true, raceName: 'GP Monaco', currentLap: 45, totalLaps: 78 },
        positions: [{ position: 1, driverName: 'Norris', team: 'McLaren', gap: null }],
      });
      const result = await detector.enrichF1Prompt('como va la formula 1?');
      expect(result).toContain('CARRERA EN CURSO');
    });

    test('incluye encabezado DATOS F1', async function() {
      const result = await detector.enrichF1Prompt('formula 1 hoy');
      expect(result).toContain('DATOS F1 EN TIEMPO REAL');
    });
  });
});
