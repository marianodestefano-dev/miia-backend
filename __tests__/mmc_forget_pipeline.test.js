'use strict';

const fp = require('../core/mmc/forget_pipeline');
const embeddingRetrieval = require('../core/mmc/embedding_retrieval');
const {
  detectForgetIntent,
  executeForget,
  buildForgetInjection,
  FORGET_PATTERNS,
  FORGET_THRESHOLD,
  __setFirestoreForTests,
} = fp;

// ── Mock ──────────────────────────────────────────────────────────────────────

function makeDb(opts) {
  const o = opts || {};
  const episodes = o.episodes || [];
  const captures = { sets: [] };

  const episodeDocFn = jest.fn((episodeId) => {
    const found = episodes.find(function (e) { return (e.episodeId || '') === episodeId; });
    return {
      get: jest.fn().mockResolvedValue({
        exists: !!found,
        data: () => found || {},
      }),
      set: jest.fn((payload, merge) => {
        captures.sets.push({ episodeId, payload, merge });
        if (found) {
          if (payload.deletedByOwnerAt !== undefined) found.deletedByOwnerAt = payload.deletedByOwnerAt;
          if (payload.deletionReason !== undefined) found.deletionReason = payload.deletionReason;
          if (payload.lecciones) found.lecciones = payload.lecciones;
        }
        return Promise.resolve({});
      }),
    };
  });

  function makeQuery() {
    return {
      where: jest.fn(function () { return this; }),
      get: jest.fn().mockResolvedValue({
        docs: episodes.filter(function (e) {
          return e.contradicted === false && e.deletedByOwnerAt === null;
        }).map(function (e) {
          return {
            id: e.episodeId,
            ref: episodeDocFn(e.episodeId),
            data: () => e,
          };
        }),
      }),
    };
  }

  const memoryCol = Object.assign({ doc: episodeDocFn }, makeQuery());
  const subCollFn = jest.fn(function () { return memoryCol; });
  const ownerDocFn = jest.fn(() => ({ collection: subCollFn }));
  const db = { collection: jest.fn(() => ({ doc: ownerDocFn })) };
  return { db, captures, episodes };
}

beforeEach(() => {
  __setFirestoreForTests(null);
  embeddingRetrieval.__setEmbedForTests(null);
});

// ── detectForgetIntent ────────────────────────────────────────────────────────

describe('detectForgetIntent', () => {
  test('null -> no match', () => {
    expect(detectForgetIntent(null).match).toBe(false);
  });
  test('no string -> no match', () => {
    expect(detectForgetIntent(123).match).toBe(false);
  });
  test('vacio -> no match', () => {
    expect(detectForgetIntent('').match).toBe(false);
  });

  test('MIIA olvidate eso -> match', () => {
    expect(detectForgetIntent('MIIA olvidate eso').match).toBe(true);
  });
  test('olvidate lo que dije -> match', () => {
    expect(detectForgetIntent('olvidate lo que te dije').match).toBe(true);
  });
  test('borra eso -> match', () => {
    expect(detectForgetIntent('borra eso por favor').match).toBe(true);
  });
  test('elimina lo que -> match', () => {
    expect(detectForgetIntent('elimina lo que dije sobre Ana').match).toBe(true);
  });
  test('no quiero que lo recuerdes -> match', () => {
    expect(detectForgetIntent('no quiero que lo recuerdes').match).toBe(true);
  });
  test('borra la informacion de Ana -> match', () => {
    expect(detectForgetIntent('borra la informacion de Ana').match).toBe(true);
  });
  test('me arrepiento de haber dicho -> match', () => {
    expect(detectForgetIntent('me arrepiento de haber dicho eso').match).toBe(true);
  });

  test('mensaje normal -> no match', () => {
    expect(detectForgetIntent('hola, como va todo').match).toBe(false);
  });
  test('case insensitive', () => {
    expect(detectForgetIntent('OLVIDATE ESO').match).toBe(true);
  });
});

// ── executeForget ─────────────────────────────────────────────────────────────

describe('executeForget', () => {
  test('uid null -> throw', async () => {
    await expect(executeForget(null, 'olvidate')).rejects.toThrow('uid_requerido');
  });
  test('ownerMessage null -> throw', async () => {
    await expect(executeForget('u1', null)).rejects.toThrow('ownerMessage_requerido');
  });

  test('embed retorna null -> noEmbedding=true', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => null);
    const { db } = makeDb({ episodes: [] });
    __setFirestoreForTests(db);
    const r = await executeForget('uid12345', 'olvidate eso');
    expect(r.noEmbedding).toBe(true);
    expect(r.episodiosBorrados).toBe(0);
  });

  test('sin episodios matching -> 0,0', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => [1, 0, 0]);
    const { db } = makeDb({ episodes: [] });
    __setFirestoreForTests(db);
    const r = await executeForget('uid12345', 'olvidate eso');
    expect(r.episodiosBorrados).toBe(0);
    expect(r.lessonsBorradas).toBe(0);
  });

  test('episodio con similarity baja -> excluido', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => [1, 0, 0]);
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1',
        contradicted: false, deletedByOwnerAt: null,
        vector: [0, 1, 0], // ortogonal -> 0
        lecciones: [{ id: 'l1', text: 'X' }],
      }],
    });
    __setFirestoreForTests(db);
    const r = await executeForget('uid12345', 'olvidate eso');
    expect(r.episodiosBorrados).toBe(0);
  });

  test('episodio sin vector -> excluido', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => [1, 0, 0]);
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1',
        contradicted: false, deletedByOwnerAt: null,
        vector: null,
        lecciones: [{ id: 'l1', text: 'X' }],
      }],
    });
    __setFirestoreForTests(db);
    const r = await executeForget('uid12345', 'olvidate');
    expect(r.episodiosBorrados).toBe(0);
  });

  test('episodios y lessons matching -> soft-delete completo', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => [1, 0, 0]);
    const { db, captures } = makeDb({
      episodes: [{
        episodeId: 'e1',
        contradicted: false, deletedByOwnerAt: null,
        vector: [1, 0, 0],
        lecciones: [
          { id: 'l1', text: 'X' },
          { id: 'l2', text: 'Y' },
        ],
      }],
    });
    __setFirestoreForTests(db);
    const r = await executeForget('uid12345', 'olvidate eso');
    expect(r.episodiosBorrados).toBe(1);
    expect(r.lessonsBorradas).toBe(2);
    expect(r.episodios).toContain('e1');
    // captures.sets debe tener al menos 2: 1 para deletedByOwnerAt + 1 para lecciones
    const epSet = captures.sets.find(function (s) { return s.payload.deletedByOwnerAt; });
    expect(epSet).toBeDefined();
    expect(epSet.payload.deletionReason).toBe('owner_explicit');
  });

  test('lessons ya borradas -> excluidas', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => [1, 0, 0]);
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1',
        contradicted: false, deletedByOwnerAt: null,
        vector: [1, 0, 0],
        lecciones: [
          { id: 'l1', text: 'X', deletedByOwnerAt: '2026-05-01' },
          { id: 'l2', text: 'Y' },
        ],
      }],
    });
    __setFirestoreForTests(db);
    const r = await executeForget('uid12345', 'olvidate eso');
    expect(r.lessonsBorradas).toBe(1);
  });

  test('episodio con lecciones no array -> sin lesson borrada', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => [1, 0, 0]);
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1',
        contradicted: false, deletedByOwnerAt: null,
        vector: [1, 0, 0],
        lecciones: null,
      }],
    });
    __setFirestoreForTests(db);
    const r = await executeForget('uid12345', 'olvidate');
    expect(r.episodiosBorrados).toBe(1);
    expect(r.lessonsBorradas).toBe(0);
  });

  test('snap.docs undefined -> usa [] (linea 83 fallback)', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => [1, 0, 0]);
    const customDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            where: jest.fn(function () { return this; }),
            get: jest.fn().mockResolvedValue({}),
            doc: jest.fn(() => ({
              get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
              set: jest.fn().mockResolvedValue({}),
            })),
          })),
        })),
      })),
    };
    __setFirestoreForTests(customDb);
    embeddingRetrieval.__setFirestoreForTests(customDb);
    const r = await executeForget('uid12345', 'olvidate');
    expect(r.episodiosBorrados).toBe(0);
  });

  test('doc.ref ausente + ep.episodeId ausente -> fallback (lineas 88, 92)', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => [1, 0, 0]);
    const setSpy = jest.fn().mockResolvedValue({});
    const reFetchSpy = jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({ lecciones: [{ id: 'l_alpha' }] }),
    });
    const docFn = jest.fn(() => ({
      get: reFetchSpy,
      set: setSpy,
    }));
    const customDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            where: jest.fn(function () { return this; }),
            get: jest.fn().mockResolvedValue({
              docs: [{
                id: 'fallback_doc_id',
                // sin .ref - probara el fallback _memoryCol(uid).doc(...)
                data: () => ({
                  // sin episodeId - probara fallback doc.id en linea 92
                  vector: [1, 0, 0],
                  lecciones: [{ id: 'l_alpha' }],
                }),
              }],
            }),
            doc: docFn,
          })),
        })),
      })),
    };
    __setFirestoreForTests(customDb);
    embeddingRetrieval.__setFirestoreForTests(customDb);
    const r = await executeForget('uid12345', 'olvidate eso');
    expect(r.episodiosBorrados).toBe(1);
    expect(r.lessonsBorradas).toBe(1);
  });

  test('lesson en episodio que ya no existe al re-fetch -> continue (linea 126)', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => [1, 0, 0]);
    // Simulamos: en la query inicial el episodio existe con lecciones.
    // Cuando re-fetcheamos por episodeId, el doc no existe (race condition).
    let firstFetch = true;
    const customDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            where: jest.fn(function () { return this; }),
            get: jest.fn().mockResolvedValue({
              docs: [{
                id: 'e_race',
                ref: { set: jest.fn().mockResolvedValue({}) },
                data: () => ({
                  episodeId: 'e_race',
                  vector: [1, 0, 0],
                  lecciones: [{ id: 'l1' }],
                }),
              }],
            }),
            doc: jest.fn(() => ({
              get: jest.fn().mockImplementation(() => {
                if (firstFetch) { firstFetch = false; return Promise.resolve({ exists: false, data: () => ({}) }); }
                return Promise.resolve({ exists: false, data: () => ({}) });
              }),
              set: jest.fn().mockResolvedValue({}),
            })),
          })),
        })),
      })),
    };
    __setFirestoreForTests(customDb);
    embeddingRetrieval.__setFirestoreForTests(customDb);
    const r = await executeForget('uid12345', 'olvidate');
    expect(r.episodiosBorrados).toBe(1);
    expect(r.lessonsBorradas).toBe(0); // re-fetch falla -> 0
  });

  test('lessons del re-fetch con lecciones no array -> 0 borradas (linea 128 fallback)', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => [1, 0, 0]);
    const customDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            where: jest.fn(function () { return this; }),
            get: jest.fn().mockResolvedValue({
              docs: [{
                id: 'e1',
                ref: { set: jest.fn().mockResolvedValue({}) },
                data: () => ({
                  episodeId: 'e1',
                  vector: [1, 0, 0],
                  lecciones: [{ id: 'l1' }],
                }),
              }],
            }),
            doc: jest.fn(() => ({
              get: jest.fn().mockResolvedValue({
                exists: true,
                data: () => ({ lecciones: 'no_array' }),
              }),
              set: jest.fn().mockResolvedValue({}),
            })),
          })),
        })),
      })),
    };
    __setFirestoreForTests(customDb);
    embeddingRetrieval.__setFirestoreForTests(customDb);
    const r = await executeForget('uid12345', 'olvidate');
    expect(r.episodiosBorrados).toBe(1);
    expect(r.lessonsBorradas).toBe(0);
  });

  test('lessons matched pero lessonIds no incluye ninguno -> modified=false (linea 137)', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => [1, 0, 0]);
    const customDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            where: jest.fn(function () { return this; }),
            get: jest.fn().mockResolvedValue({
              docs: [{
                id: 'e1',
                ref: { set: jest.fn().mockResolvedValue({}) },
                data: () => ({
                  episodeId: 'e1',
                  vector: [1, 0, 0],
                  lecciones: [{ id: 'l_old' }], // matched lesson id
                }),
              }],
            }),
            doc: jest.fn(() => ({
              get: jest.fn().mockResolvedValue({
                exists: true,
                data: () => ({ lecciones: [{ id: 'l_different' }] }), // no coincide id
              }),
              set: jest.fn().mockResolvedValue({}),
            })),
          })),
        })),
      })),
    };
    __setFirestoreForTests(customDb);
    embeddingRetrieval.__setFirestoreForTests(customDb);
    const r = await executeForget('uid12345', 'olvidate');
    // 1 episodio borrado, 0 lessons (no matched id)
    expect(r.episodiosBorrados).toBe(1);
    expect(r.lessonsBorradas).toBe(0);
  });

  test('multiples episodios -> top 5 ordenados por similarity', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => [1, 0, 0]);
    const eps = Array.from({ length: 7 }, function (_, i) {
      return {
        episodeId: 'e' + i,
        contradicted: false, deletedByOwnerAt: null,
        vector: [1 - i * 0.02, 0, 0],
        lecciones: [],
      };
    });
    const { db } = makeDb({ episodes: eps });
    __setFirestoreForTests(db);
    const r = await executeForget('uid12345', 'olvidate');
    expect(r.episodiosBorrados).toBe(5); // FORGET_MAX_EPISODES
  });
});

// ── buildForgetInjection ──────────────────────────────────────────────────────

describe('buildForgetInjection', () => {
  test('result null -> empty', () => {
    expect(buildForgetInjection(null)).toBe('');
  });

  test('result con 0 borrados -> FORGET-NOOP', () => {
    const r = buildForgetInjection({ episodiosBorrados: 0, lessonsBorradas: 0 });
    expect(r).toContain('FORGET-NOOP');
    expect(r).toContain('no estoy segura');
  });

  test('result con episodios borrados -> FORGET-DONE', () => {
    const r = buildForgetInjection({ episodiosBorrados: 3, lessonsBorradas: 2 });
    expect(r).toContain('FORGET-DONE');
    expect(r).toContain('3 episodios');
    expect(r).toContain('2 lessons');
  });

  test('result con solo lessons borradas -> FORGET-DONE', () => {
    const r = buildForgetInjection({ episodiosBorrados: 0, lessonsBorradas: 1 });
    expect(r).toContain('FORGET-DONE');
    expect(r).toContain('1 lessons');
  });
});

// ── Constantes ────────────────────────────────────────────────────────────────

describe('Constantes', () => {
  test('FORGET_PATTERNS array de 4', () => {
    expect(FORGET_PATTERNS).toHaveLength(4);
  });
  test('FORGET_THRESHOLD = 0.75', () => {
    expect(FORGET_THRESHOLD).toBe(0.75);
  });
});
