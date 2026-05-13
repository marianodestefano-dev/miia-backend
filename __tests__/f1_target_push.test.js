'use strict';

globalThis.__mockDocs5 = {};
globalThis.__mockSchedule5 = [];
globalThis.__mockPrefs5 = [];

jest.mock('firebase-admin', () => {
  const docFor = (path) => ({
    get: jest.fn().mockImplementation(() => Promise.resolve({
      exists: !!globalThis.__mockDocs5[path],
      data: () => globalThis.__mockDocs5[path],
      id: path.split('/').pop(),
    })),
    set: jest.fn().mockImplementation((data, opts) => {
      globalThis.__mockDocs5[path] = opts && opts.merge
        ? { ...(globalThis.__mockDocs5[path] || {}), ...data }
        : data;
      return Promise.resolve();
    }),
  });
  const collectionFor = (path) => {
    const filters = [];
    let limitN = null;
    const api = {
      doc: (id) => docFor(path + '/' + id),
      where: (field, op, value) => { filters.push({ field, op, value }); return api; },
      orderBy: () => api,
      limit: (n) => { limitN = n; return api; },
      add: jest.fn().mockResolvedValue({ id: 'new' }),
      get: jest.fn().mockImplementation(() => {
        let docs = [];
        if (path.indexOf('schedule') >= 0) {
          docs = globalThis.__mockSchedule5.filter((g) =>
            filters.every((f) => f.op === '==' ? g[f.field] === f.value : true)
          );
          if (limitN) docs = docs.slice(0, limitN);
        }
        return Promise.resolve({
          docs: docs.map((d) => ({ id: d.id || 'doc', data: () => d, exists: true })),
          empty: docs.length === 0,
        });
      }),
    };
    return api;
  };
  const fsFn = () => ({
    doc: (path) => docFor(path),
    collection: (path) => collectionFor(path),
    collectionGroup: () => ({
      get: jest.fn().mockResolvedValue({
        docs: globalThis.__mockPrefs5.map((d) => ({ id: 'doc', data: () => d, exists: true })),
      }),
    }),
    batch: () => ({
      set: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    }),
  });
  fsFn.FieldValue = {
    arrayUnion: () => ({}),
    arrayRemove: () => ({}),
    increment: () => ({}),
  };
  return { firestore: fsFn };
});

jest.mock('../sports/f1_dashboard/results_scraper', () => ({
  getGPResults: jest.fn(),
  getDriverStandings: jest.fn(),
  getConstructorStandings: jest.fn(),
}));
jest.mock('../sports/f1_dashboard/f1_notifications', () => ({
  sendPostRaceNotifications: jest.fn(),
}));

const reset = () => {
  globalThis.__mockDocs5 = {};
  globalThis.__mockSchedule5 = [];
  globalThis.__mockPrefs5 = [];
};

// require f1_fantasy ELIMINADO 2026-05-12 (firma Mariano). Ver feedback_NO_fantasy_F1.md.
const history = require('../sports/f1_dashboard/f1_history');
const cron = require('../sports/f1_dashboard/f1_cron');
const scraperMock = require('../sports/f1_dashboard/results_scraper');
const notifMock = require('../sports/f1_dashboard/f1_notifications');

beforeEach(() => { reset(); jest.clearAllMocks(); });

// describe Fantasy ELIMINADO 2026-05-12 (firma Mariano).
// Fantasy F1 NUNCA fue pedido. MIIAF1 = dashboard live puro.

describe('F1 R5 history edge cases', () => {
  test('formatPodium positions sin driver_name ni driverId usa dash', () => {
    const r = history.formatPodium({ positions: [{ team: 'X' }] });
    expect(r).toContain('-');
  });
  test('formatPodium positions sin team usa dash', () => {
    const r = history.formatPodium({ positions: [{ driver_name: 'X' }] });
    expect(r).toContain('-');
  });
  test('formatPodium con driver_name y sin team', () => {
    const r = history.formatPodium({ positions: [{ driver_name: 'X', team: null }] });
    expect(r).toContain('X');
    expect(r).toContain('-');
  });
  test('getDriverSeasonHistory result sin positions array', async () => {
    globalThis.__mockSchedule5.push({ id: 'gp1', round: 1, name: 'Monaco', status: 'completed' });
    globalThis.__mockDocs5['f1_data/2025/results/gp1'] = { /* no positions */ };
    const r = await history.getDriverSeasonHistory('norris', '2025');
    expect(r).toEqual([]);
  });
});

describe('F1 R5 cron fatal error path', () => {
  test('cron sendWaMessage no funcion no rompe', async () => {
    scraperMock.getGPResults.mockResolvedValue(null);
    scraperMock.getDriverStandings.mockResolvedValue([]);
    scraperMock.getConstructorStandings.mockResolvedValue([]);
    notifMock.sendPostRaceNotifications.mockResolvedValue({ sent: 0, errors: 0 });
    const r = await cron.runPostGPCron('gp-x', null);
    expect(r.gpId).toBe('gp-x');
  });
});
