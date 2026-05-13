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
    arrayRemove: (...args) => ({ __op: 'arrayRemove', args }),
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
// require f1_fantasy ELIMINADO 2026-05-12 (firma Mariano). Ver feedback_NO_fantasy_F1.md.

beforeEach(() => reset());

describe('F1 R3 hasF1Addon', () => {
  test('ownerUid falsy → false sin DB lookup', async () => {
    expect(await paywall.hasF1Addon(null)).toBe(false);
    expect(await paywall.hasF1Addon('')).toBe(false);
    expect(await paywall.hasF1Addon(undefined)).toBe(false);
  });

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

  test('req sin user.uid → 401 No autenticado', () => {
    const req = { user: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    paywall.requireF1Addon(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('req sin user → 401', () => {
    const req = {};
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    paywall.requireF1Addon(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// describe Fantasy ELIMINADOS 2026-05-12 (firma Mariano).
// Tests de updateOwnerFantasyScore + getFantasyLeaderboard removidos.
// Fantasy F1 NUNCA fue pedido. Ver memoria feedback_NO_fantasy_F1.md.
