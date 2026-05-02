'use strict';

globalThis.__mockDocs = {};
globalThis.__mockSubs = [];
globalThis.__mockPrefsGroup = [];

jest.mock('firebase-admin', () => {
  const docFor = (path) => ({
    get: jest.fn().mockImplementation(() => Promise.resolve({
      exists: !!globalThis.__mockDocs[path],
      data: () => globalThis.__mockDocs[path],
      id: path.split('/').pop(),
    })),
    set: jest.fn().mockImplementation((data, opts) => {
      globalThis.__mockDocs[path] = opts && opts.merge
        ? { ...(globalThis.__mockDocs[path] || {}), ...data }
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
      add: jest.fn().mockResolvedValue({ id: 'new-doc' }),
      get: jest.fn().mockImplementation(() => {
        let docs = [];
        if (path.indexOf('subscriptions') >= 0) {
          docs = globalThis.__mockSubs.filter((s) =>
            filters.every((f) => f.op === '==' ? s[f.field] === f.value : true)
          );
        }
        if (limitN) docs = docs.slice(0, limitN);
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
        docs: globalThis.__mockPrefsGroup.map((d) => ({ id: 'doc', data: () => d, exists: true })),
      }),
    }),
  });
  fsFn.FieldValue = {
    arrayUnion: (...args) => ({ __op: 'arrayUnion', args }),
    increment: (n) => ({ __op: 'increment', n }),
  };
  return { firestore: fsFn };
});

const reset = () => {
  globalThis.__mockDocs = {};
  globalThis.__mockSubs = [];
  globalThis.__mockPrefsGroup = [];
};
const setOwner = (uid, data) => { globalThis.__mockDocs['owners/' + uid] = data; };
const setSub = (sub) => { globalThis.__mockSubs.push(sub); };
const setDriver = (season, id, d) => { globalThis.__mockDocs['f1_data/' + season + '/drivers/' + id] = d; };
const setPrefs = (p) => { globalThis.__mockPrefsGroup.push(p); };

const paywall = require('../sports/f1_dashboard/f1_paywall');
const fantasy = require('../sports/f1_dashboard/f1_fantasy');

beforeEach(() => reset());

describe('F1 R3 hasF1Addon', () => {
  test('owner sin doc false', async () => {
    expect(await paywall.hasF1Addon('uid-no')).toBe(false);
  });
  test('f1_active true', async () => {
    setOwner('u1', { f1_active: true });
    expect(await paywall.hasF1Addon('u1')).toBe(true);
  });
  test('addons array con f1_dashboard', async () => {
    setOwner('u2', { addons: ['f1_dashboard'] });
    expect(await paywall.hasF1Addon('u2')).toBe(true);
  });
  test('owner vacio false', async () => {
    setOwner('u4', {});
    expect(await paywall.hasF1Addon('u4')).toBe(false);
  });
  test('addons no array', async () => {
    setOwner('u5', { addons: 'no-array' });
    expect(await paywall.hasF1Addon('u5')).toBe(false);
  });
  test('sub activa true', async () => {
    setOwner('u6', {});
    setSub({ owner_uid: 'u6', addon_id: 'f1_dashboard', status: 'active' });
    expect(await paywall.hasF1Addon('u6')).toBe(true);
  });
});

describe('F1 R3 activate/deactivate', () => {
  test('activate ok', async () => {
    await paywall.activateF1Addon('u-act', 'pay-1', 'mercadopago');
    expect(globalThis.__mockDocs['owners/u-act']).toBeDefined();
  });
  test('activate sin provider', async () => {
    await paywall.activateF1Addon('u-act2', 'pay-2');
    expect(globalThis.__mockDocs['owners/u-act2']).toBeDefined();
  });
  test('deactivate ok', async () => {
    setOwner('u-deact', { f1_active: true });
    await paywall.deactivateF1Addon('u-deact');
    expect(globalThis.__mockDocs['owners/u-deact'].f1_active).toBe(false);
  });
});

describe('F1 R3 requireF1Addon middleware', () => {
  test('con addon llama next', (done) => {
    setOwner('u-mid', { f1_active: true });
    const req = { user: { uid: 'u-mid' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    paywall.requireF1Addon(req, res, next);
    setTimeout(() => { expect(next).toHaveBeenCalled(); done(); }, 30);
  });
  test('sin addon 402', (done) => {
    const req = { user: { uid: 'u-no' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    paywall.requireF1Addon(req, res, next);
    setTimeout(() => { expect(res.status).toHaveBeenCalledWith(402); done(); }, 30);
  });
});

describe('F1 R3 updateOwnerFantasyScore', () => {
  test('driver no existe -> 0', async () => {
    const r = await fantasy.updateOwnerFantasyScore('u', 'no-driver', 'gp1', { positions: [] });
    expect(r.points).toBe(0);
  });
  test('driver no en positions', async () => {
    setDriver('2025', 'norris', { name: 'L Norris' });
    const r = await fantasy.updateOwnerFantasyScore('u', 'norris', 'gp1', {
      positions: [{ driver_id: 'verstappen', position: 1 }],
    });
    expect(r.points).toBe(0);
  });
  test('driver P3', async () => {
    setDriver('2025', 'norris', { name: 'L Norris' });
    const r = await fantasy.updateOwnerFantasyScore('u', 'norris', 'gp1', {
      positions: [{ driver_id: 'norris', position: 3 }],
    });
    expect(r.points).toBeGreaterThan(0);
  });
  test('via driverId fallback', async () => {
    setDriver('2025', 'd1', { name: 'D1' });
    const r = await fantasy.updateOwnerFantasyScore('u', 'd1', 'gp1', {
      positions: [{ driverId: 'd1', position: 1 }],
    });
    expect(r.points).toBe(25);
  });
});

describe('F1 R3 getFantasyLeaderboard', () => {
  test('sin prefs []', async () => {
    expect(await fantasy.getFantasyLeaderboard()).toEqual([]);
  });
  test('skip sin uid', async () => {
    setPrefs({ adopted_driver: 'd1', fantasy_total: 100 });
    expect(await fantasy.getFantasyLeaderboard()).toEqual([]);
  });
  test('skip sin adopted_driver', async () => {
    setPrefs({ uid: 'u1', fantasy_total: 100 });
    expect(await fantasy.getFantasyLeaderboard()).toEqual([]);
  });
  test('skip sin fantasy_total', async () => {
    setPrefs({ uid: 'u1', adopted_driver: 'd1' });
    expect(await fantasy.getFantasyLeaderboard()).toEqual([]);
  });
  test('ordena desc + ranks', async () => {
    setPrefs({ uid: 'u1', adopted_driver: 'd1', fantasy_total: 50 });
    setPrefs({ uid: 'u2', adopted_driver: 'd2', fantasy_total: 100 });
    setPrefs({ uid: 'u3', adopted_driver: 'd3', fantasy_total: 25 });
    const r = await fantasy.getFantasyLeaderboard();
    expect(r[0].uid).toBe('u2');
    expect(r[0].rank).toBe(1);
    expect(r[2].rank).toBe(3);
  });
  test('season custom no rompe', async () => {
    expect(Array.isArray(await fantasy.getFantasyLeaderboard('2024'))).toBe(true);
  });
});
