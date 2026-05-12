'use strict';

/**
 * VI-BACKEND-COVERAGE: core/miia_platform.js — 100% branches
 */

const mp = require('../core/miia_platform');

function makeDb() {
  const docMock = {
    set: jest.fn().mockResolvedValue({}),
    get: jest.fn().mockResolvedValue({}),
  };
  return {
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue(docMock),
      where: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ forEach: jest.fn() }),
    }),
  };
}

beforeEach(() => {
  mp.__setFirestoreForTests(makeDb());
  jest.clearAllMocks();
});

// ── registerPlugin ─────────────────────────────────────────────────

describe('registerPlugin', () => {
  test('con webhookUrl → plugin.webhookUrl set (branch webhookUrl truthy)', async () => {
    const p = await mp.registerPlugin('uid1', {
      name: 'My Plugin', description: 'desc', apiEndpoint: 'https://api.example.com', webhookUrl: 'https://wh.example.com',
    });
    expect(p.webhookUrl).toBe('https://wh.example.com');
    expect(p.status).toBe('pending_review');
  });

  test('sin webhookUrl → plugin.webhookUrl=null (branch webhookUrl falsy)', async () => {
    const p = await mp.registerPlugin('uid1', {
      name: 'Plugin', description: 'd', apiEndpoint: 'https://api.example.com',
    });
    expect(p.webhookUrl).toBeNull();
  });
});

// ── approvePlugin ──────────────────────────────────────────────────

describe('approvePlugin', () => {
  test('aprueba plugin y retorna status=approved', async () => {
    const r = await mp.approvePlugin('plugin-id-123');
    expect(r.status).toBe('approved');
  });
});

// ── listPlugins ────────────────────────────────────────────────────

describe('listPlugins', () => {
  test('sin opts → filtra por approved (branch opts.status falsy)', async () => {
    const snap = { forEach: jest.fn(fn => [{ id: 'p1', data: () => ({ name: 'Plugin1' }) }].forEach(fn)) };
    const db = {
      collection: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue(snap),
      }),
    };
    mp.__setFirestoreForTests(db);
    const result = await mp.listPlugins();
    expect(result.length).toBe(1);
  });

  test('con opts.status → filtra por ese status (branch opts.status truthy)', async () => {
    const snap = { forEach: jest.fn() };
    const db = {
      collection: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue(snap),
      }),
    };
    mp.__setFirestoreForTests(db);
    const result = await mp.listPlugins({ status: 'suspended' });
    expect(Array.isArray(result)).toBe(true);
  });

  test('sin opts null → opts={} (branch opts = opts || {})', async () => {
    const snap = { forEach: jest.fn() };
    const db = {
      collection: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue(snap),
      }),
    };
    mp.__setFirestoreForTests(db);
    const result = await mp.listPlugins(null);
    expect(Array.isArray(result)).toBe(true);
  });
});

// ── recordPluginRevenue ────────────────────────────────────────────

describe('recordPluginRevenue', () => {
  test('guarda entry con shares calculados', async () => {
    const r = await mp.recordPluginRevenue('plugin1', 100, 'USD');
    expect(r.amount).toBe(100);
    expect(r.developerShare).toBe(70);
    expect(r.miiaShare).toBe(30);
  });
});

// ── getRevenueSummary ──────────────────────────────────────────────

describe('getRevenueSummary', () => {
  test('suma total revenue y miia share (incluyendo amount=0 y miiaShare faltante)', async () => {
    const snap = {
      forEach: jest.fn(fn => [
        { data: () => ({ amount: 100, miiaShare: 30 }) },
        { data: () => ({ amount: 50 }) }, // sin miiaShare → miiaShare || 0
        { data: () => ({ amount: 0, miiaShare: 0 }) }, // amount || 0 y miiaShare || 0 false branches
      ].forEach(fn)),
    };
    const db = {
      collection: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue(snap),
      }),
    };
    mp.__setFirestoreForTests(db);
    const r = await mp.getRevenueSummary('uid1');
    expect(r.totalRevenue).toBe(150);
    expect(r.miiaShare).toBe(30);
    expect(r.developerShare).toBe(120);
  });
});

// ── getDb fallback ─────────────────────────────────────────────────

describe('getDb fallback — _db=null usa firebase directo', () => {
  test('branch _db falsy → require(../config/firebase).db', async () => {
    jest.resetModules();
    const mockSet = jest.fn().mockResolvedValue({});
    const fbDb = {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ set: mockSet }),
      }),
    };
    jest.doMock('../config/firebase', () => ({ db: fbDb }), { virtual: true });
    const freshMod = require('../core/miia_platform');
    await freshMod.approvePlugin('plugin-id-xyz');
    expect(fbDb.collection).toHaveBeenCalled();
    jest.dontMock('../config/firebase');
    jest.resetModules();
  });
});
