'use strict';

/**
 * VI-BACKEND-COVERAGE: ludomiia_dashboard.js — 100% branches
 */

const { getLudoDashboard, getRecentSessions, __setFirestoreForTests } = require('../core/ludomiia_dashboard');

function makeDb(sessions = [], orderBySupported = true) {
  const baseColl = {
    where: () => ({
      get: () => Promise.resolve({
        forEach: (cb) => sessions.forEach(d => cb({ data: () => d })),
      }),
      orderBy: () => ({
        limit: () => ({
          get: () => Promise.resolve({
            forEach: (cb) => sessions.forEach(d => cb({ data: () => d })),
          }),
        }),
      }),
    }),
  };
  return { collection: () => baseColl };
}

// ── getLudoDashboard ──────────────────────────────────────────────────────────

describe('getLudoDashboard', () => {
  test('uid faltante → throw', async () => {
    await expect(getLudoDashboard(null)).rejects.toThrow('uid required');
    await expect(getLudoDashboard('')).rejects.toThrow('uid required');
  });

  test('sin sesiones → avgScore=0, todo en 0', async () => {
    __setFirestoreForTests(makeDb([]));
    const r = await getLudoDashboard('uid-1');
    expect(r.uid).toBe('uid-1');
    expect(r.totalSessions).toBe(0);
    expect(r.activeSessions).toBe(0);
    expect(r.completedSessions).toBe(0);
    expect(r.avgScore).toBe(0); // completed.length === 0 → branch false
    expect(r.byGame).toEqual({});
  });

  test('sesiones activas y completadas → cuenta correcta + avgScore', async () => {
    __setFirestoreForTests(makeDb([
      { status: 'active', gameType: 'ludo', score: 0 },
      { status: 'completed', gameType: 'ludo', score: 80 },
      { status: 'completed', gameType: 'chess', score: 60 },
    ]));
    const r = await getLudoDashboard('uid-2');
    expect(r.activeSessions).toBe(1);
    expect(r.completedSessions).toBe(2); // completed.length > 0 → branch true
    expect(r.avgScore).toBe(70.0);
    expect(r.byGame.ludo).toBe(2);
    expect(r.byGame.chess).toBe(1);
    expect(r.totalSessions).toBe(3);
  });

  test('sesión completada sin campo score → usa 0 default', async () => {
    __setFirestoreForTests(makeDb([
      { status: 'completed', gameType: 'ludo' }, // sin score
    ]));
    const r = await getLudoDashboard('uid-3');
    expect(r.avgScore).toBe(0);
  });

  test('byGame con gameType undefined → acumula en byGame[undefined]', async () => {
    __setFirestoreForTests(makeDb([
      { status: 'active' }, // sin gameType
    ]));
    const r = await getLudoDashboard('uid-4');
    expect(r.totalSessions).toBe(1);
  });
});

// ── getRecentSessions ─────────────────────────────────────────────────────────

describe('getRecentSessions', () => {
  test('uid faltante → throw', async () => {
    await expect(getRecentSessions(null, 5)).rejects.toThrow('uid required');
    await expect(getRecentSessions('', 5)).rejects.toThrow('uid required');
  });

  test('con limit → usa ese valor', async () => {
    const sessions = [{ gameType: 'ludo', status: 'active' }];
    __setFirestoreForTests(makeDb(sessions));
    const r = await getRecentSessions('uid-1', 5);
    expect(Array.isArray(r)).toBe(true);
    expect(r).toHaveLength(1);
  });

  test('sin limit → usa 10 por defecto (branch || 10)', async () => {
    __setFirestoreForTests(makeDb([]));
    const r = await getRecentSessions('uid-2', null); // null → n = 10
    expect(Array.isArray(r)).toBe(true);
  });

  test('limit=0 (falsy) → usa 10 por defecto', async () => {
    __setFirestoreForTests(makeDb([]));
    const r = await getRecentSessions('uid-3', 0); // 0 → falsy → n = 10
    expect(Array.isArray(r)).toBe(true);
  });
});

// ── getDb() firebase fallback ─────────────────────────────────────────────────

describe('getDb() fallback a config/firebase', () => {
  test('sin _db → usa config/firebase virtual', async () => {
    jest.resetModules();
    jest.doMock('../config/firebase', () => ({
      db: {
        collection: () => ({
          where: () => ({
            get: () => Promise.resolve({ forEach: () => {} }),
          }),
        }),
      },
    }), { virtual: true });
    const { getLudoDashboard: get } = require('../core/ludomiia_dashboard');
    const r = await get('uid-fb');
    expect(r.totalSessions).toBe(0);
    jest.dontMock('../config/firebase');
  });
});
