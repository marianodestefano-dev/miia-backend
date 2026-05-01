'use strict';

const {
  validateDriver,
  validateGP,
  validateResult,
  validateF1Prefs,
  paths,
} = require('../sports/f1_dashboard/f1_schema');

describe('F1.1 — Schema Firestore MiiaF1', () => {

  // ═══ DRIVERS ═══
  describe('validateDriver', () => {
    const validDriver = {
      id: 'norris', name: 'Lando Norris', team: 'McLaren',
      number: 4, nationality: 'GBR', season: '2025',
    };

    test('acepta driver valido', () => {
      expect(validateDriver(validDriver).valid).toBe(true);
    });

    test('rechaza driver sin name', () => {
      const r = validateDriver({ ...validDriver, name: '' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/name/);
    });

    test('rechaza driver sin team', () => {
      const r = validateDriver({ ...validDriver, team: undefined });
      expect(r.valid).toBe(false);
    });

    test('rechaza number fuera de rango', () => {
      expect(validateDriver({ ...validDriver, number: 100 }).valid).toBe(false);
      expect(validateDriver({ ...validDriver, number: -1 }).valid).toBe(false);
    });

    test('acepta number 0 (valido en F1)', () => {
      expect(validateDriver({ ...validDriver, number: 0 }).valid).toBe(true);
    });

    test('rechaza driver sin season', () => {
      const r = validateDriver({ ...validDriver, season: undefined });
      expect(r.valid).toBe(false);
    });
  });

  // ═══ SCHEDULE ═══
  describe('validateGP', () => {
    const validGP = {
      id: 'monaco', name: 'Gran Premio de Monaco', circuit: 'Circuit de Monaco',
      date: '2025-05-25', country: 'MCO', season: '2025', status: 'completed',
    };

    test('acepta GP valido', () => {
      expect(validateGP(validGP).valid).toBe(true);
    });

    test('acepta GP sin status (opcional)', () => {
      const { status, ...noStatus } = validGP;
      expect(validateGP(noStatus).valid).toBe(true);
    });

    test('rechaza status invalido', () => {
      const r = validateGP({ ...validGP, status: 'pending' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/status invalido/);
    });

    test('rechaza date sin formato ISO', () => {
      const r = validateGP({ ...validGP, date: '25/05/2025' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/ISO 8601/);
    });

    test('rechaza GP sin circuit', () => {
      const r = validateGP({ ...validGP, circuit: '' });
      expect(r.valid).toBe(false);
    });
  });

  // ═══ RESULTS ═══
  describe('validateResult', () => {
    const validResult = {
      gp_id: 'monaco', season: '2025',
      positions: [
        { position: 1, driver_id: 'norris', driver_name: 'Lando Norris', points: 25 },
        { position: 2, driver_id: 'piastri', driver_name: 'Oscar Piastri', points: 18 },
      ],
    };

    test('acepta resultado valido', () => {
      expect(validateResult(validResult).valid).toBe(true);
    });

    test('rechaza positions vacio', () => {
      const r = validateResult({ ...validResult, positions: [] });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/positions/);
    });

    test('rechaza posicion sin driver_id', () => {
      const bad = { ...validResult, positions: [{ position: 1, driver_name: 'Norris' }] };
      const r = validateResult(bad);
      expect(r.valid).toBe(false);
    });

    test('rechaza result sin gp_id', () => {
      const { gp_id, ...noGp } = validResult;
      expect(validateResult(noGp).valid).toBe(false);
    });
  });

  // ═══ F1 PREFS ═══
  describe('validateF1Prefs', () => {
    test('acepta prefs validas', () => {
      expect(validateF1Prefs({ uid: 'abc123', adopted_driver: 'hamilton' }).valid).toBe(true);
    });

    test('acepta prefs sin adopted_driver (opcional)', () => {
      expect(validateF1Prefs({ uid: 'abc123' }).valid).toBe(true);
    });

    test('rechaza prefs sin uid', () => {
      expect(validateF1Prefs({}).valid).toBe(false);
    });
  });

  // ═══ PATHS ═══
  describe('paths helpers', () => {
    test('path driver correcto', () => {
      expect(paths.driver('2025', 'norris')).toBe('f1_data/2025/drivers/norris');
    });

    test('path gp correcto', () => {
      expect(paths.gp('2025', 'monaco')).toBe('f1_data/2025/schedule/monaco');
    });

    test('path result correcto', () => {
      expect(paths.result('2025', 'monaco')).toBe('f1_data/2025/results/monaco');
    });

    test('path f1Prefs correcto', () => {
      expect(paths.f1Prefs('uid123')).toBe('owners/uid123/f1_prefs');
    });

    test('path fantasyEntry correcto', () => {
      expect(paths.fantasyEntry('2025', 'uid123')).toBe('f1_fantasy/2025/standings/uid123');
    });
  });
});
