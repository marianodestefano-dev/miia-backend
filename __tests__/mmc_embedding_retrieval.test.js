'use strict';

const er = require('../core/mmc/embedding_retrieval');
const {
  cosineSimilarity,
  embed,
  retrieveTopLessons,
  recordLessonCitation,
  COOLDOWN_MS,
  EMBEDDING_DIMS,
  __setFirestoreForTests,
  __setEmbedForTests,
} = er;

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeDb(opts) {
  const o = opts || {};
  const episodes = o.episodes || []; // array de docs episodios
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
        if (found && payload.lecciones) found.lecciones = payload.lecciones;
        return Promise.resolve({});
      }),
    };
  });

  // collection with where chains
  function makeQuery(filtered) {
    return {
      where: jest.fn(function () { return makeQuery(filtered); }),
      get: jest.fn().mockResolvedValue({
        docs: filtered.map(function (e) {
          return {
            id: e.episodeId,
            data: () => e,
          };
        }),
      }),
    };
  }

  // Filter episodes by contradicted=false + deletedByOwnerAt=null (segun la query del codigo)
  const filteredEps = episodes.filter(function (e) {
    return e.contradicted === false && e.deletedByOwnerAt === null;
  });

  const memoryCol = {
    doc: episodeDocFn,
    where: jest.fn(function () { return makeQuery(filteredEps); }),
  };

  const subCollFn = jest.fn(function () { return memoryCol; });
  const ownerDocFn = jest.fn(() => ({ collection: subCollFn }));
  const db = { collection: jest.fn(() => ({ doc: ownerDocFn })) };
  return { db, captures, memoryCol };
}

beforeEach(() => {
  __setFirestoreForTests(null);
  __setEmbedForTests(null);
});

// ── cosineSimilarity ──────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  test('vectores iguales -> 1', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
  });
  test('vectores ortogonales -> 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
  test('vectores opuestos -> -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });
  test('no arrays -> 0', () => {
    expect(cosineSimilarity(null, [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], 'string')).toBe(0);
  });
  test('largos distintos -> 0', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
  test('array vacio -> 0', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
  test('vector cero -> 0 (evita NaN)', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
  test('elementos no number (a) -> tratados como 0', () => {
    // a=[1,0,1] tras coercion, b=[1,2,1]. dot=2, |a|=sqrt(2), |b|=sqrt(6)
    const r = cosineSimilarity([1, 'foo', 1], [1, 2, 1]);
    expect(r).toBeCloseTo(2 / (Math.sqrt(2) * Math.sqrt(6)), 5);
  });
  test('elementos no number (b) -> tratados como 0 (rama linea 72)', () => {
    const r = cosineSimilarity([1, 2, 1], [1, 'bar', 1]);
    expect(r).toBeCloseTo(2 / (Math.sqrt(6) * Math.sqrt(2)), 5);
  });
  test('vectores similares -> entre 0 y 1', () => {
    const r = cosineSimilarity([0.9, 0.1, 0], [1, 0, 0]);
    expect(r).toBeGreaterThan(0.9);
    expect(r).toBeLessThan(1);
  });
});

// ── embed ─────────────────────────────────────────────────────────────────────

describe('embed', () => {
  test('text null -> null', async () => {
    expect(await embed(null)).toBeNull();
  });
  test('text vacio -> null', async () => {
    expect(await embed('   ')).toBeNull();
  });
  test('text no string -> null', async () => {
    expect(await embed(123)).toBeNull();
  });

  test('embed OK -> retorna vector del mock', async () => {
    __setEmbedForTests(async () => [0.1, 0.2, 0.3]);
    const r = await embed('hola');
    expect(r).toEqual([0.1, 0.2, 0.3]);
  });

  test('embed throw -> retorna null (no rompe el flow)', async () => {
    __setEmbedForTests(async () => { throw new Error('api down'); });
    const r = await embed('hola');
    expect(r).toBeNull();
  });
});

// ── retrieveTopLessons ────────────────────────────────────────────────────────

describe('retrieveTopLessons', () => {
  test('uid null -> throw', async () => {
    await expect(retrieveTopLessons(null, 'q')).rejects.toThrow('uid_requerido');
  });

  test('embed retorna null -> []', async () => {
    __setEmbedForTests(async () => null);
    const { db } = makeDb({ episodes: [] });
    __setFirestoreForTests(db);
    const r = await retrieveTopLessons('uid12345', 'query text');
    expect(r).toEqual([]);
  });

  test('sin episodios -> []', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    const { db } = makeDb({ episodes: [] });
    __setFirestoreForTests(db);
    const r = await retrieveTopLessons('uid12345', 'q');
    expect(r).toEqual([]);
  });

  test('episodios filtran similarity < threshold', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1', startedAt: Date.now(),
        contradicted: false, deletedByOwnerAt: null,
        vector: [0, 1, 0], // ortogonal -> similarity = 0
        lecciones: [{ id: 'l1', text: 'x', confidence: 'high', contradicted: false, deletedByOwnerAt: null, lastCitedAt: null }],
      }],
    });
    __setFirestoreForTests(db);
    const r = await retrieveTopLessons('uid12345', 'q', { threshold: 0.5 });
    expect(r).toEqual([]);
  });

  test('episodios sin vector -> excluidos', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1', startedAt: Date.now(),
        contradicted: false, deletedByOwnerAt: null,
        vector: null,
        lecciones: [{ id: 'l1', text: 'x', confidence: 'high', contradicted: false, deletedByOwnerAt: null, lastCitedAt: null }],
      }],
    });
    __setFirestoreForTests(db);
    const r = await retrieveTopLessons('uid12345', 'q', { threshold: 0.5 });
    expect(r).toEqual([]);
  });

  test('episodios sin array lecciones -> excluidos', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1', startedAt: Date.now(),
        contradicted: false, deletedByOwnerAt: null,
        vector: [1, 0, 0],
        lecciones: 'no_array',
      }],
    });
    __setFirestoreForTests(db);
    const r = await retrieveTopLessons('uid12345', 'q', { threshold: 0.5 });
    expect(r).toEqual([]);
  });

  test('lesson confidence=low -> excluida', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1', startedAt: Date.now(),
        contradicted: false, deletedByOwnerAt: null,
        vector: [1, 0, 0],
        lecciones: [
          { id: 'l1', text: 'x', confidence: 'low', contradicted: false, deletedByOwnerAt: null, lastCitedAt: null },
        ],
      }],
    });
    __setFirestoreForTests(db);
    const r = await retrieveTopLessons('uid12345', 'q', { threshold: 0.5 });
    expect(r).toEqual([]);
  });

  test('lesson contradicted -> excluida', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1', startedAt: Date.now(),
        contradicted: false, deletedByOwnerAt: null,
        vector: [1, 0, 0],
        lecciones: [
          { id: 'l1', text: 'x', confidence: 'high', contradicted: true, deletedByOwnerAt: null, lastCitedAt: null },
        ],
      }],
    });
    __setFirestoreForTests(db);
    const r = await retrieveTopLessons('uid12345', 'q', { threshold: 0.5 });
    expect(r).toEqual([]);
  });

  test('lesson deletedByOwnerAt -> excluida', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1', startedAt: Date.now(),
        contradicted: false, deletedByOwnerAt: null,
        vector: [1, 0, 0],
        lecciones: [
          { id: 'l1', text: 'x', confidence: 'high', contradicted: false, deletedByOwnerAt: '2026-05-10', lastCitedAt: null },
        ],
      }],
    });
    __setFirestoreForTests(db);
    const r = await retrieveTopLessons('uid12345', 'q', { threshold: 0.5 });
    expect(r).toEqual([]);
  });

  test('lesson en cooldown 72h -> excluida', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    const recentCite = new Date(Date.now() - 1000 * 60 * 60).toISOString(); // 1h
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1', startedAt: Date.now(),
        contradicted: false, deletedByOwnerAt: null,
        vector: [1, 0, 0],
        lecciones: [
          { id: 'l1', text: 'x', confidence: 'high', contradicted: false, deletedByOwnerAt: null, lastCitedAt: recentCite },
        ],
      }],
    });
    __setFirestoreForTests(db);
    const r = await retrieveTopLessons('uid12345', 'q', { threshold: 0.5 });
    expect(r).toEqual([]);
  });

  test('lesson con lastCitedAt > 72h atras -> incluida', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    const oldCite = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(); // 100h
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1', startedAt: Date.now() - 10000,
        contradicted: false, deletedByOwnerAt: null,
        vector: [1, 0, 0],
        lecciones: [
          { id: 'l1', text: 'Mariano prefiere X', confidence: 'high', contradicted: false, deletedByOwnerAt: null, lastCitedAt: oldCite },
        ],
      }],
    });
    __setFirestoreForTests(db);
    const r = await retrieveTopLessons('uid12345', 'q', { threshold: 0.5 });
    expect(r).toHaveLength(1);
    expect(r[0].lesson.text).toBe('Mariano prefiere X');
  });

  test('top K por defecto = 3', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    const eps = Array.from({ length: 5 }, function (_, i) {
      return {
        episodeId: 'e' + i,
        startedAt: Date.now(),
        contradicted: false, deletedByOwnerAt: null,
        vector: [1 - i * 0.01, 0, 0],
        lecciones: [{ id: 'l' + i, text: 't' + i, confidence: 'high', contradicted: false, deletedByOwnerAt: null, lastCitedAt: null }],
      };
    });
    const { db } = makeDb({ episodes: eps });
    __setFirestoreForTests(db);
    const r = await retrieveTopLessons('uid12345', 'q', { threshold: 0.5 });
    expect(r).toHaveLength(3);
  });

  test('opts.topK custom', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    const eps = Array.from({ length: 5 }, function (_, i) {
      return {
        episodeId: 'e' + i,
        startedAt: Date.now(),
        contradicted: false, deletedByOwnerAt: null,
        vector: [1 - i * 0.01, 0, 0],
        lecciones: [{ id: 'l' + i, text: 't' + i, confidence: 'high', contradicted: false, deletedByOwnerAt: null, lastCitedAt: null }],
      };
    });
    const { db } = makeDb({ episodes: eps });
    __setFirestoreForTests(db);
    const r = await retrieveTopLessons('uid12345', 'q', { threshold: 0.5, topK: 2 });
    expect(r).toHaveLength(2);
  });

  test('episodio sin startedAt -> fecha=null', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1',
        contradicted: false, deletedByOwnerAt: null,
        vector: [1, 0, 0],
        lecciones: [{ id: 'l1', text: 't', confidence: 'high', contradicted: false, deletedByOwnerAt: null, lastCitedAt: null }],
      }],
    });
    __setFirestoreForTests(db);
    const r = await retrieveTopLessons('uid12345', 'q', { threshold: 0.5 });
    expect(r[0].fecha).toBeNull();
  });

  test('episodio sin episodeId -> usa doc.id', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    // makeDb usa episodeId='e1' como doc.id default si no se setea explicito
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1',
        startedAt: Date.now(),
        contradicted: false, deletedByOwnerAt: null,
        vector: [1, 0, 0],
        lecciones: [{ id: 'l1', text: 't', confidence: 'high', contradicted: false, deletedByOwnerAt: null, lastCitedAt: null }],
      }],
    });
    __setFirestoreForTests(db);
    const r = await retrieveTopLessons('uid12345', 'q', { threshold: 0.5 });
    expect(r[0].episodeId).toBe('e1');
  });

  test('snap.docs undefined -> [] (linea 124 fallback)', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    // Mock manual sin docs
    const customDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            where: jest.fn(function () { return this; }),
            get: jest.fn().mockResolvedValue({}),
          })),
        })),
      })),
    };
    __setFirestoreForTests(customDb);
    const r = await retrieveTopLessons('uid12345', 'q', { threshold: 0.5 });
    expect(r).toEqual([]);
  });

  test('episodio sin episodeId -> usa doc.id (linea 140 fallback)', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    const customDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            where: jest.fn(function () { return this; }),
            get: jest.fn().mockResolvedValue({
              docs: [{
                id: 'doc_id_fallback',
                data: () => ({
                  // sin episodeId
                  startedAt: Date.now(),
                  vector: [1, 0, 0],
                  lecciones: [{ id: 'l1', text: 't', confidence: 'high', contradicted: false, deletedByOwnerAt: null, lastCitedAt: null }],
                }),
              }],
            }),
          })),
        })),
      })),
    };
    __setFirestoreForTests(customDb);
    const r = await retrieveTopLessons('uid12345', 'q', { threshold: 0.5 });
    expect(r).toHaveLength(1);
    expect(r[0].episodeId).toBe('doc_id_fallback');
  });

  test('threshold default 0.82 cuando no se provee', async () => {
    __setEmbedForTests(async () => [1, 0, 0]);
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1', startedAt: Date.now(),
        contradicted: false, deletedByOwnerAt: null,
        vector: [0.5, 0.5, 0], // similarity con [1,0,0] = 0.707 < 0.82
        lecciones: [{ id: 'l1', text: 't', confidence: 'high', contradicted: false, deletedByOwnerAt: null, lastCitedAt: null }],
      }],
    });
    __setFirestoreForTests(db);
    const r = await retrieveTopLessons('uid12345', 'q'); // sin opts
    expect(r).toEqual([]);
  });
});

// ── recordLessonCitation ──────────────────────────────────────────────────────

describe('recordLessonCitation', () => {
  test('uid null -> throw', async () => {
    await expect(recordLessonCitation(null, 'e1', 'l1')).rejects.toThrow('parametros_requeridos');
  });
  test('episodeId null -> throw', async () => {
    await expect(recordLessonCitation('u1', null, 'l1')).rejects.toThrow('parametros_requeridos');
  });
  test('lessonId null -> throw', async () => {
    await expect(recordLessonCitation('u1', 'e1', null)).rejects.toThrow('parametros_requeridos');
  });

  test('episodio no existe -> throw', async () => {
    const { db } = makeDb({ episodes: [] });
    __setFirestoreForTests(db);
    await expect(recordLessonCitation('u1', 'e_missing', 'l1')).rejects.toThrow('episodio_no_encontrado');
  });

  test('lesson no existe -> throw', async () => {
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1',
        contradicted: false, deletedByOwnerAt: null,
        lecciones: [{ id: 'l_otra', text: 'X', confidence: 'high' }],
      }],
    });
    __setFirestoreForTests(db);
    await expect(recordLessonCitation('u1', 'e1', 'l_target')).rejects.toThrow('lesson_no_encontrada');
  });

  test('OK - actualiza citation primera vez', async () => {
    const { db, captures } = makeDb({
      episodes: [{
        episodeId: 'e1',
        contradicted: false, deletedByOwnerAt: null,
        lecciones: [{ id: 'l1', text: 'X', confidence: 'high' }],
      }],
    });
    __setFirestoreForTests(db);
    const r = await recordLessonCitation('u1', 'e1', 'l1');
    expect(r.ok).toBe(true);
    const lesson = captures.sets[0].payload.lecciones[0];
    expect(lesson.citationCount).toBe(1);
    expect(lesson.citationEpisodes).toEqual(['e1']);
    expect(lesson.lastCitedAt).toBeDefined();
  });

  test('OK - acumula citation N veces, no duplica episode en array', async () => {
    const { db, captures } = makeDb({
      episodes: [{
        episodeId: 'e1',
        contradicted: false, deletedByOwnerAt: null,
        lecciones: [{
          id: 'l1', text: 'X', confidence: 'high',
          citationCount: 2, citationEpisodes: ['e1', 'e2'],
        }],
      }],
    });
    __setFirestoreForTests(db);
    await recordLessonCitation('u1', 'e1', 'l1');
    const lesson = captures.sets[0].payload.lecciones[0];
    expect(lesson.citationCount).toBe(3);
    expect(lesson.citationEpisodes).toEqual(['e1', 'e2']); // no duplica
  });

  test('OK - lesson sin citationEpisodes inicial -> []', async () => {
    const { db, captures } = makeDb({
      episodes: [{
        episodeId: 'e1',
        contradicted: false, deletedByOwnerAt: null,
        lecciones: [{ id: 'l1', text: 'X', confidence: 'high', citationCount: 1 }],
      }],
    });
    __setFirestoreForTests(db);
    await recordLessonCitation('u1', 'e1', 'l1');
    const lesson = captures.sets[0].payload.lecciones[0];
    expect(lesson.citationEpisodes).toEqual(['e1']);
  });

  test('OK - episodio con lecciones no array -> usa [] (no rompe), pero lesson no se encuentra', async () => {
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1',
        contradicted: false, deletedByOwnerAt: null,
        lecciones: null, // no array
      }],
    });
    __setFirestoreForTests(db);
    await expect(recordLessonCitation('u1', 'e1', 'l1')).rejects.toThrow('lesson_no_encontrada');
  });
});

// ── Exports ───────────────────────────────────────────────────────────────────

describe('Exports', () => {
  test('COOLDOWN_MS = 72h', () => {
    expect(COOLDOWN_MS).toBe(72 * 60 * 60 * 1000);
  });
  test('EMBEDDING_DIMS = 768', () => {
    expect(EMBEDDING_DIMS).toBe(768);
  });
});
