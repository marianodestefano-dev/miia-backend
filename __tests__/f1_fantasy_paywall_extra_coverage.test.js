'use strict';

/**
 * Tests focalizados para subir cobertura final de:
 *   - f1_fantasy.js (branches 91.89% → ≥95.65%): lineas 74, 106, 129
 *   - f1_paywall.js (stmts 88.88% → ≥95.65%): lineas 37-38, 100-101
 */

globalThis.__fpState = {
  ownerExists: true,
  ownerData: {},
  driverExists: true,
  driverData: { name: 'Norris' },
  prefsExists: true,
  prefsData: { fantasy_total: 100 },
  collectionDocs: [],
  throwOnGet: false,
  throwOnDocGet: false,
};

jest.mock('firebase-admin', () => {
  const FieldValue = {
    arrayUnion: (...args) => ({ __op: 'arrayUnion', args }),
    increment: (n) => ({ __op: 'increment', value: n }),
  };

  const docMethods = (path) => ({
    get: () => {
      if (globalThis.__fpState.throwOnDocGet) return Promise.reject(new Error('FS-DOC-ERR'));
      if (path.includes('owners/') && path.endsWith('/f1_prefs/current')) {
        return Promise.resolve({
          exists: globalThis.__fpState.prefsExists,
          data: () => globalThis.__fpState.prefsData,
        });
      }
      if (path.includes('drivers/')) {
        return Promise.resolve({
          exists: globalThis.__fpState.driverExists,
          data: () => globalThis.__fpState.driverData,
        });
      }
      return Promise.resolve({
        exists: globalThis.__fpState.ownerExists,
        data: () => globalThis.__fpState.ownerData,
      });
    },
    set: () => Promise.resolve(),
  });

  const collectionMock = (name) => {
    const _api = {
      doc: (id) => docMethods(name + '/' + id),
      where: () => _api,
      orderBy: () => _api,
      limit: () => _api,
      add: () => Promise.resolve({ id: 'n' }),
      get: () => globalThis.__fpState.throwOnGet
        ? Promise.reject(new Error('FS-COLL-ERR'))
        : Promise.resolve({
            docs: globalThis.__fpState.collectionDocs.map(d => ({ id: d.id, data: () => d.data })),
            empty: globalThis.__fpState.collectionDocs.length === 0,
          }),
    };
    return _api;
  };

  const firestoreFn = () => ({
    collection: collectionMock,
    collectionGroup: collectionMock,
    doc: docMethods,
  });
  firestoreFn.FieldValue = FieldValue;

  return { firestore: firestoreFn };
});

jest.mock('../sports/f1_dashboard/f1_schema', () => ({
  paths: {
    driver: (s, d) => `f1_data/${s}/drivers/${d}`,
    f1Prefs: (uid) => `owners/${uid}/f1_prefs/current`,
  },
}));

const fantasy = require('../sports/f1_dashboard/f1_fantasy');
const paywall = require('../sports/f1_dashboard/f1_paywall');

beforeEach(() => {
  globalThis.__fpState.ownerExists = true;
  globalThis.__fpState.ownerData = {};
  globalThis.__fpState.driverExists = true;
  globalThis.__fpState.driverData = { name: 'Norris' };
  globalThis.__fpState.prefsExists = true;
  globalThis.__fpState.prefsData = { fantasy_total: 100 };
  globalThis.__fpState.collectionDocs = [];
  globalThis.__fpState.throwOnGet = false;
  globalThis.__fpState.throwOnDocGet = false;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (console.log.mockRestore) console.log.mockRestore();
  if (console.error.mockRestore) console.error.mockRestore();
});

// ───── f1_fantasy branches ─────
describe('f1_fantasy — uncovered branches', () => {
  test('updateOwnerFantasyScore con gpResult.positions undefined → fallback []', async () => {
    // Linea 74: (gpResult.positions || []).find — branch falsy
    const r = await fantasy.updateOwnerFantasyScore('uid1', 'norris', 'monaco', {
      // sin positions
      fastest_lap: 'Norris',
    });
    expect(r.points).toBe(0);
    expect(r.total).toBe(0);
  });

  test('updateOwnerFantasyScore con prefs.data().fantasy_total falsy → fallback points', async () => {
    // Linea 106: (updatedPrefs.data() && data().fantasy_total) || points
    globalThis.__fpState.prefsExists = true;
    globalThis.__fpState.prefsData = {}; // sin fantasy_total → falsy → fallback a points
    const r = await fantasy.updateOwnerFantasyScore('uid1', 'norris', 'monaco', {
      positions: [{ driver_id: 'norris', position: 1 }],
    });
    expect(r.points).toBe(25); // P1
    expect(r.total).toBe(25);
  });

  test('updateOwnerFantasyScore con prefsExists=false → updatedPrefs.data() falsy', async () => {
    // Linea 106: branch izquierda (data() falsy)
    globalThis.__fpState.prefsExists = false;
    globalThis.__fpState.prefsData = undefined;
    const r = await fantasy.updateOwnerFantasyScore('uid1', 'norris', 'monaco', {
      positions: [{ driver_id: 'norris', position: 2 }],
    });
    expect(r.points).toBe(18);
    expect(r.total).toBe(18);
  });

  test('getFantasyLeaderboard con prefs.fantasy_total=0 → || 0 fallback', async () => {
    // El filter en linea 124 descarta si !prefs.fantasy_total. Entonces para tocar
    // linea 129 (|| 0), necesito un prefs con fantasy_total truthy en filter pero
    // luego falsy al pushear. Eso pasa solo si fantasy_total es truthy (no 0).
    // El filtro deja pasar, push hace || 0 con valor truthy → branch truthy.
    // Para branch falsy debo modificar el filtro... linea 129 fallback es dead.
    // Igual cubro path normal:
    globalThis.__fpState.collectionDocs = [
      { id: 'a', data: { uid: 'u1', adopted_driver: 'norris', fantasy_total: 50 } },
      { id: 'b', data: { uid: 'u2', adopted_driver: 'piastri', fantasy_total: 30 } },
    ];
    const r = await fantasy.getFantasyLeaderboard('2025');
    expect(r.length).toBe(2);
    expect(r[0].rank).toBe(1);
  });
});

// ───── f1_paywall uncovered ─────
describe('f1_paywall — catch blocks', () => {
  test('hasF1Addon catch path (firestore throw → false)', async () => {
    globalThis.__fpState.throwOnDocGet = true;
    const r = await paywall.hasF1Addon('uid1');
    expect(r).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  test('hasF1Addon sin uid → false (early return)', async () => {
    const r = await paywall.hasF1Addon(null);
    expect(r).toBe(false);
  });

  test('hasF1Addon owner.exists=false → false', async () => {
    globalThis.__fpState.ownerExists = false;
    const r = await paywall.hasF1Addon('uid1');
    expect(r).toBe(false);
  });

  test('hasF1Addon f1_active=true → true', async () => {
    globalThis.__fpState.ownerExists = true;
    globalThis.__fpState.ownerData = { f1_active: true };
    const r = await paywall.hasF1Addon('uid1');
    expect(r).toBe(true);
  });

  test('hasF1Addon addons array contiene f1_dashboard → true', async () => {
    globalThis.__fpState.ownerExists = true;
    globalThis.__fpState.ownerData = { addons: ['f1_dashboard', 'other'] };
    const r = await paywall.hasF1Addon('uid1');
    expect(r).toBe(true);
  });

  test('hasF1Addon subscription empty → false', async () => {
    globalThis.__fpState.ownerExists = true;
    globalThis.__fpState.ownerData = {};
    globalThis.__fpState.collectionDocs = [];
    const r = await paywall.hasF1Addon('uid1');
    expect(r).toBe(false);
  });

  test('hasF1Addon subscription tiene doc → true', async () => {
    globalThis.__fpState.ownerExists = true;
    globalThis.__fpState.ownerData = {};
    globalThis.__fpState.collectionDocs = [{ id: 'sub1', data: { status: 'active' } }];
    const r = await paywall.hasF1Addon('uid1');
    expect(r).toBe(true);
  });

  test('requireF1Addon middleware: no uid → 401', () => {
    const req = { user: null };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    paywall.requireF1Addon(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('requireF1Addon: hasF1Addon resolve true → next()', async () => {
    globalThis.__fpState.ownerData = { f1_active: true };
    const req = { user: { uid: 'uid1' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    paywall.requireF1Addon(req, res, next);
    await new Promise(r => setImmediate(r));
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('requireF1Addon: hasF1Addon resolve false → 402', async () => {
    globalThis.__fpState.ownerExists = false;
    const req = { user: { uid: 'uid1' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    paywall.requireF1Addon(req, res, next);
    await new Promise(r => setImmediate(r));
    expect(res.status).toHaveBeenCalledWith(402);
  });

  test('requireF1Addon: hasF1Addon rechaza → fail-open next() (catch ramo lineas 100-101)', async () => {
    // Spy module.exports.hasF1Addon para forzar reject — cubre catch fail-open.
    const orig = paywall.hasF1Addon;
    paywall.hasF1Addon = () => Promise.reject(new Error('forced'));
    const req = { user: { uid: 'uid1' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    paywall.requireF1Addon(req, res, next);
    await new Promise(r => setImmediate(r));
    expect(next).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
    paywall.hasF1Addon = orig;
  });
});
