'use strict';

const d3 = require('../core/mmc/episode_distiller_v3');
const baselineLib = require('../core/mmc/baseline');
const embeddingRetrieval = require('../core/mmc/embedding_retrieval');
const {
  enrichEpisodeV3,
  applyEnrichToFirestore,
  _detectTono,
  _extractTags,
  _generateLessonsFromSummary,
  _detectCadencia,
  __setFirestoreForTests,
} = d3;

// ── Mock ──────────────────────────────────────────────────────────────────────

function makeDb(opts) {
  const o = opts || {};
  const baselineData = o.baseline;
  const captures = { sets: [] };

  const baselineDocFn = jest.fn(() => ({
    get: jest.fn().mockResolvedValue({
      exists: baselineData !== undefined,
      data: () => baselineData || {},
    }),
    set: jest.fn().mockResolvedValue({}),
  }));

  const episodeDocFn = jest.fn((episodeId) => ({
    get: jest.fn().mockResolvedValue({ exists: true, data: () => ({}) }),
    set: jest.fn((payload, merge) => {
      captures.sets.push({ episodeId, payload, merge });
      return Promise.resolve({});
    }),
  }));

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
  baselineLib.__setFirestoreForTests(null);
  embeddingRetrieval.__setFirestoreForTests(null);
  embeddingRetrieval.__setEmbedForTests(null);
});

// ── _detectTono ───────────────────────────────────────────────────────────────

describe('_detectTono', () => {
  test('null -> neutro', () => expect(_detectTono(null)).toBe('neutro'));
  test('no string -> neutro', () => expect(_detectTono(123)).toBe('neutro'));
  test('vacio -> neutro', () => expect(_detectTono('')).toBe('neutro'));
  test('urgente keyword -> urgente', () => expect(_detectTono('Esto es urgente!')).toBe('urgente'));
  test('positivo keyword -> positivo', () => expect(_detectTono('Gracias, perfecto')).toBe('positivo'));
  test('negativo keyword -> negativo', () => expect(_detectTono('Es muy difícil esto')).toBe('negativo'));
  test('calido -> calido', () => expect(_detectTono('un abrazo cariñoso')).toBe('calido'));
  test('frio -> frio', () => expect(_detectTono('seco y distante')).toBe('frio'));
  test('texto neutro -> neutro', () => expect(_detectTono('hoy llueve mucho')).toBe('neutro'));
});

// ── _extractTags ──────────────────────────────────────────────────────────────

describe('_extractTags', () => {
  test('null -> []', () => expect(_extractTags(null)).toEqual([]));
  test('no string -> []', () => expect(_extractTags(123)).toEqual([]));
  test('vacio -> []', () => expect(_extractTags('')).toEqual([]));
  test('texto con palabras frecuentes -> top 5', () => {
    const r = _extractTags('clinica clinica clinica pacientes pacientes citas turnos urgente');
    expect(r.length).toBeLessThanOrEqual(5);
    expect(r).toContain('clinica');
  });
  test('palabras cortas (< 5) -> filtradas', () => {
    const r = _extractTags('hola que tal hoy');
    expect(r).toEqual([]);
  });
  test('stopwords filtradas', () => {
    const r = _extractTags('porque cuando donde tambien');
    expect(r).toEqual([]);
  });
});

// ── _generateLessonsFromSummary ───────────────────────────────────────────────

describe('_generateLessonsFromSummary', () => {
  test('null -> []', () => expect(_generateLessonsFromSummary(null)).toEqual([]));
  test('no string -> []', () => expect(_generateLessonsFromSummary(123)).toEqual([]));
  test('vacio -> []', () => expect(_generateLessonsFromSummary('')).toEqual([]));

  test('summary con preferencia -> 1 leccion', () => {
    const r = _generateLessonsFromSummary('Mariano prefiere mensajes cortos por la mañana. Tambien valora la puntualidad mucho.');
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0].text).toContain('prefiere');
    expect(r[0].confidence).toBe('low');
    expect(r[0].source).toBe('nightly_distill');
  });

  test('summary con 3+ patrones de aprendizaje -> max 3', () => {
    const r = _generateLessonsFromSummary(
      'Le gusta la informalidad porque es directo. Le molesta la espera. Siempre llega temprano. Nunca cancela. Odia la formalidad.'
    );
    expect(r.length).toBeLessThanOrEqual(3);
  });

  test('summary operacional sin patrones -> []', () => {
    const r = _generateLessonsFromSummary('Confirmamos la cita para el viernes a las 3pm. Solicitamos enviar documentos. Recibimos los archivos correctamente.');
    expect(r).toEqual([]);
  });

  test('summary con frases cortas -> filtradas (< 10 chars)', () => {
    const r = _generateLessonsFromSummary('Si. No. Ok. Bien.');
    expect(r).toEqual([]);
  });
});

// ── _detectCadencia ───────────────────────────────────────────────────────────

describe('_detectCadencia', () => {
  test('bootstrapComplete=false -> null', () => {
    expect(_detectCadencia([{ text: 'x' }, { text: 'y' }, { text: 'z' }], false)).toBeNull();
  });
  test('mensajes < 3 -> null', () => {
    expect(_detectCadencia([{ text: 'x' }], true)).toBeNull();
  });
  test('mensajes no array -> null', () => {
    expect(_detectCadencia(null, true)).toBeNull();
  });

  test('urgente -> positivo = reparacion', () => {
    const r = _detectCadencia(
      [{ text: 'esto es urgente' }, { text: 'algo medio' }, { text: 'gracias perfecto' }],
      true
    );
    expect(r.tipo).toBe('reparacion');
    expect(r.cadenceConfidence).toBe('medium');
    expect(r.sensacion.before).toBe('urgente');
    expect(r.sensacion.after).toBe('positivo');
  });

  test('negativo -> positivo = reparacion', () => {
    const r = _detectCadencia(
      [{ text: 'es dificil' }, { text: 'algo' }, { text: 'gracias genial' }],
      true
    );
    expect(r.tipo).toBe('reparacion');
  });

  test('positivo -> positivo = convergencia', () => {
    const r = _detectCadencia(
      [{ text: 'gracias' }, { text: 'a' }, { text: 'perfecto' }],
      true
    );
    expect(r.tipo).toBe('convergencia');
  });

  test('positivo -> negativo = divergencia', () => {
    const r = _detectCadencia(
      [{ text: 'gracias' }, { text: 'a' }, { text: 'es dificil' }],
      true
    );
    expect(r.tipo).toBe('divergencia');
  });

  test('negativo -> urgente = escalada', () => {
    const r = _detectCadencia(
      [{ text: 'preocupado' }, { text: 'a' }, { text: 'urgente problema' }],
      true
    );
    expect(r.tipo).toBe('escalada');
  });

  test('urgente -> neutro = aplanamiento', () => {
    const r = _detectCadencia(
      [{ text: 'urgente' }, { text: 'a' }, { text: 'hoy llueve' }],
      true
    );
    expect(r.tipo).toBe('aplanamiento');
  });

  test('neutro->neutro = sin tipo, confidence low', () => {
    const r = _detectCadencia(
      [{ text: 'hoy llueve' }, { text: 'a' }, { text: 'mañana clima' }],
      true
    );
    expect(r.tipo).toBeNull();
    expect(r.cadenceConfidence).toBe('low');
  });

  test('before==after -> delta null', () => {
    const r = _detectCadencia(
      [{ text: 'gracias' }, { text: 'a' }, { text: 'perfecto' }],
      true
    );
    expect(r.sensacion.delta).toBeNull();
  });

  test('mensajes con body en lugar de text', () => {
    const r = _detectCadencia(
      [{ body: 'urgente' }, { body: 'a' }, { body: 'gracias' }],
      true
    );
    expect(r.tipo).toBe('reparacion');
  });

  test('mensaje sin text ni body -> tratado como string vacio', () => {
    const r = _detectCadencia(
      [{}, {}, {}],
      true
    );
    expect(r.tipo).toBeNull();
  });
});

// ── enrichEpisodeV3 ───────────────────────────────────────────────────────────

describe('enrichEpisodeV3', () => {
  test('input sin uid -> throw', async () => {
    await expect(enrichEpisodeV3({})).rejects.toThrow('uid_requerido');
  });
  test('input null -> throw', async () => {
    await expect(enrichEpisodeV3(null)).rejects.toThrow('uid_requerido');
  });
  test('sin episodeId -> throw', async () => {
    await expect(enrichEpisodeV3({ uid: 'u1' })).rejects.toThrow('episodeId_requerido');
  });

  test('OK con bootstrap incompleto -> sin cadencia', async () => {
    const { db } = makeDb({ baseline: { bootstrapComplete: false } });
    __setFirestoreForTests(db);
    embeddingRetrieval.__setEmbedForTests(async () => [0.1, 0.2, 0.3]);
    const r = await enrichEpisodeV3({
      uid: 'uid12345', episodeId: 'e1',
      mensajes: [{ text: 'che vos sabes' }, { text: 'gracias perfecto' }],
      baseSummary: 'Conversacion sobre algo',
      baseTopic: 'Tema X',
    });
    expect(r.idiomaDetectado).toBe('es');
    expect(r.tonadaDetectada).toBe('argentina');
    expect(r.tono).toBeDefined();
    expect(r.tipo).toBeNull();
    expect(r.cadenceConfidence).toBeNull();
    expect(r.vector).toEqual([0.1, 0.2, 0.3]);
    expect(r.embeddingModel).toBeDefined();
  });

  test('OK con bootstrap completo + mensajes 3+ -> con cadencia', async () => {
    const { db } = makeDb({ baseline: { bootstrapComplete: true } });
    __setFirestoreForTests(db);
    embeddingRetrieval.__setEmbedForTests(async () => [0.1, 0.2]);
    const r = await enrichEpisodeV3({
      uid: 'uid12345', episodeId: 'e1',
      mensajes: [{ text: 'urgente' }, { text: 'algo' }, { text: 'gracias' }],
      baseSummary: 'Algo',
      baseTopic: 'X',
    });
    expect(r.tipo).toBe('reparacion');
    expect(r.cadenceConfidence).toBe('medium');
  });

  test('OK con baseline inexistente -> bootstrap false implicito', async () => {
    const { db } = makeDb({}); // baseline undefined
    __setFirestoreForTests(db);
    embeddingRetrieval.__setEmbedForTests(async () => [0.1]);
    const r = await enrichEpisodeV3({
      uid: 'uid12345', episodeId: 'e1',
      mensajes: [{ text: 'urgente' }, { text: 'a' }, { text: 'gracias' }],
      baseSummary: 'X',
    });
    expect(r.cadenceConfidence).toBeNull();
  });

  test('OK con mensaje null en array -> tratado como string vacio (cubre m && fallback)', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    embeddingRetrieval.__setEmbedForTests(async () => [0.1]);
    const r = await enrichEpisodeV3({
      uid: 'uid12345', episodeId: 'e1',
      mensajes: [null, undefined, { text: 'hola' }],
      baseSummary: 'X',
    });
    expect(r.idiomaDetectado).toBe('es');
  });

  test('OK con mensaje objeto vacio -> text y body falsy -> "" (rama final ||)', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    embeddingRetrieval.__setEmbedForTests(async () => [0.1]);
    const r = await enrichEpisodeV3({
      uid: 'uid12345', episodeId: 'e1',
      mensajes: [{}, { body: 'b' }, { text: 't' }],
      baseSummary: 'X',
    });
    expect(r.idiomaDetectado).toBe('es');
  });

  test('OK sin mensajes -> fallback strings vacios', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    embeddingRetrieval.__setEmbedForTests(async () => null); // embed fall
    const r = await enrichEpisodeV3({
      uid: 'uid12345', episodeId: 'e1',
    });
    expect(r.idiomaDetectado).toBe('es');
    expect(r.tonadaDetectada).toBe('neutro');
    expect(r.tono).toBe('neutro');
    expect(r.vector).toBeNull();
    expect(r.embeddingModel).toBeNull();
    expect(r.tipo).toBeNull();
  });

  test('summary genera lecciones', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    embeddingRetrieval.__setEmbedForTests(async () => [0.5]);
    const r = await enrichEpisodeV3({
      uid: 'uid12345', episodeId: 'e1',
      mensajes: [{ text: 'a' }],
      baseSummary: 'Mariano prefiere mensajes cortos. Siempre responde rapido.',
    });
    expect(r.lecciones.length).toBeGreaterThan(0);
  });
});

// ── applyEnrichToFirestore ────────────────────────────────────────────────────

describe('applyEnrichToFirestore', () => {
  test('persiste delta merge', async () => {
    const { db, captures } = makeDb({ baseline: { bootstrapComplete: true } });
    __setFirestoreForTests(db);
    embeddingRetrieval.__setEmbedForTests(async () => [0.1]);
    const r = await applyEnrichToFirestore('uid12345', 'e1',
      [{ text: 'urgente' }, { text: 'a' }, { text: 'gracias perfecto' }],
      'resumen',
      'topic'
    );
    expect(r.ok).toBe(true);
    expect(captures.sets[0].payload.tipo).toBe('reparacion');
    expect(captures.sets[0].merge).toEqual({ merge: true });
  });
});
