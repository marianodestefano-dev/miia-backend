'use strict';

const {
  appendLearning,
  getRecent,
  getTotalSize,
  cleanupOldSnapshots,
  MAX_TEXT_CHARS_PER_SNAPSHOT,
  MAX_SUMMARY_CHARS,
  __setFirestoreForTests,
} = require('../core/training_data_store');

// ── Mock ──────────────────────────────────────────────────────────────────────

function makeDb(opts) {
  const o = opts || {};
  const snapshots = o.snapshots || {};
  const captures = { sets: [], deletes: [] };

  const docFn = jest.fn((snapId) => ({
    get: jest.fn().mockResolvedValue({
      exists: !!snapshots[snapId],
      data: () => snapshots[snapId] || {},
    }),
    set: jest.fn((payload) => {
      captures.sets.push({ snapId, payload });
      snapshots[snapId] = payload;
      return Promise.resolve({});
    }),
    delete: jest.fn(() => {
      captures.deletes.push(snapId);
      delete snapshots[snapId];
      return Promise.resolve({});
    }),
  }));

  const colObj = {
    doc: docFn,
    get: jest.fn().mockResolvedValue({
      docs: Object.entries(snapshots).map(function ([id, data]) {
        return {
          id,
          ref: docFn(id),
          data: () => data,
        };
      }),
    }),
  };

  const subCollFn = jest.fn(() => colObj);
  const ownerDocFn = jest.fn(() => ({ collection: subCollFn }));
  const db = { collection: jest.fn(() => ({ doc: ownerDocFn })) };
  return { db, captures };
}

beforeEach(() => {
  __setFirestoreForTests(null);
});

// ── appendLearning ────────────────────────────────────────────────────────────

describe('appendLearning', () => {
  test('uid null -> throw', async () => {
    await expect(appendLearning(null, 'src', 'CO', 'text')).rejects.toThrow('uid_requerido');
  });
  test('source null -> throw', async () => {
    await expect(appendLearning('uid1', null, 'CO', 'text')).rejects.toThrow('source_requerido');
  });
  test('text no string -> throw', async () => {
    await expect(appendLearning('uid1', 'src', 'CO', 123)).rejects.toThrow('text_requerido_string');
  });

  test('OK con todos los campos', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await appendLearning('uid12345', 'web_scraper', 'COLOMBIA', 'texto raw', 'resumen gemini');
    expect(r.snapshotId).toBeDefined();
    expect(r.sizeChars).toBe('texto raw'.length);
    expect(captures.sets[0].payload.source).toBe('web_scraper');
    expect(captures.sets[0].payload.country).toBe('COLOMBIA');
    expect(captures.sets[0].payload.gemini_summary).toBe('resumen gemini');
  });

  test('country null -> guarda null', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await appendLearning('uid12345', 'src', null, 'text');
    expect(captures.sets[0].payload.country).toBeNull();
  });

  test('sin summary -> null', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await appendLearning('uid12345', 'src', 'CO', 'text');
    expect(captures.sets[0].payload.gemini_summary).toBeNull();
  });

  test('summary no-string -> null', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await appendLearning('uid12345', 'src', 'CO', 'text', 12345);
    expect(captures.sets[0].payload.gemini_summary).toBeNull();
  });

  test('text largo -> truncado a MAX_TEXT_CHARS_PER_SNAPSHOT', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const longText = 'a'.repeat(MAX_TEXT_CHARS_PER_SNAPSHOT + 1000);
    const r = await appendLearning('uid12345', 'src', 'CO', longText);
    expect(r.sizeChars).toBe(MAX_TEXT_CHARS_PER_SNAPSHOT);
    expect(captures.sets[0].payload.text.length).toBe(MAX_TEXT_CHARS_PER_SNAPSHOT);
  });

  test('summary largo -> truncado a MAX_SUMMARY_CHARS', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const longSummary = 'b'.repeat(MAX_SUMMARY_CHARS + 100);
    await appendLearning('uid12345', 'src', 'CO', 'text', longSummary);
    expect(captures.sets[0].payload.gemini_summary.length).toBe(MAX_SUMMARY_CHARS);
  });
});

// ── getRecent ────────────────────────────────────────────────────────────────

describe('getRecent', () => {
  test('uid null -> throw', async () => {
    await expect(getRecent(null)).rejects.toThrow('uid_requerido');
  });

  test('sin snapshots -> []', async () => {
    const { db } = makeDb({ snapshots: {} });
    __setFirestoreForTests(db);
    const r = await getRecent('uid12345');
    expect(r).toEqual([]);
  });

  test('filtra por dias y ordena desc por ts', async () => {
    const now = Date.now();
    const recent1 = new Date(now - 1000 * 60 * 60).toISOString(); // 1h
    const recent2 = new Date(now - 1000 * 60 * 60 * 24 * 3).toISOString(); // 3d
    const old = new Date(now - 1000 * 60 * 60 * 24 * 30).toISOString(); // 30d
    const { db } = makeDb({
      snapshots: {
        s1: { snapshotId: 's1', ts: recent1, source: 'a' },
        s2: { snapshotId: 's2', ts: recent2, source: 'b' },
        s3: { snapshotId: 's3', ts: old, source: 'c' },
      },
    });
    __setFirestoreForTests(db);
    const r = await getRecent('uid12345', 7); // ultimos 7 dias
    expect(r).toHaveLength(2);
    expect(r[0].source).toBe('a'); // mas reciente
    expect(r[1].source).toBe('b');
  });

  test('days no number -> usa default 7', async () => {
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString();
    const { db } = makeDb({
      snapshots: { s1: { snapshotId: 's1', ts: old, source: 'a' } },
    });
    __setFirestoreForTests(db);
    const r = await getRecent('uid12345', 'foo');
    expect(r).toEqual([]); // 30d > 7d default -> excluido
  });

  test('days 0 -> default 7', async () => {
    const recent = new Date().toISOString();
    const { db } = makeDb({
      snapshots: { s1: { snapshotId: 's1', ts: recent, source: 'a' } },
    });
    __setFirestoreForTests(db);
    const r = await getRecent('uid12345', 0);
    expect(r).toHaveLength(1);
  });

  test('snap.docs undefined -> []', async () => {
    const customDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            doc: jest.fn(),
            get: jest.fn().mockResolvedValue({}),
          })),
        })),
      })),
    };
    __setFirestoreForTests(customDb);
    const r = await getRecent('uid12345');
    expect(r).toEqual([]);
  });

  test('snapshot sin ts -> excluido', async () => {
    const { db } = makeDb({
      snapshots: { s1: { snapshotId: 's1', source: 'a' } }, // sin ts
    });
    __setFirestoreForTests(db);
    const r = await getRecent('uid12345');
    expect(r).toEqual([]);
  });
});

// ── getTotalSize ──────────────────────────────────────────────────────────────

describe('getTotalSize', () => {
  test('uid null -> throw', async () => {
    await expect(getTotalSize(null)).rejects.toThrow('uid_requerido');
  });

  test('sin snapshots -> 0', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    expect(await getTotalSize('uid12345')).toBe(0);
  });

  test('suma sizeChars', async () => {
    const { db } = makeDb({
      snapshots: {
        s1: { sizeChars: 100 },
        s2: { sizeChars: 250 },
        s3: { sizeChars: 50 },
      },
    });
    __setFirestoreForTests(db);
    expect(await getTotalSize('uid12345')).toBe(400);
  });

  test('snapshot sin sizeChars -> 0', async () => {
    const { db } = makeDb({
      snapshots: { s1: {}, s2: { sizeChars: 200 } },
    });
    __setFirestoreForTests(db);
    expect(await getTotalSize('uid12345')).toBe(200);
  });

  test('snap.docs undefined -> 0', async () => {
    const customDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            doc: jest.fn(),
            get: jest.fn().mockResolvedValue({}),
          })),
        })),
      })),
    };
    __setFirestoreForTests(customDb);
    expect(await getTotalSize('uid12345')).toBe(0);
  });
});

// ── cleanupOldSnapshots ───────────────────────────────────────────────────────

describe('cleanupOldSnapshots', () => {
  test('uid null -> throw', async () => {
    await expect(cleanupOldSnapshots(null)).rejects.toThrow('uid_requerido');
  });

  test('sin snapshots -> 0 eliminados', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await cleanupOldSnapshots('uid12345');
    expect(r.deleted).toBe(0);
  });

  test('snapshots viejos -> eliminados', async () => {
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 100).toISOString();
    const recent = new Date().toISOString();
    const { db, captures } = makeDb({
      snapshots: {
        s_old: { snapshotId: 's_old', ts: old },
        s_recent: { snapshotId: 's_recent', ts: recent },
      },
    });
    __setFirestoreForTests(db);
    const r = await cleanupOldSnapshots('uid12345', 90);
    expect(r.deleted).toBe(1);
    expect(captures.deletes).toContain('s_old');
    expect(captures.deletes).not.toContain('s_recent');
  });

  test('retentionDays no number -> default 90', async () => {
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 100).toISOString();
    const { db } = makeDb({
      snapshots: { s1: { snapshotId: 's1', ts: old } },
    });
    __setFirestoreForTests(db);
    const r = await cleanupOldSnapshots('uid12345', 'foo');
    expect(r.deleted).toBe(1);
  });

  test('retentionDays 0 -> default 90', async () => {
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 100).toISOString();
    const { db } = makeDb({
      snapshots: { s1: { snapshotId: 's1', ts: old } },
    });
    __setFirestoreForTests(db);
    const r = await cleanupOldSnapshots('uid12345', 0);
    expect(r.deleted).toBe(1);
  });

  test('snapshot sin ts -> no se borra', async () => {
    const { db, captures } = makeDb({
      snapshots: { s1: { snapshotId: 's1' } },
    });
    __setFirestoreForTests(db);
    const r = await cleanupOldSnapshots('uid12345');
    expect(r.deleted).toBe(0);
    expect(captures.deletes).toEqual([]);
  });

  test('snap.docs undefined -> 0 eliminados', async () => {
    const customDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            doc: jest.fn(),
            get: jest.fn().mockResolvedValue({}),
          })),
        })),
      })),
    };
    __setFirestoreForTests(customDb);
    const r = await cleanupOldSnapshots('uid12345');
    expect(r.deleted).toBe(0);
  });
});

// ── Constantes ────────────────────────────────────────────────────────────────

describe('Constantes exportadas', () => {
  test('MAX_TEXT_CHARS_PER_SNAPSHOT = 50000', () => {
    expect(MAX_TEXT_CHARS_PER_SNAPSHOT).toBe(50000);
  });
  test('MAX_SUMMARY_CHARS = 5000', () => {
    expect(MAX_SUMMARY_CHARS).toBe(5000);
  });
});
