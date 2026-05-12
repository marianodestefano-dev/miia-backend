'use strict';

const pv = require('../core/mmc/passive_validation');
const {
  classifyFeedback,
  logInjection,
  resolveInjection,
  computePrecision,
  computeNewThreshold,
  getCosThreshold,
  setCosThreshold,
  STATES,
  WEIGHTS,
  REFUERZO_REGEX,
  MISS_REGEX,
  COS_THRESHOLD_DEFAULT,
  COS_THRESHOLD_MIN,
  COS_THRESHOLD_MAX,
  PRECISION_LOW,
  PRECISION_HIGH,
  __setFirestoreForTests,
} = pv;

// ── Mock ──────────────────────────────────────────────────────────────────────

function makeDb(opts) {
  const o = opts || {};
  const injections = o.injections || {};
  const baseline = o.baseline; // undefined si no existe
  const captures = { injectionSets: [], baselineSets: [] };

  const injectionDocFn = jest.fn((id) => ({
    get: jest.fn().mockResolvedValue({ exists: !!injections[id], data: () => injections[id] || {} }),
    set: jest.fn((payload, merge) => {
      captures.injectionSets.push({ id, payload, merge });
      return Promise.resolve({});
    }),
  }));

  const baselineDocFn = jest.fn(() => ({
    get: jest.fn().mockResolvedValue({
      exists: baseline !== undefined,
      data: () => baseline || {},
    }),
    set: jest.fn((payload, merge) => {
      captures.baselineSets.push({ payload, merge });
      return Promise.resolve({});
    }),
  }));

  // Estructura: users/{uid}/miia_memory/{episodeId}/injections/{injectionId}
  // O          users/{uid}/miia_baseline/personal
  const subInjectionsCol = jest.fn(() => ({ doc: injectionDocFn }));

  const episodeDocFn = jest.fn(() => ({ collection: subInjectionsCol }));

  const subCollFn = jest.fn((name) => {
    if (name === 'miia_baseline') return { doc: baselineDocFn };
    return { doc: episodeDocFn };
  });

  const ownerDocFn = jest.fn(() => ({ collection: subCollFn }));
  const db = { collection: jest.fn(() => ({ doc: ownerDocFn })) };
  return { db, captures };
}

beforeEach(() => {
  __setFirestoreForTests(null);
});

// ── classifyFeedback ──────────────────────────────────────────────────────────

describe('classifyFeedback', () => {
  test('sessionEnded + sin reply -> SILENCIO', () => {
    expect(classifyFeedback(null, 0, true)).toBe(STATES.SILENCIO);
    expect(classifyFeedback('', 0, true)).toBe(STATES.SILENCIO);
  });

  test('no reply + session no terminada -> HIT (3 turnos sin correccion)', () => {
    expect(classifyFeedback(null, 3, false)).toBe(STATES.HIT);
  });

  test('reply REFUERZO (positivo)', () => {
    expect(classifyFeedback('si exacto', 0, false)).toBe(STATES.REFUERZO);
    expect(classifyFeedback('Posta', 0, false)).toBe(STATES.REFUERZO);
    expect(classifyFeedback('chévere', 0, false)).toBe(STATES.REFUERZO);
    expect(classifyFeedback('órale', 0, false)).toBe(STATES.REFUERZO);
    expect(classifyFeedback('perfecto', 0, false)).toBe(STATES.REFUERZO);
  });

  test('reply MISS (negativo)', () => {
    expect(classifyFeedback('no, mal', 0, false)).toBe(STATES.MISS);
    expect(classifyFeedback('nada que ver', 0, false)).toBe(STATES.MISS);
    expect(classifyFeedback('no fue así', 0, false)).toBe(STATES.MISS);
    expect(classifyFeedback('nel', 0, false)).toBe(STATES.MISS);
    expect(classifyFeedback('te equivocas', 0, false)).toBe(STATES.MISS);
  });

  test('reply neutro + turnos<3 -> HIT (todavia esperando)', () => {
    expect(classifyFeedback('claro', 0, false)).toBe(STATES.REFUERZO); // claro es refuerzo
    expect(classifyFeedback('hola que tal', 1, false)).toBe(STATES.HIT);
  });

  test('reply neutro + turnos>=3 -> HIT', () => {
    expect(classifyFeedback('hola que tal', 5, false)).toBe(STATES.HIT);
  });

  test('reply no string -> HIT si sesion no termino', () => {
    expect(classifyFeedback(123, 0, false)).toBe(STATES.HIT);
  });

  test('reply no string + sesion terminada -> SILENCIO', () => {
    expect(classifyFeedback(undefined, 0, true)).toBe(STATES.SILENCIO);
  });

  test('reply non-string truthy (numero) + sesion terminada -> SILENCIO (linea 64 sessionEnded=true branch)', () => {
    expect(classifyFeedback(123, 0, true)).toBe(STATES.SILENCIO);
  });

  test('reply con espacios -> trim', () => {
    expect(classifyFeedback('  si  ', 0, false)).toBe(STATES.REFUERZO);
  });

  test('turnsSinceInjection no number -> default HIT', () => {
    expect(classifyFeedback('hola', 'tres', false)).toBe(STATES.HIT);
  });
});

// ── logInjection ──────────────────────────────────────────────────────────────

describe('logInjection', () => {
  test('uid null -> throw', async () => {
    await expect(logInjection(null, 'e1', { lessonId: 'l1' })).rejects.toThrow('uid_requerido');
  });
  test('episodeId null -> throw', async () => {
    await expect(logInjection('u1', null, { lessonId: 'l1' })).rejects.toThrow('episodeId_requerido');
  });
  test('payload null -> throw', async () => {
    await expect(logInjection('u1', 'e1', null)).rejects.toThrow('lessonId_requerido');
  });
  test('sin lessonId -> throw', async () => {
    await expect(logInjection('u1', 'e1', {})).rejects.toThrow('lessonId_requerido');
  });

  test('OK con todos los campos', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await logInjection('uid12345', 'e1', {
      lessonId: 'lsn_1', lessonText: 'Mariano prefiere brevedad',
      similarityScore: 0.88, threshold: 0.82,
    });
    expect(r.injectionId).toMatch(/^inj_/);
    expect(captures.injectionSets[0].payload.similarityScore).toBe(0.88);
    expect(captures.injectionSets[0].payload.resolved).toBe(false);
    expect(captures.injectionSets[0].payload.feedbackState).toBeNull();
  });

  test('OK con defaults (sin similarityScore ni threshold)', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await logInjection('uid12345', 'e1', { lessonId: 'lsn_1' });
    expect(captures.injectionSets[0].payload.similarityScore).toBe(0);
    expect(captures.injectionSets[0].payload.threshold).toBe(COS_THRESHOLD_DEFAULT);
    expect(captures.injectionSets[0].payload.lessonText).toBe('');
  });
});

// ── resolveInjection ──────────────────────────────────────────────────────────

describe('resolveInjection', () => {
  test('uid null -> throw', async () => {
    await expect(resolveInjection(null, 'e1', 'inj1', STATES.HIT)).rejects.toThrow('parametros_requeridos');
  });
  test('episodeId null -> throw', async () => {
    await expect(resolveInjection('u1', null, 'inj1', STATES.HIT)).rejects.toThrow('parametros_requeridos');
  });
  test('injectionId null -> throw', async () => {
    await expect(resolveInjection('u1', 'e1', null, STATES.HIT)).rejects.toThrow('parametros_requeridos');
  });
  test('feedbackState invalido -> throw', async () => {
    await expect(resolveInjection('u1', 'e1', 'inj1', 'FOO')).rejects.toThrow('feedbackState_invalido');
  });

  test('OK con HIT', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await resolveInjection('uid12345', 'e1', 'inj_1', STATES.HIT);
    expect(r.ok).toBe(true);
    expect(r.weight).toBe(WEIGHTS.HIT);
    expect(captures.injectionSets[0].payload.weight).toBe(1);
  });

  test('OK con REFUERZO -> weight 2', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await resolveInjection('uid12345', 'e1', 'inj_1', STATES.REFUERZO);
    expect(r.weight).toBe(2);
  });

  test('OK con MISS -> weight -1', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await resolveInjection('uid12345', 'e1', 'inj_1', STATES.MISS);
    expect(r.weight).toBe(-1);
  });

  test('OK con SILENCIO -> weight 0', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await resolveInjection('uid12345', 'e1', 'inj_1', STATES.SILENCIO);
    expect(r.weight).toBe(0);
  });
});

// ── computePrecision ──────────────────────────────────────────────────────────

describe('computePrecision', () => {
  test('no array -> default 0', () => {
    expect(computePrecision(null).precision).toBe(0);
  });
  test('array vacio -> 0', () => {
    expect(computePrecision([]).precision).toBe(0);
  });

  test('todos HIT -> precision=1 (peso positivo, no MISS)', () => {
    const r = computePrecision([
      { feedbackState: STATES.HIT }, { feedbackState: STATES.HIT },
    ]);
    expect(r.precision).toBe(1);
    expect(r.hits).toBe(2);
  });

  test('mix HIT + REFUERZO + MISS', () => {
    const r = computePrecision([
      { feedbackState: STATES.HIT },        // +1
      { feedbackState: STATES.REFUERZO },   // +2
      { feedbackState: STATES.REFUERZO },   // +2
      { feedbackState: STATES.MISS },       // peso -1 en denominador
    ]);
    expect(r.hits).toBe(1);
    expect(r.refuerzos).toBe(2);
    expect(r.misses).toBe(1);
    // (1 + 4) / (1 + 4 + 1) = 5/6
    expect(r.precision).toBeCloseTo(5 / 6, 5);
  });

  test('todos MISS -> precision=0', () => {
    const r = computePrecision([
      { feedbackState: STATES.MISS }, { feedbackState: STATES.MISS },
    ]);
    expect(r.precision).toBe(0);
    expect(r.misses).toBe(2);
  });

  test('todos SILENCIO -> precision=0 (sin pesos positivos ni negativos)', () => {
    const r = computePrecision([{ feedbackState: STATES.SILENCIO }]);
    expect(r.precision).toBe(0);
  });
});

// ── computeNewThreshold ───────────────────────────────────────────────────────

describe('computeNewThreshold', () => {
  test('precision < 0.7 -> sube umbral +0.02', () => {
    expect(computeNewThreshold(0.82, 0.5)).toBe(0.84);
  });
  test('precision > 0.9 -> baja umbral -0.02', () => {
    expect(computeNewThreshold(0.82, 0.95)).toBe(0.8);
  });
  test('precision entre 0.7 y 0.9 -> sin cambio', () => {
    expect(computeNewThreshold(0.82, 0.8)).toBe(0.82);
  });
  test('umbral actual = piso 0.75, precision alta -> queda en 0.75', () => {
    expect(computeNewThreshold(COS_THRESHOLD_MIN, 0.95)).toBe(COS_THRESHOLD_MIN);
  });
  test('umbral actual = techo 0.92, precision baja -> queda en 0.92', () => {
    expect(computeNewThreshold(COS_THRESHOLD_MAX, 0.5)).toBe(COS_THRESHOLD_MAX);
  });
  test('currentThreshold no number -> usa default 0.82', () => {
    expect(computeNewThreshold('foo', 0.95)).toBe(0.8);
  });
  test('precision no number -> retorna current', () => {
    expect(computeNewThreshold(0.82, 'foo')).toBe(0.82);
  });
  test('precision fuera de [0,1] -> retorna current', () => {
    expect(computeNewThreshold(0.82, -0.5)).toBe(0.82);
    expect(computeNewThreshold(0.82, 1.5)).toBe(0.82);
  });
  test('precision exactamente 0.7 -> sin cambio (boundary)', () => {
    expect(computeNewThreshold(0.82, PRECISION_LOW)).toBe(0.82);
  });
  test('precision exactamente 0.9 -> sin cambio (boundary)', () => {
    expect(computeNewThreshold(0.82, PRECISION_HIGH)).toBe(0.82);
  });
});

// ── getCosThreshold ───────────────────────────────────────────────────────────

describe('getCosThreshold', () => {
  test('uid null -> throw', async () => {
    await expect(getCosThreshold(null)).rejects.toThrow('uid_requerido');
  });

  test('baseline no existe -> default', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    expect(await getCosThreshold('uid12345')).toBe(COS_THRESHOLD_DEFAULT);
  });

  test('baseline existe con cosThreshold custom', async () => {
    const { db } = makeDb({ baseline: { cosThreshold: 0.88 } });
    __setFirestoreForTests(db);
    expect(await getCosThreshold('uid12345')).toBe(0.88);
  });

  test('baseline existe sin cosThreshold -> default', async () => {
    const { db } = makeDb({ baseline: {} });
    __setFirestoreForTests(db);
    expect(await getCosThreshold('uid12345')).toBe(COS_THRESHOLD_DEFAULT);
  });
});

// ── setCosThreshold ───────────────────────────────────────────────────────────

describe('setCosThreshold', () => {
  test('uid null -> throw', async () => {
    await expect(setCosThreshold(null, 0.85)).rejects.toThrow('uid_requerido');
  });
  test('threshold no number -> throw', async () => {
    await expect(setCosThreshold('u1', 'foo')).rejects.toThrow('threshold_invalido');
  });

  test('OK', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await setCosThreshold('uid12345', 0.86);
    expect(r.ok).toBe(true);
    expect(captures.baselineSets[0].payload.cosThreshold).toBe(0.86);
  });
});

// ── Regex sanity ──────────────────────────────────────────────────────────────

describe('REFUERZO_REGEX', () => {
  test.each([
    'si', 'Si', 'exacto', 'eso es', 'tal cual', 'claro', 'dale', 'posta',
    'obvio', 'correcto', 'chevere', 'bacano', 'listo', 'orale', 'neta', 'perfecto',
  ])('"%s" -> match', (s) => { expect(REFUERZO_REGEX.test(s)).toBe(true); });
});

describe('MISS_REGEX', () => {
  test.each([
    'no', 'mal', 'eso no', 'nada que ver', 'no entendiste', 'te equivocas',
    'no es asi', 'no man', 'nel',
  ])('"%s" -> match', (s) => { expect(MISS_REGEX.test(s)).toBe(true); });
});
