'use strict';

/**
 * VI-BACKEND-COVERAGE: cohort_analysis.js — 100% branches
 * Usa hook __setFirestoreForTests para evitar Firebase real.
 */

const { buildCohorts, getMonthKey, __setFirestoreForTests } = require('../core/cohort_analysis');

// ── getMonthKey ───────────────────────────────────────────────────────────────

describe('getMonthKey', () => {
  test('enero → 2026-01', () => {
    expect(getMonthKey(new Date('2026-01-15').getTime())).toBe('2026-01');
  });

  test('octubre → 2026-10', () => {
    expect(getMonthKey(new Date('2026-10-05').getTime())).toBe('2026-10');
  });

  test('diciembre → 2025-12', () => {
    expect(getMonthKey(new Date('2025-12-31').getTime())).toBe('2025-12');
  });
});

// ── buildCohorts ──────────────────────────────────────────────────────────────

function makeFakeDb(docs) {
  return {
    collection: () => ({
      where: () => ({
        get: () => Promise.resolve({
          forEach: (cb) => docs.forEach(d => cb({ data: () => d })),
        }),
      }),
    }),
  };
}

describe('buildCohorts', () => {
  test('uid requerido — throw si no se pasa', async () => {
    await expect(buildCohorts(undefined)).rejects.toThrow('uid required');
  });

  test('sin docs → cohorts vacío', async () => {
    __setFirestoreForTests(makeFakeDb([]));
    const r = await buildCohorts('uid-1');
    expect(r.uid).toBe('uid-1');
    expect(r.cohorts).toHaveLength(0);
  });

  test('un lead reciente → retained=1, retentionRate=100', async () => {
    const recentTs = Date.now() - 1000; // hace 1 segundo → dentro de 30 días
    __setFirestoreForTests(makeFakeDb([
      { uid: 'uid-2', createdAt: new Date('2026-01-01').getTime(), lastMessageAt: recentTs },
    ]));
    const r = await buildCohorts('uid-2');
    expect(r.cohorts).toHaveLength(1);
    expect(r.cohorts[0].retained).toBe(1);
    expect(r.cohorts[0].retentionRate).toBe(100);
  });

  test('lead antiguo (lastMessageAt > 30d) → retained=0', async () => {
    const oldTs = Date.now() - 31 * 24 * 60 * 60 * 1000; // hace 31 días
    __setFirestoreForTests(makeFakeDb([
      { uid: 'uid-3', createdAt: new Date('2026-01-01').getTime(), lastMessageAt: oldTs },
    ]));
    const r = await buildCohorts('uid-3');
    expect(r.cohorts[0].retained).toBe(0);
    expect(r.cohorts[0].retentionRate).toBe(0);
  });

  test('lead sin lastMessageAt → no retiene', async () => {
    __setFirestoreForTests(makeFakeDb([
      { uid: 'uid-4', createdAt: new Date('2026-02-01').getTime() },
    ]));
    const r = await buildCohorts('uid-4');
    expect(r.cohorts[0].retained).toBe(0);
  });

  test('lead sin createdAt usa Date.now() como fallback', async () => {
    const recentTs = Date.now() - 1000;
    __setFirestoreForTests(makeFakeDb([
      { uid: 'uid-5', lastMessageAt: recentTs }, // sin createdAt
    ]));
    const r = await buildCohorts('uid-5');
    expect(r.cohorts).toHaveLength(1);
    expect(r.cohorts[0].size).toBe(1);
  });

  test('múltiples docs en distintos meses → cohorts separadas y ordenadas', async () => {
    const recent = Date.now() - 1000;
    // Use noon local timestamps to avoid timezone-boundary issues
    const jan = new Date(); jan.setFullYear(2026, 0, 15); jan.setHours(12, 0, 0, 0);
    const mar = new Date(); mar.setFullYear(2026, 2, 15); mar.setHours(12, 0, 0, 0);
    __setFirestoreForTests(makeFakeDb([
      { uid: 'u', createdAt: mar.getTime(), lastMessageAt: recent },
      { uid: 'u', createdAt: jan.getTime() },
      { uid: 'u', createdAt: jan.getTime(), lastMessageAt: recent },
    ]));
    const r = await buildCohorts('u');
    expect(r.cohorts).toHaveLength(2);
    expect(r.cohorts[0].month).toBe('2026-01'); // ordenado asc
    expect(r.cohorts[0].size).toBe(2);
    expect(r.cohorts[0].retained).toBe(1);
    expect(r.cohorts[1].month).toBe('2026-03');
    expect(r.cohorts[1].retained).toBe(1);
  });

  test('retentionRate calculada correctamente con size > 0', async () => {
    const recent = Date.now() - 1000;
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const apr = new Date(); apr.setFullYear(2026, 3, 15); apr.setHours(12, 0, 0, 0);
    __setFirestoreForTests(makeFakeDb([
      { uid: 'u', createdAt: apr.getTime(), lastMessageAt: recent },
      { uid: 'u', createdAt: apr.getTime(), lastMessageAt: old },
      { uid: 'u', createdAt: apr.getTime(), lastMessageAt: recent },
    ]));
    const r = await buildCohorts('u');
    expect(r.cohorts[0].size).toBe(3);
    expect(r.cohorts[0].retained).toBe(2);
    expect(r.cohorts[0].retentionRate).toBeCloseTo(66.7, 0);
  });
});
