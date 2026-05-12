'use strict';

const {
  getMyMmcData,
  exportMmc,
  deleteMmcCategory,
  VALID_CATEGORIES,
  __setFirestoreForTests,
} = require('../core/privacy/mmc_view');

// ── Mock ──────────────────────────────────────────────────────────────────────

function makeDb(opts) {
  const o = opts || {};
  const episodes = o.episodes || [];
  const brainGraduated = o.brainGraduated;
  const baselineData = o.baseline;
  const captures = { episodeSets: [], brainSets: [], baselineSets: [] };

  function refForEp(ep) {
    return {
      set: jest.fn((payload, merge) => {
        captures.episodeSets.push({ episodeId: ep.episodeId, payload, merge });
        if (payload.lecciones) ep.lecciones = payload.lecciones;
        if (payload.deletedByOwnerAt !== undefined) ep.deletedByOwnerAt = payload.deletedByOwnerAt;
        return Promise.resolve({});
      }),
    };
  }

  const memoryColGet = jest.fn().mockResolvedValue({
    docs: episodes.map(function (ep) {
      return {
        id: ep.episodeId,
        ref: refForEp(ep),
        data: () => ep,
      };
    }),
  });

  const memoryCol = { get: memoryColGet };

  const brainDocFn = jest.fn(() => ({
    get: jest.fn().mockResolvedValue({
      exists: brainGraduated !== undefined,
      data: () => brainGraduated || {},
    }),
    set: jest.fn((payload, merge) => {
      captures.brainSets.push({ payload, merge });
      return Promise.resolve({});
    }),
  }));

  const baselineDocFn = jest.fn(() => ({
    get: jest.fn().mockResolvedValue({
      exists: baselineData !== undefined,
      data: () => baselineData || {},
    }),
    set: jest.fn((payload, merge) => {
      captures.baselineSets.push({ payload, merge });
      return Promise.resolve({});
    }),
  }));

  const subCollFn = jest.fn((name) => {
    if (name === 'brain') return { doc: brainDocFn };
    if (name === 'miia_baseline') return { doc: baselineDocFn };
    return memoryCol;
  });

  const ownerDocFn = jest.fn(() => ({ collection: subCollFn }));
  const db = { collection: jest.fn(() => ({ doc: ownerDocFn })) };
  return { db, captures };
}

beforeEach(() => {
  __setFirestoreForTests(null);
});

// ── getMyMmcData ──────────────────────────────────────────────────────────────

describe('getMyMmcData', () => {
  test('uid null -> throw', async () => {
    await expect(getMyMmcData(null)).rejects.toThrow('uid_requerido');
  });

  test('todo vacio -> resumen con 0s', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await getMyMmcData('uid12345');
    expect(r.summary.totalEpisodios).toBe(0);
    expect(r.summary.totalLessons).toBe(0);
    expect(r.summary.totalGraduadas).toBe(0);
    expect(r.summary.bootstrapComplete).toBe(false);
    expect(r.summary.tonadaRegional).toBe('neutro');
    expect(r.episodios).toEqual([]);
    expect(r.graduadas).toEqual([]);
    expect(r.baseline).toBeNull();
  });

  test('con episodios + lecciones', async () => {
    const { db } = makeDb({
      episodes: [
        {
          episodeId: 'e1',
          startedAt: 1700000000000,
          topic: 'topic A',
          summary: 'summary A',
          tono: 'positivo',
          tonadaDetectada: 'argentina',
          lecciones: [
            { id: 'l1', text: 'X', contradicted: false },
            { id: 'l2', text: 'Y', contradicted: true },
            { id: 'l3', text: 'Z', deletedByOwnerAt: 'now' },
          ],
        },
      ],
    });
    __setFirestoreForTests(db);
    const r = await getMyMmcData('uid12345');
    expect(r.summary.totalEpisodios).toBe(1);
    expect(r.summary.totalLessons).toBe(3);
    expect(r.summary.totalContradicted).toBe(1);
    expect(r.summary.totalDeletedByOwner).toBe(1);
    expect(r.episodios[0].lessonsCount).toBe(3);
    expect(r.episodios[0].topic).toBe('topic A');
  });

  test('episodio sin lecciones array -> 0 lessons', async () => {
    const { db } = makeDb({
      episodes: [{ episodeId: 'e1', lecciones: null }],
    });
    __setFirestoreForTests(db);
    const r = await getMyMmcData('uid12345');
    expect(r.summary.totalLessons).toBe(0);
    expect(r.episodios[0].lessonsCount).toBe(0);
  });

  test('episodio con minimo defaults -> defaults null', async () => {
    const { db } = makeDb({
      episodes: [{ episodeId: 'e1', lecciones: [] }],
    });
    __setFirestoreForTests(db);
    const r = await getMyMmcData('uid12345');
    expect(r.episodios[0].startedAt).toBeNull();
    expect(r.episodios[0].endedAt).toBeNull();
    expect(r.episodios[0].topic).toBeNull();
    expect(r.episodios[0].summary).toBeNull();
    expect(r.episodios[0].tono).toBeNull();
    expect(r.episodios[0].tonadaDetectada).toBeNull();
    expect(r.episodios[0].status).toBe('open');
    expect(r.episodios[0].deletedByOwnerAt).toBeNull();
  });

  test('episodio sin episodeId -> usa doc.id fallback', async () => {
    const { db } = makeDb({
      episodes: [{ lecciones: [] }],
    });
    __setFirestoreForTests(db);
    const r = await getMyMmcData('uid12345');
    expect(r.episodios[0].episodeId).toBeUndefined();
  });

  test('con graduadas + baseline', async () => {
    const { db } = makeDb({
      brainGraduated: { items: ['[MEMORIA] X', '[MEMORIA] Y'] },
      baseline: {
        idiomaBase: 'es',
        tonadaRegional: 'colombia',
        tonadaConfidence: 'medium',
        adaptacionActiva: true,
        bootstrapComplete: true,
        mensajesAnalizados: 75,
        palabrasConfianza: ['parcero', 'bacano'],
      },
    });
    __setFirestoreForTests(db);
    const r = await getMyMmcData('uid12345');
    expect(r.summary.totalGraduadas).toBe(2);
    expect(r.summary.bootstrapComplete).toBe(true);
    expect(r.summary.tonadaRegional).toBe('colombia');
    expect(r.summary.adaptacionActiva).toBe(true);
    expect(r.baseline.mensajesAnalizados).toBe(75);
    expect(r.baseline.palabrasConfianza).toEqual(['parcero', 'bacano']);
  });

  test('baseline existe pero sin items -> defaults', async () => {
    const { db } = makeDb({
      baseline: {},
    });
    __setFirestoreForTests(db);
    const r = await getMyMmcData('uid12345');
    expect(r.baseline.idiomaBase).toBe('es');
    expect(r.baseline.tonadaRegional).toBe('neutro');
    expect(r.baseline.adaptacionActiva).toBe(false);
    expect(r.baseline.bootstrapComplete).toBe(false);
    expect(r.baseline.mensajesAnalizados).toBe(0);
    expect(r.baseline.palabrasConfianza).toEqual([]);
  });

  test('brain.items no array -> []', async () => {
    const { db } = makeDb({ brainGraduated: {} });
    __setFirestoreForTests(db);
    const r = await getMyMmcData('uid12345');
    expect(r.graduadas).toEqual([]);
  });
});

// ── exportMmc ─────────────────────────────────────────────────────────────────

describe('exportMmc', () => {
  test('uid null -> throw', async () => {
    await expect(exportMmc(null)).rejects.toThrow('uid_requerido');
  });

  test('export completo', async () => {
    const { db } = makeDb({
      episodes: [{ episodeId: 'e1', topic: 't' }],
      brainGraduated: { items: ['g1', 'g2'] },
      baseline: { idiomaBase: 'es' },
    });
    __setFirestoreForTests(db);
    const r = await exportMmc('uid12345');
    expect(r.uid).toBe('uid12345');
    expect(r.exportFormat).toBe('gdpr_v1');
    expect(r.episodios).toHaveLength(1);
    expect(r.graduadas).toEqual(['g1', 'g2']);
    expect(r.baseline.idiomaBase).toBe('es');
    expect(r.disclaimer).toContain('memoria episodica');
    expect(r.disclaimer).toContain('/api/privacy');
    expect(r.exportFormat).toBe('gdpr_v1');
  });

  test('export sin nada -> arrays vacios + baseline null', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await exportMmc('uid12345');
    expect(r.episodios).toEqual([]);
    expect(r.graduadas).toEqual([]);
    expect(r.baseline).toBeNull();
  });

  test('episodio sin episodeId -> usa doc.id', async () => {
    const { db } = makeDb({
      episodes: [{ topic: 'X' }],
    });
    __setFirestoreForTests(db);
    const r = await exportMmc('uid12345');
    expect(r.episodios[0].episodeId).toBeUndefined();
  });

  test('brain con items array -> incluidos', async () => {
    const { db } = makeDb({ brainGraduated: { items: ['x'] } });
    __setFirestoreForTests(db);
    const r = await exportMmc('uid12345');
    expect(r.graduadas).toEqual(['x']);
  });

  test('brain sin items -> []', async () => {
    const { db } = makeDb({ brainGraduated: {} });
    __setFirestoreForTests(db);
    const r = await exportMmc('uid12345');
    expect(r.graduadas).toEqual([]);
  });
});

// ── deleteMmcCategory ─────────────────────────────────────────────────────────

describe('deleteMmcCategory', () => {
  test('uid null -> throw', async () => {
    await expect(deleteMmcCategory(null, 'all')).rejects.toThrow('uid_requerido');
  });
  test('category invalida -> throw', async () => {
    await expect(deleteMmcCategory('u1', 'invalida')).rejects.toThrow('category_invalido');
  });

  test('episodios -> soft-delete todos', async () => {
    const { db, captures } = makeDb({
      episodes: [
        { episodeId: 'e1', lecciones: [] },
        { episodeId: 'e2', lecciones: [] },
      ],
    });
    __setFirestoreForTests(db);
    const r = await deleteMmcCategory('uid12345', 'episodios');
    expect(r.deleted).toBe(2);
    expect(captures.episodeSets).toHaveLength(2);
    expect(captures.episodeSets[0].payload.deletedByOwnerAt).toBeDefined();
    expect(captures.episodeSets[0].payload.deletionReason).toBe('privacy_dashboard_category_episodios');
  });

  test('lessons -> soft-delete lessons within episodios', async () => {
    const { db, captures } = makeDb({
      episodes: [{
        episodeId: 'e1',
        lecciones: [
          { id: 'l1', text: 'X' },
          { id: 'l2', text: 'Y', deletedByOwnerAt: 'old' }, // ya borrada
        ],
      }],
    });
    __setFirestoreForTests(db);
    const r = await deleteMmcCategory('uid12345', 'lessons');
    expect(r.deleted).toBe(1); // solo l1
    const epSet = captures.episodeSets.find(function (s) { return s.episodeId === 'e1'; });
    expect(epSet.payload.lecciones[0].deletedByOwnerAt).toBeDefined();
  });

  test('lessons en episodio sin lecciones array -> skip', async () => {
    const { db, captures } = makeDb({
      episodes: [{ episodeId: 'e1', lecciones: null }],
    });
    __setFirestoreForTests(db);
    const r = await deleteMmcCategory('uid12345', 'lessons');
    expect(r.deleted).toBe(0);
    expect(captures.episodeSets).toEqual([]);
  });

  test('graduadas -> brain items = []', async () => {
    const { db, captures } = makeDb({
      brainGraduated: { items: ['x', 'y'] },
    });
    __setFirestoreForTests(db);
    const r = await deleteMmcCategory('uid12345', 'graduadas');
    expect(r.deleted).toBe(0); // graduadas no incrementa deleted counter
    expect(captures.brainSets[0].payload.items).toEqual([]);
    expect(captures.brainSets[0].payload.clearedByOwnerAt).toBeDefined();
  });

  test('baseline -> reset a defaults', async () => {
    const { db, captures } = makeDb({
      baseline: { bootstrapComplete: true, mensajesAnalizados: 100 },
    });
    __setFirestoreForTests(db);
    const r = await deleteMmcCategory('uid12345', 'baseline');
    expect(captures.baselineSets[0].payload.bootstrapComplete).toBe(false);
    expect(captures.baselineSets[0].payload.mensajesAnalizados).toBe(0);
    expect(captures.baselineSets[0].payload.resetByOwnerAt).toBeDefined();
  });

  test('preferencias -> reset campos conductuales', async () => {
    const { db, captures } = makeDb({
      baseline: { intensidadLenguaje: 9, palabrasConfianza: ['posta'] },
    });
    __setFirestoreForTests(db);
    await deleteMmcCategory('uid12345', 'preferencias');
    expect(captures.baselineSets[0].payload.intensidadLenguaje).toBe(5);
    expect(captures.baselineSets[0].payload.palabrasConfianza).toEqual([]);
    expect(captures.baselineSets[0].payload.preferenciasResetByOwnerAt).toBeDefined();
  });

  test('tonada -> reset tonada a neutro', async () => {
    const { db, captures } = makeDb({
      baseline: { tonadaRegional: 'argentina', adaptacionActiva: true },
    });
    __setFirestoreForTests(db);
    await deleteMmcCategory('uid12345', 'tonada');
    expect(captures.baselineSets[0].payload.tonadaRegional).toBe('neutro');
    expect(captures.baselineSets[0].payload.adaptacionActiva).toBe(false);
  });

  test('all -> ejecuta episodios + graduadas + baseline', async () => {
    const { db, captures } = makeDb({
      episodes: [{ episodeId: 'e1', lecciones: [] }],
      brainGraduated: { items: ['x'] },
      baseline: { bootstrapComplete: true },
    });
    __setFirestoreForTests(db);
    const r = await deleteMmcCategory('uid12345', 'all');
    expect(r.deleted).toBe(1); // 1 episodio borrado
    expect(captures.brainSets).toHaveLength(1);
    expect(captures.baselineSets).toHaveLength(1);
  });
});

// ── Exports ───────────────────────────────────────────────────────────────────

describe('VALID_CATEGORIES', () => {
  test('contiene 7 categorias', () => {
    expect(VALID_CATEGORIES).toHaveLength(7);
    expect(VALID_CATEGORIES).toContain('all');
    expect(VALID_CATEGORIES).toContain('episodios');
  });
});
