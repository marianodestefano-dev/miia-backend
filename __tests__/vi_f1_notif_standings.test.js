"use strict";

// Cubre gaps en f1_notifications.js lineas 94-97:
//   - if (standingsDoc.exists) true-branch  => s.position/points != null (ternarios true)
//   - standingsDoc.exists false-branch
//   - catch block cuando standings get() rechaza

function buildDb({ standingsExists = true, standingsData = {}, throwStandings = false } = {}) {
  const gpDoc     = { exists: true, data: () => ({ name: 'Monaco GP', date: '2025-05-25' }) };
  const resultDoc = { exists: true, data: () => ({ positions: [{ driver_id: 'HAM', position: 2, points: 18 }] }) };
  const driverDoc = { exists: true, data: () => ({ name: 'Lewis Hamilton', team: 'Mercedes' }) };
  const ownerDoc  = { data: () => ({ phone: '+5491112345678' }) };
  const standDoc  = { exists: standingsExists, data: () => standingsData };

  const docMock = jest.fn().mockImplementation((path) => {
    if (typeof path === 'string' && path.includes('standings')) {
      if (throwStandings) return { get: () => Promise.reject(new Error('standings-db-err')) };
      return { get: () => Promise.resolve(standDoc) };
    }
    if (typeof path === 'string' && path.includes('results'))  return { get: () => Promise.resolve(resultDoc) };
    if (typeof path === 'string' && path.includes('drivers'))  return { get: () => Promise.resolve(driverDoc) };
    if (typeof path === 'string' && path.startsWith('owners/')) return { get: () => Promise.resolve(ownerDoc) };
    return { get: () => Promise.resolve(gpDoc) };
  });

  const scheduleSnap = { empty: false, docs: [{ data: () => ({ name: 'Spanish GP', date: '2025-06-01' }) }] };
  const prefsSnap = {
    size: 1,
    docs: [{ data: () => ({ adopted_driver: 'HAM', uid: 'owner1', notifications: true }) }],
  };

  return {
    doc: docMock,
    collection: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue(scheduleSnap),
    }),
    collectionGroup: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue(prefsSnap),
    }),
  };
}

function loadMod(dbOpts) {
  jest.resetModules();
  const db = buildDb(dbOpts);
  jest.doMock('firebase-admin', () => ({ firestore: jest.fn().mockReturnValue(db) }));
  jest.doMock('../sports/f1_dashboard/f1_schema', () => ({
    paths: {
      gp:     jest.fn().mockReturnValue('f1_data/2026/schedule/monaco'),
      result: jest.fn().mockReturnValue('f1_data/2026/results/monaco'),
      driver: jest.fn().mockReturnValue('f1_data/2026/drivers/HAM'),
    },
  }));
  return require('../sports/f1_dashboard/f1_notifications');
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('f1_notifications standings — lineas 94-97', () => {
  test('standingsDoc.exists=true con position=3 points=150 → worldPos/worldPts reales (lineas 96-97 true-branch)', async () => {
    const mod = loadMod({ standingsExists: true, standingsData: { position: 3, points: 150 } });
    const send = jest.fn().mockResolvedValue({});
    const r = await mod.sendPostRaceNotifications('monaco', send);
    expect(r.sent).toBe(1);
    const msg = send.mock.calls[0][1];
    expect(msg).toContain('Mundial: P3 con 150 puntos');
  });

  test('standingsDoc.exists=false → worldPos null → sin linea Mundial (linea 94 false-branch)', async () => {
    const mod = loadMod({ standingsExists: false });
    const send = jest.fn().mockResolvedValue({});
    const r = await mod.sendPostRaceNotifications('monaco', send);
    expect(r.sent).toBe(1);
    expect(send.mock.calls[0][1]).not.toContain('Mundial:');
  });

  test('standings get() rechaza → catch (linea 99) → fail-open, sin linea Mundial', async () => {
    const mod = loadMod({ throwStandings: true });
    const send = jest.fn().mockResolvedValue({});
    const r = await mod.sendPostRaceNotifications('monaco', send);
    expect(r.sent).toBe(1);
    expect(send.mock.calls[0][1]).not.toContain('Mundial:');
  });
});
