"use strict";

// Cubre f1_cron.js linea 57: d.driver_id || 'driver_' + i
// Caso: driverStandings tiene entrada SIN driver_id → fallback 'driver_0'

let cron;

beforeAll(() => {
  jest.resetModules();

  jest.doMock('firebase-admin', () => {
    const batchData = {};
    const batchMock = {
      set: (ref, data) => { batchData[ref] = data; },
      commit: jest.fn().mockResolvedValue(undefined),
    };
    const fsFn = () => ({
      doc: (path) => ({
        set: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockResolvedValue({ exists: false, data: () => null }),
      }),
      collection: (path) => ({
        doc: (id) => ({ set: jest.fn().mockResolvedValue(undefined) }),
        where: function() { return this; },
        limit: function() { return this; },
        get: jest.fn().mockResolvedValue({ docs: [], empty: true }),
        add: jest.fn().mockResolvedValue({ id: 'x' }),
      }),
      batch: () => batchMock,
    });
    fsFn.FieldValue = {
      arrayUnion: () => ({}),
      arrayRemove: () => ({}),
      increment: () => ({}),
    };
    return { firestore: fsFn };
  });

  jest.doMock('../sports/f1_dashboard/results_scraper', () => ({
    getGPResults: jest.fn().mockResolvedValue(null),
    // driver sin driver_id → dispara d.driver_id || 'driver_' + i  en linea 57
    getDriverStandings: jest.fn().mockResolvedValue([{ points: 50 }, { driver_id: 'ver', points: 30 }]),
    getConstructorStandings: jest.fn().mockResolvedValue([]),
  }));

  jest.doMock('../sports/f1_dashboard/f1_notifications', () => ({
    sendPostRaceNotifications: jest.fn().mockResolvedValue({ sent: 0, errors: 0 }),
  }));

  jest.doMock('../sports/f1_dashboard/f1_schema', () => ({
    paths: {
      result: (s, g) => `f1_data/${s}/results/${g}`,
      driver: (s, d) => `f1_data/${s}/drivers/${d}`,
      gp:     (s, g) => `f1_data/${s}/schedule/${g}`,
    },
    validateResult: r => r,
  }));

  cron = require('../sports/f1_dashboard/f1_cron');
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('f1_cron linea 57 — driver_id fallback', () => {
  test('driverStandings sin driver_id → usa driver_N como clave (|| branch)', async () => {
    // Primera entrada tiene { points: 50 } sin driver_id
    // → d.driver_id es undefined → || 'driver_' + 0 = 'driver_0' (rama derecha cubierta)
    const r = await cron.runPostGPCron('gp1', jest.fn());
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
});
