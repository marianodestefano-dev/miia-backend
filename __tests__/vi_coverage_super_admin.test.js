'use strict';

/**
 * VI-BACKEND-COVERAGE: core/super_admin.js — 100% branches
 */

const sa = require('../core/super_admin');

function makeDb({ ownersSnap, leadsSnap, mrrSnap, adminSnap } = {}) {
  const collections = {
    owners: {
      limit: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(ownersSnap || { forEach: jest.fn() }) }),
      get: jest.fn().mockResolvedValue(ownersSnap || { docs: [] }),
    },
    leads: {
      get: jest.fn().mockResolvedValue(leadsSnap || { docs: [] }),
    },
    subscriptions: {
      where: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue(mrrSnap || { forEach: jest.fn() }),
    },
    super_admins: {
      doc: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(adminSnap || { exists: false, data: () => ({}) }) }),
    },
  };
  return {
    collection: jest.fn().mockImplementation((name) => collections[name] || {
      where: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ docs: [], forEach: jest.fn() }),
    }),
  };
}

beforeEach(() => jest.clearAllMocks());

// ── getAllOwners ───────────────────────────────────────────────────

describe('getAllOwners', () => {
  test('sin opts → limit=50 (branch (opts && opts.limit) false)', async () => {
    const db = makeDb({
      ownersSnap: {
        forEach: jest.fn(fn => [
          { id: 'uid1', data: () => ({ _deleted: false, companyName: 'Acme', plan: 'pro', createdAt: '2024-01-01' }) },
          { id: 'uid2', data: () => ({ _deleted: true, companyName: 'Deleted', plan: 'free', createdAt: '2024-01-01' }) },
        ].forEach(fn)),
      },
    });
    sa.__setFirestoreForTests(db);
    const owners = await sa.getAllOwners();
    expect(owners.length).toBe(1); // _deleted=true filtered out
  });

  test('con opts.limit → usa ese limit (branch opts.limit truthy)', async () => {
    const db = makeDb({
      ownersSnap: { forEach: jest.fn() },
    });
    sa.__setFirestoreForTests(db);
    const owners = await sa.getAllOwners({ limit: 10 });
    expect(Array.isArray(owners)).toBe(true);
  });
});

// ── getSystemStats ─────────────────────────────────────────────────

describe('getSystemStats', () => {
  test('con docs array → totalOwners y totalLeads > 0 (branch .docs truthy)', async () => {
    const db = makeDb({
      ownersSnap: { docs: [{ id: 'o1' }] },
      leadsSnap: { docs: [{ id: 'l1' }, { id: 'l2' }] },
      mrrSnap: {
        forEach: jest.fn(fn => [
          { data: () => ({ monthlyAmount: 99.99 }) },
        ].forEach(fn)),
      },
    });
    sa.__setFirestoreForTests(db);
    const stats = await sa.getSystemStats();
    expect(stats.totalOwners).toBe(1);
    expect(stats.totalLeads).toBe(2);
    expect(stats.totalMrr).toBeCloseTo(99.99);
  });

  test('sin docs (snap sin .docs) → 0 (branch .docs falsy)', async () => {
    const db = makeDb({
      ownersSnap: { /* no docs property */ },
      leadsSnap: { /* no docs property */ },
      mrrSnap: { forEach: jest.fn() },
    });
    sa.__setFirestoreForTests(db);
    const stats = await sa.getSystemStats();
    expect(stats.totalOwners).toBe(0);
    expect(stats.totalLeads).toBe(0);
  });

  test('MRR sin monthlyAmount → 0 (branch monthlyAmount || 0)', async () => {
    const db = makeDb({
      ownersSnap: { docs: [] },
      leadsSnap: { docs: [] },
      mrrSnap: {
        forEach: jest.fn(fn => [{ data: () => ({}) }].forEach(fn)),
      },
    });
    sa.__setFirestoreForTests(db);
    const stats = await sa.getSystemStats();
    expect(stats.totalMrr).toBe(0);
  });
});

// ── isSuperAdmin ───────────────────────────────────────────────────

describe('isSuperAdmin', () => {
  test('!uid → false (branch !uid)', async () => {
    expect(await sa.isSuperAdmin('')).toBe(false);
    expect(await sa.isSuperAdmin(null)).toBe(false);
  });

  test('snap.exists=false → false (branch snap.exists false)', async () => {
    const db = makeDb({ adminSnap: { exists: false, data: () => ({}) } });
    sa.__setFirestoreForTests(db);
    expect(await sa.isSuperAdmin('uid1')).toBe(false);
  });

  test('snap.exists=true + active=true → true', async () => {
    const db = makeDb({ adminSnap: { exists: true, data: () => ({ active: true }) } });
    sa.__setFirestoreForTests(db);
    expect(await sa.isSuperAdmin('uid1')).toBe(true);
  });

  test('snap.exists=true + active=false → false (branch !!active false)', async () => {
    const db = makeDb({ adminSnap: { exists: true, data: () => ({ active: false }) } });
    sa.__setFirestoreForTests(db);
    expect(await sa.isSuperAdmin('uid1')).toBe(false);
  });
});

// ── getDb fallback ─────────────────────────────────────────────────

describe('getDb fallback — _db=null usa firebase directo', () => {
  test('branch _db falsy → require(../config/firebase).db', async () => {
    jest.resetModules();
    const fbDb = {
      collection: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ forEach: jest.fn() }),
        }),
      }),
    };
    jest.doMock('../config/firebase', () => ({ db: fbDb }), { virtual: true });
    const freshMod = require('../core/super_admin');
    const owners = await freshMod.getAllOwners();
    expect(fbDb.collection).toHaveBeenCalled();
    expect(Array.isArray(owners)).toBe(true);
    jest.dontMock('../config/firebase');
    jest.resetModules();
  });
});
