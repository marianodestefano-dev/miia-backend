"use strict";

// Cubre el outer catch de f1_cron.js lineas 95-96
// db.doc().set() rechaza en el primer await → el try externo cae en catch

let cron;

beforeAll(() => {
  jest.resetModules();

  jest.doMock('firebase-admin', () => {
    const fsFn = () => ({
      doc: () => ({
        set: () => Promise.reject(new Error('DB-FATAL-ERROR')),
        get: () => Promise.resolve({ exists: false, data: () => null }),
      }),
      collection: () => ({
        doc: () => ({ set: () => Promise.resolve() }),
        where: function() { return this; },
        limit: function() { return this; },
        get: () => Promise.resolve({ docs: [], empty: true }),
        add: () => Promise.resolve({ id: 'x' }),
      }),
      batch: () => ({ set: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) }),
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
    getDriverStandings: jest.fn().mockResolvedValue([]),
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
});
afterEach(() => jest.restoreAllMocks());

describe('f1_cron — outer catch (lineas 95-96)', () => {
  test('db.doc().set() rechaza → catch externo → ok=false con mensaje de error', async () => {
    const r = await cron.runPostGPCron('gp1', jest.fn());
    expect(r.ok).toBe(false);
    expect(r.gpId).toBe('gp1');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('DB-FATAL-ERROR');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[F1-CRON] Error fatal')
    );
  });
});
