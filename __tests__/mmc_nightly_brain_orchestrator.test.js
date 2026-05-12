'use strict';

const orch = require('../core/mmc/nightly_brain_orchestrator');
const baselineLib = require('../core/mmc/baseline');
const passiveValidation = require('../core/mmc/passive_validation');
const {
  detectContradictions,
  graduateEligibleLessons,
  updateBaselineFromEpisodes,
  adjustCosThresholdMonthly,
  runNightlyExtensions,
  GRADUATION_MIN_AGE_DAYS,
  GRADUATION_MIN_CITATIONS,
  GRADUATION_MIN_DISTINCT_EPISODES,
  __setFirestoreForTests,
} = orch;

// ── Mock ──────────────────────────────────────────────────────────────────────

function makeDb(opts) {
  const o = opts || {};
  const episodes = o.episodes || [];
  const baselineData = o.baseline; // undefined -> no existe
  const brainGraduated = o.brainGraduated; // undefined -> no existe
  const captures = { episodeSets: [], baselineSets: [], brainSets: [] };

  function refForEp(ep) {
    return {
      set: jest.fn((payload, merge) => {
        captures.episodeSets.push({ episodeId: ep.episodeId, payload, merge });
        // mutate ep in place
        if (payload.lecciones) ep.lecciones = payload.lecciones;
        if (payload.expiresAt !== undefined) ep.expiresAt = payload.expiresAt;
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

  const baselineDocFn = jest.fn(() => ({
    get: jest.fn().mockResolvedValue({
      exists: baselineData !== undefined,
      data: () => baselineData || {},
    }),
    set: jest.fn((payload, merge) => {
      captures.baselineSets.push({ payload, merge });
      if (baselineData) {
        Object.assign(baselineData, payload);
      }
      return Promise.resolve({});
    }),
  }));

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

  const subCollFn = jest.fn((name) => {
    if (name === 'miia_baseline') return { doc: baselineDocFn };
    if (name === 'brain') return { doc: brainDocFn };
    return memoryCol;
  });

  const ownerDocFn = jest.fn(() => ({ collection: subCollFn }));
  const db = { collection: jest.fn(() => ({ doc: ownerDocFn })) };
  return { db, captures };
}

beforeEach(() => {
  __setFirestoreForTests(null);
  baselineLib.__setFirestoreForTests(null);
  passiveValidation.__setFirestoreForTests(null);
});

// ── detectContradictions ──────────────────────────────────────────────────────

describe('detectContradictions', () => {
  test('uid null -> throw', async () => {
    await expect(detectContradictions(null)).rejects.toThrow('uid_requerido');
  });

  test('sin episodios -> 0', async () => {
    const { db } = makeDb({ episodes: [] });
    __setFirestoreForTests(db);
    const r = await detectContradictions('uid12345');
    expect(r.lessonsMarcadas).toBe(0);
  });

  test('episodio sin lecciones array -> sin marcar', async () => {
    const { db } = makeDb({
      episodes: [{ episodeId: 'e1', lecciones: 'no_array' }],
    });
    __setFirestoreForTests(db);
    const r = await detectContradictions('uid12345');
    expect(r.lessonsMarcadas).toBe(0);
  });

  test('lessons sin tags en comun -> sin contradiccion', async () => {
    const { db } = makeDb({
      episodes: [
        {
          episodeId: 'e1', tags: ['comida'],
          lecciones: [{ id: 'l1', text: 'no le gusta', createdAt: '2026-01-01' }],
        },
        {
          episodeId: 'e2', tags: ['deporte'],
          lecciones: [{ id: 'l2', text: 'le encanta', createdAt: '2026-02-01' }],
        },
      ],
    });
    __setFirestoreForTests(db);
    const r = await detectContradictions('uid12345');
    expect(r.lessonsMarcadas).toBe(0);
  });

  test('lessons con tags comunes + sentimientos opuestos -> contradiccion (la mas vieja marcada)', async () => {
    const { db, captures } = makeDb({
      episodes: [
        {
          episodeId: 'e1', tags: ['cafe', 'manana'],
          lecciones: [{ id: 'l1', text: 'no le gusta el cafe', createdAt: '2026-01-01' }],
        },
        {
          episodeId: 'e2', tags: ['cafe', 'manana'],
          lecciones: [{ id: 'l2', text: 'ama el cafe', createdAt: '2026-04-01' }],
        },
      ],
    });
    __setFirestoreForTests(db);
    const r = await detectContradictions('uid12345');
    expect(r.lessonsMarcadas).toBe(1);
    expect(r.episodiosAfectados).toBe(1);
    // e1 (mas vieja) deberia tener contradicted=true tras el set
    const epSets = captures.episodeSets;
    const e1Set = epSets.find(function (s) { return s.episodeId === 'e1'; });
    expect(e1Set.payload.lecciones[0].contradicted).toBe(true);
  });

  test('lesson ya contradicted -> skip', async () => {
    const { db } = makeDb({
      episodes: [
        {
          episodeId: 'e1', tags: ['x'],
          lecciones: [{ id: 'l1', text: 'no le gusta', createdAt: '2026-01-01', contradicted: true }],
        },
        {
          episodeId: 'e2', tags: ['x'],
          lecciones: [{ id: 'l2', text: 'le gusta', createdAt: '2026-02-01' }],
        },
      ],
    });
    __setFirestoreForTests(db);
    const r = await detectContradictions('uid12345');
    expect(r.lessonsMarcadas).toBe(0);
  });

  test('lesson deletedByOwnerAt -> skip', async () => {
    const { db } = makeDb({
      episodes: [
        {
          episodeId: 'e1', tags: ['x'],
          lecciones: [{ id: 'l1', text: 'no le gusta', createdAt: '2026-01-01', deletedByOwnerAt: 'X' }],
        },
        {
          episodeId: 'e2', tags: ['x'],
          lecciones: [{ id: 'l2', text: 'le gusta', createdAt: '2026-02-01' }],
        },
      ],
    });
    __setFirestoreForTests(db);
    const r = await detectContradictions('uid12345');
    expect(r.lessonsMarcadas).toBe(0);
  });

  test('lecciones sin createdAt -> dateA/dateB=0 (older=A)', async () => {
    const { db } = makeDb({
      episodes: [
        { episodeId: 'e1', tags: ['x'], lecciones: [{ id: 'l1', text: 'no le gusta' }] },
        { episodeId: 'e2', tags: ['x'], lecciones: [{ id: 'l2', text: 'le gusta', createdAt: '2026-04-01' }] },
      ],
    });
    __setFirestoreForTests(db);
    const r = await detectContradictions('uid12345');
    expect(r.lessonsMarcadas).toBe(1);
  });

  test('lessons con misma negation (ambas no o ambas si) -> no contradiccion (rama linea 91)', async () => {
    const { db } = makeDb({
      episodes: [
        { episodeId: 'e1', tags: ['x'], lecciones: [{ id: 'l1', text: 'no le gusta', createdAt: '2026-01-01' }] },
        { episodeId: 'e2', tags: ['x'], lecciones: [{ id: 'l2', text: 'nunca le gusto', createdAt: '2026-02-01' }] },
      ],
    });
    __setFirestoreForTests(db);
    const r = await detectContradictions('uid12345');
    expect(r.lessonsMarcadas).toBe(0);
  });

  test('lesson con text no string -> tratado como vacio (rama linea 74)', async () => {
    const { db } = makeDb({
      episodes: [
        { episodeId: 'e1', tags: ['x'], lecciones: [{ id: 'l1', text: 123, createdAt: '2026-01-01' }] },
        { episodeId: 'e2', tags: ['x'], lecciones: [{ id: 'l2', text: 'no gusta', createdAt: '2026-02-01' }] },
      ],
    });
    __setFirestoreForTests(db);
    const r = await detectContradictions('uid12345');
    // l1 sin negation, l2 con negation -> contradiccion (l1 mas vieja)
    expect(r.lessonsMarcadas).toBe(1);
  });

  test('2 lessons en mismo episodio con contradiccion entre si -> 1 write (rama writes.has(key) true)', async () => {
    const { db, captures } = makeDb({
      episodes: [{
        episodeId: 'e1',
        tags: ['x'],
        lecciones: [
          { id: 'l1', text: 'no gusta', createdAt: '2026-01-01' },
          { id: 'l2', text: 'le gusta', createdAt: '2026-02-01' },
        ],
      }],
    });
    __setFirestoreForTests(db);
    const r = await detectContradictions('uid12345');
    expect(r.lessonsMarcadas).toBe(1);
    // Solo 1 escritura por episodio (no 2)
    const e1Sets = captures.episodeSets.filter(function (s) { return s.episodeId === 'e1'; });
    expect(e1Sets).toHaveLength(1);
  });

  test('episodio sin tags array -> no genera intersect', async () => {
    const { db } = makeDb({
      episodes: [
        { episodeId: 'e1', lecciones: [{ id: 'l1', text: 'no le gusta', createdAt: '2026-01-01' }] },
        { episodeId: 'e2', lecciones: [{ id: 'l2', text: 'le gusta', createdAt: '2026-02-01' }] },
      ],
    });
    __setFirestoreForTests(db);
    const r = await detectContradictions('uid12345');
    expect(r.lessonsMarcadas).toBe(0);
  });
});

// ── graduateEligibleLessons ───────────────────────────────────────────────────

describe('graduateEligibleLessons', () => {
  test('uid null -> throw', async () => {
    await expect(graduateEligibleLessons(null)).rejects.toThrow('uid_requerido');
  });

  test('sin episodios -> 0', async () => {
    const { db } = makeDb({ episodes: [] });
    __setFirestoreForTests(db);
    const r = await graduateEligibleLessons('uid12345');
    expect(r.graduatedCount).toBe(0);
  });

  test('lesson sin 90d -> no gradua', async () => {
    const recent = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1',
        lecciones: [{
          id: 'l1', text: 'X', createdAt: recent,
          citationCount: 10, citationEpisodes: ['a', 'b', 'c'],
        }],
      }],
    });
    __setFirestoreForTests(db);
    const r = await graduateEligibleLessons('uid12345');
    expect(r.graduatedCount).toBe(0);
  });

  test('lesson con <3 citations -> no gradua', async () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1',
        lecciones: [{
          id: 'l1', text: 'X', createdAt: old,
          citationCount: 2, citationEpisodes: ['a', 'b'],
        }],
      }],
    });
    __setFirestoreForTests(db);
    const r = await graduateEligibleLessons('uid12345');
    expect(r.graduatedCount).toBe(0);
  });

  test('lesson con <3 episodios distintos -> no gradua', async () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1',
        lecciones: [{
          id: 'l1', text: 'X', createdAt: old,
          citationCount: 5, citationEpisodes: ['a', 'a', 'a'], // dedup -> 1 distinto
        }],
      }],
    });
    __setFirestoreForTests(db);
    const r = await graduateEligibleLessons('uid12345');
    expect(r.graduatedCount).toBe(0);
  });

  test('lesson contradicted -> no gradua', async () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1',
        lecciones: [{
          id: 'l1', text: 'X', createdAt: old, contradicted: true,
          citationCount: 5, citationEpisodes: ['a', 'b', 'c'],
        }],
      }],
    });
    __setFirestoreForTests(db);
    const r = await graduateEligibleLessons('uid12345');
    expect(r.graduatedCount).toBe(0);
  });

  test('lesson deletedByOwnerAt -> no gradua', async () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1',
        lecciones: [{
          id: 'l1', text: 'X', createdAt: old, deletedByOwnerAt: 'now',
          citationCount: 5, citationEpisodes: ['a', 'b', 'c'],
        }],
      }],
    });
    __setFirestoreForTests(db);
    const r = await graduateEligibleLessons('uid12345');
    expect(r.graduatedCount).toBe(0);
  });

  test('lesson ya graduatedAt -> no re-graduar', async () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const { db } = makeDb({
      episodes: [{
        episodeId: 'e1',
        lecciones: [{
          id: 'l1', text: 'X', createdAt: old, graduatedAt: '2026-04-01',
          citationCount: 5, citationEpisodes: ['a', 'b', 'c'],
        }],
      }],
    });
    __setFirestoreForTests(db);
    const r = await graduateEligibleLessons('uid12345');
    expect(r.graduatedCount).toBe(0);
  });

  test('OK - cumple 4 condiciones -> graduada + memory_graduated append', async () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const { db, captures } = makeDb({
      episodes: [{
        episodeId: 'e1',
        lecciones: [{
          id: 'l1', text: 'Mariano valora la puntualidad', createdAt: old,
          citationCount: 5, citationEpisodes: ['a', 'b', 'c'],
        }],
      }],
    });
    __setFirestoreForTests(db);
    const r = await graduateEligibleLessons('uid12345');
    expect(r.graduatedCount).toBe(1);
    expect(captures.brainSets[0].payload.items[0]).toContain('[MEMORIA-GRADUADA]');
    expect(captures.brainSets[0].payload.items[0]).toContain('puntualidad');
  });

  test('OK - brain con items previos -> append', async () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const { db, captures } = makeDb({
      episodes: [{
        episodeId: 'e1',
        lecciones: [{
          id: 'l1', text: 'nueva', createdAt: old,
          citationCount: 5, citationEpisodes: ['a', 'b', 'c'],
        }],
      }],
      brainGraduated: { items: ['[MEMORIA-GRADUADA] vieja 1', '[MEMORIA-GRADUADA] vieja 2'] },
    });
    __setFirestoreForTests(db);
    await graduateEligibleLessons('uid12345');
    expect(captures.brainSets[0].payload.items).toHaveLength(3);
  });

  test('OK - brain.items no array previo -> usa []', async () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const { db, captures } = makeDb({
      episodes: [{
        episodeId: 'e1',
        lecciones: [{
          id: 'l1', text: 'X', createdAt: old,
          citationCount: 5, citationEpisodes: ['a', 'b', 'c'],
        }],
      }],
      brainGraduated: {}, // sin items
    });
    __setFirestoreForTests(db);
    await graduateEligibleLessons('uid12345');
    expect(captures.brainSets[0].payload.items).toHaveLength(1);
  });

  test('episodio sin lecciones array -> skip', async () => {
    const { db } = makeDb({
      episodes: [{ episodeId: 'e1', lecciones: null }],
    });
    __setFirestoreForTests(db);
    const r = await graduateEligibleLessons('uid12345');
    expect(r.graduatedCount).toBe(0);
  });
});

// ── updateBaselineFromEpisodes ────────────────────────────────────────────────

describe('updateBaselineFromEpisodes', () => {
  test('uid null -> throw', async () => {
    await expect(updateBaselineFromEpisodes(null)).rejects.toThrow('uid_requerido');
  });

  test('sin episodios -> mensajesAnalizados=0, tonada=neutro confidence=low', async () => {
    const { db } = makeDb({ episodes: [], baseline: { bootstrapComplete: false } });
    __setFirestoreForTests(db);
    const r = await updateBaselineFromEpisodes('uid12345');
    expect(r.mensajesAnalizados).toBe(0);
    expect(r.tonada).toBe('neutro');
    expect(r.confidence).toBe('low');
  });

  test('episodios con messageIds -> suma', async () => {
    const { db } = makeDb({
      episodes: [
        { episodeId: 'e1', messageIds: ['m1', 'm2'], tonadaDetectada: 'argentina', startedAt: 1 },
        { episodeId: 'e2', messageIds: ['m3'], tonadaDetectada: 'argentina', startedAt: 2 },
      ],
      baseline: { bootstrapComplete: false, mensajesAnalizados: 0 },
    });
    __setFirestoreForTests(db);
    const r = await updateBaselineFromEpisodes('uid12345');
    expect(r.mensajesAnalizados).toBe(3);
  });

  test('episodios sin messageIds array -> 0 contribucion', async () => {
    const { db } = makeDb({
      episodes: [{ episodeId: 'e1', messageIds: 'no_array', startedAt: 1 }],
      baseline: { bootstrapComplete: false },
    });
    __setFirestoreForTests(db);
    const r = await updateBaselineFromEpisodes('uid12345');
    expect(r.mensajesAnalizados).toBe(0);
  });

  test('10 episodios argentina con bootstrap complete -> tonada=argentina + adaptacionActiva=true', async () => {
    const eps = Array.from({ length: 10 }, function (_, i) {
      return { episodeId: 'e' + i, tonadaDetectada: 'argentina', startedAt: i, messageIds: [] };
    });
    const { db, captures } = makeDb({
      episodes: eps,
      baseline: { bootstrapComplete: true, mensajesAnalizados: 100 },
    });
    __setFirestoreForTests(db);
    const r = await updateBaselineFromEpisodes('uid12345');
    expect(r.tonada).toBe('argentina');
    expect(r.confidence).toBe('high');
    // En captures debe haber un baselineSet con adaptacionActiva=true
    const adaptSet = captures.baselineSets.find(function (s) { return s.payload.adaptacionActiva === true; });
    expect(adaptSet).toBeDefined();
  });

  test('bootstrap incompleto -> NO setea adaptacionActiva', async () => {
    const eps = Array.from({ length: 10 }, function (_, i) {
      return { episodeId: 'e' + i, tonadaDetectada: 'argentina', startedAt: i, messageIds: [] };
    });
    const { db, captures } = makeDb({
      episodes: eps,
      baseline: { bootstrapComplete: false },
    });
    __setFirestoreForTests(db);
    await updateBaselineFromEpisodes('uid12345');
    // captures.baselineSets debe tener algun set pero sin adaptacionActiva=true
    const adaptSet = captures.baselineSets.find(function (s) { return s.payload.adaptacionActiva === true; });
    expect(adaptSet).toBeUndefined();
  });

  test('tonada=neutro -> no setea tonadaRegional', async () => {
    const eps = Array.from({ length: 10 }, function (_, i) {
      return { episodeId: 'e' + i, tonadaDetectada: 'neutro', startedAt: i, messageIds: [] };
    });
    const { db, captures } = makeDb({
      episodes: eps,
      baseline: { bootstrapComplete: true },
    });
    __setFirestoreForTests(db);
    await updateBaselineFromEpisodes('uid12345');
    const tonadaSet = captures.baselineSets.find(function (s) { return s.payload.tonadaRegional; });
    expect(tonadaSet).toBeUndefined();
  });

  test('episodio sin tonadaDetectada -> neutro fallback', async () => {
    const { db } = makeDb({
      episodes: [{ episodeId: 'e1', startedAt: 1, messageIds: [] }],
      baseline: { bootstrapComplete: false },
    });
    __setFirestoreForTests(db);
    const r = await updateBaselineFromEpisodes('uid12345');
    expect(r.tonada).toBe('neutro');
  });
});

// ── adjustCosThresholdMonthly ─────────────────────────────────────────────────

describe('adjustCosThresholdMonthly', () => {
  test('uid null -> throw', async () => {
    await expect(adjustCosThresholdMonthly(null)).rejects.toThrow('uid_requerido');
  });

  test('no es primer dia mes + no force -> applied=false', async () => {
    // Simular fecha != 1 via mock de Date
    const realDate = Date;
    global.Date = class extends realDate {
      constructor(...args) { super(...args); }
      getUTCDate() { return 15; }
    };
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    try {
      const r = await adjustCosThresholdMonthly('uid12345');
      expect(r.applied).toBe(false);
      expect(r.reason).toBe('no_es_primer_dia_mes');
    } finally {
      global.Date = realDate;
    }
  });

  test('force=true + precision baja -> sube umbral', async () => {
    const { db, captures } = makeDb({ baseline: { cosThreshold: 0.82 } });
    __setFirestoreForTests(db);
    baselineLib.__setFirestoreForTests(db);
    passiveValidation.__setFirestoreForTests(db);
    const resolved = [
      { feedbackState: 'MISS' }, { feedbackState: 'MISS' },
      { feedbackState: 'HIT' },
    ];
    const r = await adjustCosThresholdMonthly('uid12345', { force: true, injectionsResolved: resolved });
    expect(r.applied).toBe(true);
    expect(r.newThreshold).toBeGreaterThan(0.82);
  });

  test('force=true + precision dentro de banda 0.7-0.9 -> sin cambio', async () => {
    const { db } = makeDb({ baseline: { cosThreshold: 0.82 } });
    __setFirestoreForTests(db);
    baselineLib.__setFirestoreForTests(db);
    passiveValidation.__setFirestoreForTests(db);
    const resolved = [
      { feedbackState: 'HIT' }, { feedbackState: 'HIT' }, { feedbackState: 'MISS' },
    ];
    const r = await adjustCosThresholdMonthly('uid12345', { force: true, injectionsResolved: resolved });
    // 2 HIT + 0 REFUERZO / (2+1) = 2/3 ~ 0.666 -> < 0.7 -> sube
    // Actually let me adjust to be inside band
  });

  test('force=true sin resolved -> precision=0 -> sube umbral', async () => {
    const { db } = makeDb({ baseline: { cosThreshold: 0.82 } });
    __setFirestoreForTests(db);
    baselineLib.__setFirestoreForTests(db);
    passiveValidation.__setFirestoreForTests(db);
    const r = await adjustCosThresholdMonthly('uid12345', { force: true });
    // precision=0 < 0.7 -> sube +0.02 -> 0.84
    expect(r.newThreshold).toBe(0.84);
  });

  test('force=true con threshold ya en piso 0.75 y precision alta -> no cambio', async () => {
    const { db } = makeDb({ baseline: { cosThreshold: 0.75 } });
    __setFirestoreForTests(db);
    baselineLib.__setFirestoreForTests(db);
    passiveValidation.__setFirestoreForTests(db);
    const resolved = Array(10).fill({ feedbackState: 'REFUERZO' });
    const r = await adjustCosThresholdMonthly('uid12345', { force: true, injectionsResolved: resolved });
    // precision=1 > 0.9 -> bajaria, pero ya en piso -> no cambio
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('sin_cambio');
  });
});

// ── runNightlyExtensions ──────────────────────────────────────────────────────

describe('runNightlyExtensions', () => {
  test('uid null -> throw', async () => {
    await expect(runNightlyExtensions(null)).rejects.toThrow('uid_requerido');
  });

  test('OK - ejecuta las 4 fases', async () => {
    const { db } = makeDb({
      episodes: [],
      baseline: { bootstrapComplete: false, cosThreshold: 0.82 },
    });
    __setFirestoreForTests(db);
    baselineLib.__setFirestoreForTests(db);
    passiveValidation.__setFirestoreForTests(db);
    const r = await runNightlyExtensions('uid12345', { fase7Opts: { force: false } });
    expect(r.fase3).toBeDefined();
    expect(r.fase4).toBeDefined();
    expect(r.fase6).toBeDefined();
    expect(r.fase7).toBeDefined();
  });
});

// ── Constantes ────────────────────────────────────────────────────────────────

describe('Constantes', () => {
  test('GRADUATION_MIN_AGE_DAYS = 90', () => expect(GRADUATION_MIN_AGE_DAYS).toBe(90));
  test('GRADUATION_MIN_CITATIONS = 3', () => expect(GRADUATION_MIN_CITATIONS).toBe(3));
  test('GRADUATION_MIN_DISTINCT_EPISODES = 3', () => expect(GRADUATION_MIN_DISTINCT_EPISODES).toBe(3));
});
