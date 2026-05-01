'use strict';
const { cleanupContactMemories, cleanupOwnerMemories, shouldDelete, CLEANUP_DEFAULTS, MS_PER_DAY, __setFirestoreForTests } = require('../core/memory_cleanup');

const UID = 'cleanupTestUid1234567890';
const NOW = Date.now();

function makeMockDb({ memories = [], throwGet = false, throwSet = false } = {}) {
  let currentMemories = [...memories];
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => {
              if (throwGet) throw new Error('get failed');
              return { exists: currentMemories.length > 0, data: () => ({ memories: currentMemories }) };
            },
            set: async (data) => {
              if (throwSet) throw new Error('set failed');
              if (data.memories) currentMemories = data.memories;
            }
          }),
          get: async () => {
            if (throwGet) throw new Error('get failed');
            return { docs: [{ id: '+573001234567', data: () => ({ memories: currentMemories }) }] };
          }
        })
      })
    })
  };
}

afterEach(() => __setFirestoreForTests(null));

describe('CLEANUP_DEFAULTS', () => {
  test('valores correctos', () => {
    expect(CLEANUP_DEFAULTS.minScore).toBe(0.05);
    expect(CLEANUP_DEFAULTS.maxAgeDays).toBe(365);
    expect(CLEANUP_DEFAULTS.maxMemoriesPerContact).toBe(100);
  });
});

describe('shouldDelete', () => {
  test('score <= minScore = true', () => {
    expect(shouldDelete({ importanceScore: 0.05 }, { minScore: 0.05, maxAgeDays: 365 }, NOW)).toBe(true);
  });
  test('score > minScore = false', () => {
    expect(shouldDelete({ importanceScore: 0.1 }, { minScore: 0.05, maxAgeDays: 365 }, NOW)).toBe(false);
  });
  test('timestamp muy antiguo = true', () => {
    const oldTs = NOW - (400 * MS_PER_DAY);
    expect(shouldDelete({ importanceScore: 0.5, timestamp: oldTs }, { minScore: 0.05, maxAgeDays: 365 }, NOW)).toBe(true);
  });
  test('timestamp reciente = false', () => {
    const recentTs = NOW - (10 * MS_PER_DAY);
    expect(shouldDelete({ importanceScore: 0.5, timestamp: recentTs }, { minScore: 0.05, maxAgeDays: 365 }, NOW)).toBe(false);
  });
  test('sin timestamp + score ok = false', () => {
    expect(shouldDelete({ importanceScore: 0.3 }, {}, NOW)).toBe(false);
  });
});

describe('cleanupContactMemories — validacion', () => {
  test('lanza si uid falta', async () => {
    await expect(cleanupContactMemories(null, '+1234')).rejects.toThrow('uid requerido');
  });
  test('lanza si phone falta', async () => {
    await expect(cleanupContactMemories(UID, '')).rejects.toThrow('phone requerido');
  });
});

describe('cleanupContactMemories — logica', () => {
  test('elimina memorias con score bajo', async () => {
    const memories = [
      { importanceScore: 0.03, text: 'baja', timestamp: NOW },
      { importanceScore: 0.5, text: 'alta', timestamp: NOW },
    ];
    __setFirestoreForTests(makeMockDb({ memories }));
    const r = await cleanupContactMemories(UID, '+1234', { _nowMs: NOW });
    expect(r.deleted).toBe(1);
    expect(r.kept).toBe(1);
  });
  test('elimina memorias muy antiguas', async () => {
    const memories = [
      { importanceScore: 0.5, text: 'vieja', timestamp: NOW - 400 * MS_PER_DAY },
      { importanceScore: 0.5, text: 'nueva', timestamp: NOW - 10 * MS_PER_DAY },
    ];
    __setFirestoreForTests(makeMockDb({ memories }));
    const r = await cleanupContactMemories(UID, '+1234', { _nowMs: NOW });
    expect(r.deleted).toBe(1);
    expect(r.kept).toBe(1);
  });
  test('retorna {0,0} si no existe el doc', async () => {
    __setFirestoreForTests(makeMockDb({ memories: [] }));
    const r = await cleanupContactMemories(UID, '+1234');
    expect(r.deleted).toBe(0);
    expect(r.kept).toBe(0);
  });
  test('fail-open si Firestore falla en get', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await cleanupContactMemories(UID, '+1234');
    expect(r.deleted).toBe(0);
    expect(r.error).toBeDefined();
  });
  test('respeta maxMemoriesPerContact', async () => {
    const memories = Array.from({ length: 5 }, (_, i) => ({
      importanceScore: 0.1 * (i + 1), text: `m${i}`, timestamp: NOW
    }));
    __setFirestoreForTests(makeMockDb({ memories }));
    const r = await cleanupContactMemories(UID, '+1234', { maxMemoriesPerContact: 3, _nowMs: NOW });
    expect(r.kept).toBeLessThanOrEqual(3);
  });
});

describe('cleanupOwnerMemories', () => {
  test('lanza si uid falta', async () => {
    await expect(cleanupOwnerMemories(null)).rejects.toThrow('uid requerido');
  });
  test('retorna processedContacts y totalDeleted', async () => {
    const memories = [{ importanceScore: 0.03, text: 'baja', timestamp: NOW }];
    __setFirestoreForTests(makeMockDb({ memories }));
    const r = await cleanupOwnerMemories(UID, { _nowMs: NOW });
    expect(typeof r.processedContacts).toBe('number');
    expect(typeof r.totalDeleted).toBe('number');
  });
  test('fail-open si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await cleanupOwnerMemories(UID);
    expect(r.processedContacts).toBe(0);
    expect(r.error).toBeDefined();
  });
});
