'use strict';

const {
  writeDailySnapshot,
  getSnapshot,
  cleanupOldSnapshots,
  TTL_MS,
  __setFirestoreForTests,
} = require('../core/mmc/snapshot');

// ── Mock ──────────────────────────────────────────────────────────────────────

function makeDb(opts) {
  const o = opts || {};
  const snapshots = o.snapshots || {}; // dateId -> {data, createdAt}
  const captures = { sets: [], deletes: [] };

  const docFn = jest.fn((dateId) => ({
    get: jest.fn().mockResolvedValue({
      exists: !!snapshots[dateId],
      data: () => snapshots[dateId] || {},
    }),
    set: jest.fn((payload) => {
      captures.sets.push({ dateId, payload });
      snapshots[dateId] = payload;
      return Promise.resolve({});
    }),
  }));

  const colFn = {
    doc: docFn,
    get: jest.fn().mockResolvedValue({
      docs: Object.entries(snapshots).map(function ([id, data]) {
        return {
          id,
          ref: {
            delete: jest.fn().mockImplementation(() => {
              captures.deletes.push(id);
              delete snapshots[id];
              return Promise.resolve({});
            }),
          },
          data: () => data,
        };
      }),
    }),
  };

  const subFn = jest.fn(() => colFn);
  const ownerDocFn = jest.fn(() => ({ collection: subFn }));
  const db = { collection: jest.fn(() => ({ doc: ownerDocFn })) };
  return { db, captures };
}

beforeEach(() => {
  __setFirestoreForTests(null);
});

// ── writeDailySnapshot ────────────────────────────────────────────────────────

describe('writeDailySnapshot', () => {
  test('uid null -> throw', async () => {
    await expect(writeDailySnapshot(null, {})).rejects.toThrow('uid_requerido');
  });
  test('conversations null -> throw', async () => {
    await expect(writeDailySnapshot('u1', null)).rejects.toThrow('conversations_invalido');
  });
  test('conversations no object -> throw', async () => {
    await expect(writeDailySnapshot('u1', 'string')).rejects.toThrow('conversations_invalido');
  });

  test('OK con conversations vacio -> contactsCount=0', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await writeDailySnapshot('uid12345', {});
    expect(r.contactsCount).toBe(0);
    expect(r.totalMessages).toBe(0);
    expect(captures.sets[0].payload.uid).toBe('uid12345');
  });

  test('OK con conversations y history -> totalMessages calculado', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const conversations = {
      '5491100': { history: [{ text: 'a' }, { text: 'b' }] },
      '5491200': { history: [{ text: 'c' }] },
    };
    const r = await writeDailySnapshot('uid12345', conversations);
    expect(r.contactsCount).toBe(2);
    expect(r.totalMessages).toBe(3);
    expect(captures.sets[0].payload.totalMessages).toBe(3);
  });

  test('conversations sin history o history no array -> 0 msgs en ese contact', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await writeDailySnapshot('uid12345', {
      'p1': { history: 'no_array' },
      'p2': {},
      'p3': null,
    });
    expect(r.contactsCount).toBe(3);
    expect(r.totalMessages).toBe(0);
  });

  test('opts.timestamp custom -> dateId basado en ese timestamp', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const t = Date.UTC(2026, 4, 12, 10, 0, 0); // 2026-05-12T10:00:00 UTC
    await writeDailySnapshot('uid12345', {}, { timestamp: t });
    expect(captures.sets[0].dateId).toBe('2026-05-12');
  });

  test('opts.mensajesAnalizados custom', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await writeDailySnapshot('uid12345', {}, { mensajesAnalizados: 42 });
    expect(captures.sets[0].payload.mensajesAnalizados).toBe(42);
  });

  test('sin opts.timestamp ni mensajesAnalizados -> defaults', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await writeDailySnapshot('uid12345', { p1: { history: [{ text: 'a' }] } });
    expect(captures.sets[0].payload.mensajesAnalizados).toBe(1); // default = totalMessages
  });
});

// ── getSnapshot ───────────────────────────────────────────────────────────────

describe('getSnapshot', () => {
  test('uid null -> throw', async () => {
    await expect(getSnapshot(null, '2026-05-12')).rejects.toThrow('uid_requerido');
  });

  test('no existe -> null', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    expect(await getSnapshot('uid12345', '2026-05-12')).toBeNull();
  });

  test('OK', async () => {
    const { db } = makeDb({
      snapshots: { '2026-05-12': { uid: 'u1', totalMessages: 5 } },
    });
    __setFirestoreForTests(db);
    const r = await getSnapshot('uid12345', '2026-05-12');
    expect(r.totalMessages).toBe(5);
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
    expect(r.eliminados).toBe(0);
  });

  test('snapshot reciente (<TTL) -> no se borra', async () => {
    const recent = new Date(Date.now() - 1000 * 60 * 60).toISOString(); // 1h
    const { db, captures } = makeDb({
      snapshots: { '2026-05-12': { createdAt: recent } },
    });
    __setFirestoreForTests(db);
    const r = await cleanupOldSnapshots('uid12345');
    expect(r.eliminados).toBe(0);
    expect(captures.deletes).toEqual([]);
  });

  test('snapshot antiguo (>TTL) -> borrado', async () => {
    const old = new Date(Date.now() - TTL_MS - 1000).toISOString();
    const { db, captures } = makeDb({
      snapshots: { '2026-05-08': { createdAt: old } },
    });
    __setFirestoreForTests(db);
    const r = await cleanupOldSnapshots('uid12345');
    expect(r.eliminados).toBe(1);
    expect(captures.deletes).toContain('2026-05-08');
  });

  test('snapshot sin createdAt -> no se borra (defensive)', async () => {
    const { db, captures } = makeDb({
      snapshots: { '2026-05-08': {} },
    });
    __setFirestoreForTests(db);
    const r = await cleanupOldSnapshots('uid12345');
    expect(r.eliminados).toBe(0);
    expect(captures.deletes).toEqual([]);
  });

  test('opts.nowMs custom', async () => {
    const cutoff = Date.UTC(2026, 4, 12, 0, 0, 0);
    const old = new Date(cutoff - TTL_MS - 1000).toISOString();
    const { db } = makeDb({
      snapshots: { 's1': { createdAt: old } },
    });
    __setFirestoreForTests(db);
    const r = await cleanupOldSnapshots('uid12345', { nowMs: cutoff });
    expect(r.eliminados).toBe(1);
  });

  test('mezcla recientes y antiguos -> borra solo los antiguos', async () => {
    const old = new Date(Date.now() - TTL_MS - 1000).toISOString();
    const recent = new Date(Date.now() - 1000 * 60).toISOString();
    const { db } = makeDb({
      snapshots: {
        's_old': { createdAt: old },
        's_recent': { createdAt: recent },
      },
    });
    __setFirestoreForTests(db);
    const r = await cleanupOldSnapshots('uid12345');
    expect(r.eliminados).toBe(1);
  });

  test('snap.docs undefined -> 0 (fallback)', async () => {
    const customDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            get: jest.fn().mockResolvedValue({}),
            doc: jest.fn(),
          })),
        })),
      })),
    };
    __setFirestoreForTests(customDb);
    const r = await cleanupOldSnapshots('uid12345');
    expect(r.eliminados).toBe(0);
  });
});

// ── Exports ───────────────────────────────────────────────────────────────────

describe('TTL_MS', () => {
  test('48 horas', () => expect(TTL_MS).toBe(48 * 60 * 60 * 1000));
});
