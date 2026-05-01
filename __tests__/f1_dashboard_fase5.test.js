'use strict';

jest.mock('firebase-admin', function() {
  return { firestore: jest.fn() };
});
jest.mock('../sports/f1_dashboard/f1_schema');

const admin = require('firebase-admin');
const { paths } = require('../sports/f1_dashboard/f1_schema');
const fantasy = require('../sports/f1_dashboard/f1_fantasy');
const paywall = require('../sports/f1_dashboard/f1_paywall');

admin.firestore.FieldValue = { increment: jest.fn(function(n) { return n; }), arrayUnion: jest.fn(function(v) { return [v]; }) };

function mockDb(docs, collections) {
  docs = docs || {};
  collections = collections || {};
  admin.firestore.mockReturnValue({
    doc: jest.fn(function(path) {
      const data = docs[path];
      return {
        get: jest.fn().mockResolvedValue({ exists: !!data, data: function() { return data; } }),
        set: jest.fn().mockResolvedValue(undefined),
      };
    }),
    collection: jest.fn(function(name) {
      const colData = collections[name] || { empty: true, docs: [] };
      return {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue(colData),
        add: jest.fn().mockResolvedValue({ id: 'new_doc' }),
      };
    }),
    collectionGroup: jest.fn(function() {
      return { get: jest.fn().mockResolvedValue({ docs: [] }) };
    }),
  });
}

describe('F1.27-F1.28 -- Fantasy League', function() {
  beforeEach(function() {
    jest.clearAllMocks();
    mockDb({});
    paths.driver = jest.fn(function(s, id) { return 'f1_data/' + s + '/drivers/' + id; });
  });

  describe('calculateFantasyPoints', function() {
    test('P1 = 25 puntos', function() {
      const r = fantasy.calculateFantasyPoints({ position: 1 }, 'Norris');
      expect(r.points).toBe(25);
      expect(r.breakdown.race).toBe(25);
    });

    test('P10 = 1 punto', function() {
      const r = fantasy.calculateFantasyPoints({ position: 10 }, 'Norris');
      expect(r.points).toBe(1);
    });

    test('DNF = 0 puntos', function() {
      const r = fantasy.calculateFantasyPoints({ position: 3, dnf: true }, 'Norris');
      expect(r.points).toBe(0);
    });

    test('vuelta rapida +2 puntos', function() {
      const r = fantasy.calculateFantasyPoints({ position: 2, fastest_lap: 'Norris' }, 'Norris');
      expect(r.points).toBe(18 + 2);
      expect(r.breakdown.fastest_lap).toBe(2);
    });

    test('pole +3 puntos', function() {
      const r = fantasy.calculateFantasyPoints({ position: 1, pole_position: 'Verstappen' }, 'Verstappen');
      expect(r.points).toBe(25 + 3);
    });

    test('bonus overtake: arranco P6 y termino P2', function() {
      const r = fantasy.calculateFantasyPoints({ position: 2, started_pos: 6 }, 'Hamilton');
      expect(r.points).toBe(18 + 5);
    });

    test('F1_POINTS tiene 10 posiciones', function() {
      expect(Object.keys(fantasy.F1_POINTS).length).toBe(10);
    });
  });

  describe('updateOwnerFantasyScore', function() {
    test('retorna 0 puntos si driver no existe', async function() {
      mockDb({});
      const result = await fantasy.updateOwnerFantasyScore('uid1', 'norris', 'monaco', { positions: [] });
      expect(result.points).toBe(0);
    });
  });

  describe('getFantasyLeaderboard', function() {
    test('retorna array vacio si no hay prefs', async function() {
      const leaderboard = await fantasy.getFantasyLeaderboard('2025');
      expect(Array.isArray(leaderboard)).toBe(true);
    });
  });
});

describe('F1.29-F1.30 -- Paywall', function() {
  beforeEach(function() {
    jest.clearAllMocks();
  });

  describe('hasF1Addon', function() {
    test('retorna false si owner no existe', async function() {
      mockDb({});
      const result = await paywall.hasF1Addon('uid1');
      expect(result).toBe(false);
    });

    test('retorna true si f1_active=true en owner doc', async function() {
      mockDb({ 'owners/uid1': { f1_active: true } });
      const result = await paywall.hasF1Addon('uid1');
      expect(result).toBe(true);
    });

    test('retorna false si ownerUid es null', async function() {
      expect(await paywall.hasF1Addon(null)).toBe(false);
    });
  });

  describe('activateF1Addon', function() {
    test('llama set en doc owners/ con f1_active=true', async function() {
      const mockSet = jest.fn().mockResolvedValue(undefined);
      admin.firestore.mockReturnValue({
        doc: jest.fn(function() { return { set: mockSet }; }),
        collection: jest.fn(function() { return { add: jest.fn().mockResolvedValue({}) }; }),
      });
      await paywall.activateF1Addon('uid1', 'pay_123', 'mercadopago');
      expect(mockSet).toHaveBeenCalled();
    });
  });

  describe('requireF1Addon middleware', function() {
    test('retorna 401 si no hay user en req', function() {
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();
      paywall.requireF1Addon({ user: null }, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});
