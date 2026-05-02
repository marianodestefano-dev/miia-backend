'use strict';

globalThis.__mockDocs2 = {};
globalThis.__mockSchedule2 = [];

jest.mock('firebase-admin', () => {
  const docFor = (path) => ({
    get: jest.fn().mockImplementation(() => Promise.resolve({
      exists: !!globalThis.__mockDocs2[path],
      data: () => globalThis.__mockDocs2[path],
      id: path.split('/').pop(),
    })),
    set: jest.fn().mockImplementation((data, opts) => {
      globalThis.__mockDocs2[path] = opts && opts.merge
        ? { ...(globalThis.__mockDocs2[path] || {}), ...data }
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
          docs = globalThis.__mockSchedule2.filter((g) =>
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
    batch: () => ({
      set: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    }),
  });
  fsFn.FieldValue = {
    arrayUnion: () => ({}),
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
  globalThis.__mockDocs2 = {};
  globalThis.__mockSchedule2 = [];
};
const setSchedule = (gp) => { globalThis.__mockSchedule2.push(gp); };
const setResult = (season, id, r) => { globalThis.__mockDocs2['f1_data/' + season + '/results/' + id] = r; };

const history = require('../sports/f1_dashboard/f1_history');
const overlay = require('../sports/f1_dashboard/circuit_overlay');
const cron = require('../sports/f1_dashboard/f1_cron');
const scraperMock = require('../sports/f1_dashboard/results_scraper');
const notifMock = require('../sports/f1_dashboard/f1_notifications');

beforeEach(() => {
  reset();
  jest.clearAllMocks();
});

describe('F1 R4 — f1_history async', () => {
  test('getRecentCompletedGPs vacio', async () => {
    const r = await history.getRecentCompletedGPs('2025', 5);
    expect(r).toEqual([]);
  });
  test('getRecentCompletedGPs default season + limit', async () => {
    const r = await history.getRecentCompletedGPs();
    expect(Array.isArray(r)).toBe(true);
  });
  test('getRecentCompletedGPs con GPs + results', async () => {
    setSchedule({ id: 'gp1', name: 'Monaco', round: 5, status: 'completed' });
    setResult('2025', 'gp1', { positions: [{ driver_name: 'Norris', team: 'McLaren' }] });
    const r = await history.getRecentCompletedGPs('2025', 5);
    expect(r.length).toBe(1);
    expect(r[0].result).toBeDefined();
  });
  test('getRecentCompletedGPs result no exists null', async () => {
    setSchedule({ id: 'gp2', name: 'Spa', round: 6, status: 'completed' });
    const r = await history.getRecentCompletedGPs('2025', 5);
    expect(r[0].result).toBeNull();
  });
  test('getDriverSeasonHistory vacio', async () => {
    const r = await history.getDriverSeasonHistory('norris');
    expect(r).toEqual([]);
  });
  test('getDriverSeasonHistory default season', async () => {
    const r = await history.getDriverSeasonHistory('verstappen');
    expect(Array.isArray(r)).toBe(true);
  });
  test('getDriverSeasonHistory con resultados', async () => {
    setSchedule({ id: 'gp1', name: 'Monaco', round: 5, status: 'completed' });
    setResult('2025', 'gp1', {
      positions: [{ driver_id: 'norris', position: 3, points: 15 }],
    });
    const r = await history.getDriverSeasonHistory('norris', '2025');
    expect(r.length).toBe(1);
    expect(r[0].position).toBe(3);
    expect(r[0].points).toBe(15);
  });
  test('getDriverSeasonHistory driver no encontrado en GP skip', async () => {
    setSchedule({ id: 'gp1', name: 'Monaco', round: 5, status: 'completed' });
    setResult('2025', 'gp1', {
      positions: [{ driver_id: 'verstappen', position: 1, points: 25 }],
    });
    const r = await history.getDriverSeasonHistory('norris', '2025');
    expect(r.length).toBe(0);
  });
  test('getDriverSeasonHistory result no exists skip', async () => {
    setSchedule({ id: 'gp1', name: 'Monaco', round: 5, status: 'completed' });
    const r = await history.getDriverSeasonHistory('norris', '2025');
    expect(r.length).toBe(0);
  });
  test('getDriverSeasonHistory driverId fallback', async () => {
    setSchedule({ id: 'gp1', name: 'Monaco', round: 5, status: 'completed' });
    setResult('2025', 'gp1', {
      positions: [{ driverId: 'norris', position: 2, points: 18 }],
    });
    const r = await history.getDriverSeasonHistory('norris', '2025');
    expect(r.length).toBe(1);
    expect(r[0].position).toBe(2);
  });
  test('getDriverSeasonHistory points default 0', async () => {
    setSchedule({ id: 'gp1', name: 'Monaco', round: 5, status: 'completed' });
    setResult('2025', 'gp1', {
      positions: [{ driver_id: 'norris', position: 12 }],
    });
    const r = await history.getDriverSeasonHistory('norris', '2025');
    expect(r[0].points).toBe(0);
  });
});

describe('F1 R4 — circuit_overlay con highlight', () => {
  test('renderAllDriversOnCircuit con highlight crea text', () => {
    const r = overlay.renderAllDriversOnCircuit('monaco', [
      { driver_id: 'p1', name: 'Norris', team_color: '#FF8000', x: 0.3, y: 0.5 },
    ], 'p1');
    expect(r).toContain('Norris');
    expect(r).toContain('font-size="11"');
  });
  test('renderAllDriversOnCircuit sin highlight no crea text', () => {
    const r = overlay.renderAllDriversOnCircuit('monaco', [
      { driver_id: 'p1', name: 'X', team_color: '#fff', x: 0.5, y: 0.5 },
    ], 'p2');
    expect(r).not.toContain('font-size="11"');
  });
  test('renderAllDriversOnCircuit driver sin x/y usa defaults', () => {
    const r = overlay.renderAllDriversOnCircuit('monaco', [
      { driver_id: 'p1', name: 'X' },
    ], null);
    expect(r).toContain('<circle');
  });
  test('renderAllDriversOnCircuit drivers null usa []', () => {
    const r = overlay.renderAllDriversOnCircuit('monaco', null, null);
    expect(r).toContain('<svg');
  });
});

describe('F1 R4 — f1_cron.runPostGPCron', () => {
  test('cron sin scraper data → ok=true sin errors', async () => {
    scraperMock.getGPResults.mockResolvedValue(null);
    scraperMock.getDriverStandings.mockResolvedValue([]);
    scraperMock.getConstructorStandings.mockResolvedValue([]);
    notifMock.sendPostRaceNotifications.mockResolvedValue({ sent: 0, errors: 0 });
    const sendWa = jest.fn();
    const r = await cron.runPostGPCron('gp1', sendWa);
    expect(r.gpId).toBe('gp1');
    expect(r.ok).toBe(true);
  });
  test('cron con resultados scrapeados', async () => {
    scraperMock.getGPResults.mockResolvedValue({
      positions: [{ driver_id: 'norris', position: 1 }],
    });
    scraperMock.getDriverStandings.mockResolvedValue([{ driver_id: 'norris', points: 100 }]);
    scraperMock.getConstructorStandings.mockResolvedValue([{ team: 'McLaren', points: 200 }]);
    notifMock.sendPostRaceNotifications.mockResolvedValue({ sent: 5, errors: 0 });
    const r = await cron.runPostGPCron('gp1', jest.fn());
    expect(r.ok).toBe(true);
  });
  test('cron error en getGPResults', async () => {
    scraperMock.getGPResults.mockRejectedValue(new Error('scrape fail'));
    scraperMock.getDriverStandings.mockResolvedValue([]);
    scraperMock.getConstructorStandings.mockResolvedValue([]);
    notifMock.sendPostRaceNotifications.mockResolvedValue({ sent: 0, errors: 0 });
    const r = await cron.runPostGPCron('gp1', jest.fn());
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toContain('Resultados');
  });
  test('cron error en driver standings', async () => {
    scraperMock.getGPResults.mockResolvedValue(null);
    scraperMock.getDriverStandings.mockRejectedValue(new Error('drv fail'));
    scraperMock.getConstructorStandings.mockResolvedValue([]);
    notifMock.sendPostRaceNotifications.mockResolvedValue({ sent: 0, errors: 0 });
    const r = await cron.runPostGPCron('gp1', jest.fn());
    expect(r.errors.some(e => e.includes('Standings pilotos'))).toBe(true);
  });
  test('cron error en constructor standings', async () => {
    scraperMock.getGPResults.mockResolvedValue(null);
    scraperMock.getDriverStandings.mockResolvedValue([]);
    scraperMock.getConstructorStandings.mockRejectedValue(new Error('constr fail'));
    notifMock.sendPostRaceNotifications.mockResolvedValue({ sent: 0, errors: 0 });
    const r = await cron.runPostGPCron('gp1', jest.fn());
    expect(r.errors.some(e => e.includes('Standings constructores'))).toBe(true);
  });
  test('cron error en notifications', async () => {
    scraperMock.getGPResults.mockResolvedValue(null);
    scraperMock.getDriverStandings.mockResolvedValue([]);
    scraperMock.getConstructorStandings.mockResolvedValue([]);
    notifMock.sendPostRaceNotifications.mockRejectedValue(new Error('notif fail'));
    const r = await cron.runPostGPCron('gp1', jest.fn());
    expect(r.errors.some(e => e.includes('Notificaciones'))).toBe(true);
  });
  test('cron empty positions no guarda result', async () => {
    scraperMock.getGPResults.mockResolvedValue({ positions: [] });
    scraperMock.getDriverStandings.mockResolvedValue([]);
    scraperMock.getConstructorStandings.mockResolvedValue([]);
    notifMock.sendPostRaceNotifications.mockResolvedValue({ sent: 0, errors: 0 });
    const r = await cron.runPostGPCron('gp1', jest.fn());
    expect(r.ok).toBe(true);
  });
});
