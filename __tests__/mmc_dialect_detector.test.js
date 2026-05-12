'use strict';

const {
  detectLanguage,
  detectTonada,
  detectFromEpisode,
  consolidateTonadaConfidence,
  TONADAS,
} = require('../core/mmc/dialect_detector');

// ── detectLanguage ────────────────────────────────────────────────────────────

describe('detectLanguage', () => {
  test('null -> es (default)', () => expect(detectLanguage(null)).toBe('es'));
  test('no string -> es', () => expect(detectLanguage(123)).toBe('es'));
  test('vacio -> es', () => expect(detectLanguage('')).toBe('es'));
  test('texto en español -> es', () => expect(detectLanguage('hola que tal todo bien')).toBe('es'));
  test('portugues - você -> pt', () => expect(detectLanguage('Você pode falar mais devagar')).toBe('pt'));
  test('portugues - obrigado -> pt', () => expect(detectLanguage('muito obrigado pelo apoio')).toBe('pt'));
  test('ingles - hello -> en', () => expect(detectLanguage('hello how are you doing today')).toBe('en'));
  test('ingles - thank you -> en', () => expect(detectLanguage('thank you very much for the help')).toBe('en'));
});

// ── detectTonada ──────────────────────────────────────────────────────────────

describe('detectTonada', () => {
  test('null -> neutro', () => expect(detectTonada(null)).toBe('neutro'));
  test('no string -> neutro', () => expect(detectTonada(123)).toBe('neutro'));
  test('vacio -> neutro', () => expect(detectTonada('')).toBe('neutro'));

  test('argentina - voseo + che', () => {
    expect(detectTonada('che, vos sabes que tenes que hacer eso')).toBe('argentina');
  });
  test('argentina - laburo + posta', () => {
    expect(detectTonada('andate al laburo, posta posta')).toBe('argentina');
  });
  test('argentina - bondi', () => {
    expect(detectTonada('me tomo el bondi y voy para alla')).toBe('argentina');
  });

  test('colombia - parcero + chevere', () => {
    expect(detectTonada('parcero, todo chevere por aca')).toBe('colombia');
  });
  test('colombia - quiubo + bacano', () => {
    expect(detectTonada('quiubo mi gente, todo muy bacano')).toBe('colombia');
  });
  test('colombia - que mas pues', () => {
    expect(detectTonada('hola, que mas pues')).toBe('colombia');
  });

  test('mexico - orale + wey', () => {
    expect(detectTonada('orale wey, neta que esta chido')).toBe('mexico');
  });
  test('mexico - ahorita + neta', () => {
    expect(detectTonada('ahorita lo hago, neta')).toBe('mexico');
  });
  test('mexico - no manches', () => {
    expect(detectTonada('no manches, esa cuate esta loco')).toBe('mexico');
  });

  test('texto neutro -> neutro', () => {
    expect(detectTonada('Hola, como estas. Por favor confirma la cita.')).toBe('neutro');
  });

  test('empate entre 2 dialectos -> neutro (seguro)', () => {
    expect(detectTonada('che parcero, posta que esto es bacano')).toBe('neutro');
  });

  test('case insensitive (CHE, PARCERO, ORALE)', () => {
    expect(detectTonada('CHE VOS SABES')).toBe('argentina');
    expect(detectTonada('PARCERO QUE MAS PUES')).toBe('colombia');
    expect(detectTonada('ORALE WEY')).toBe('mexico');
  });

  test('argentina - "vos sabés" con tilde', () => {
    expect(detectTonada('vos sabés lo que haces')).toBe('argentina');
  });
});

// ── detectFromEpisode ─────────────────────────────────────────────────────────

describe('detectFromEpisode', () => {
  test('no array -> defaults', () => {
    expect(detectFromEpisode(null)).toEqual({ idioma: 'es', tonada: 'neutro', scoreTonada: 0 });
  });
  test('array vacio -> defaults', () => {
    expect(detectFromEpisode([])).toEqual({ idioma: 'es', tonada: 'neutro', scoreTonada: 0 });
  });

  test('mensajes argentina -> idioma=es, tonada=argentina, score>0', () => {
    const r = detectFromEpisode([
      { text: 'che, vos sabes que tenes que ir' },
      { text: 'posta, posta' },
    ]);
    expect(r.idioma).toBe('es');
    expect(r.tonada).toBe('argentina');
    expect(r.scoreTonada).toBeGreaterThan(0);
  });

  test('mensajes con body en lugar de text -> OK', () => {
    const r = detectFromEpisode([{ body: 'parcero, todo chevere' }]);
    expect(r.tonada).toBe('colombia');
  });

  test('mensajes sin text ni body -> defaults', () => {
    const r = detectFromEpisode([{ foo: 'bar' }, {}]);
    expect(r.tonada).toBe('neutro');
    expect(r.scoreTonada).toBe(0);
  });

  test('mensajes en portugues', () => {
    const r = detectFromEpisode([{ text: 'Você pode falar mais devagar?' }]);
    expect(r.idioma).toBe('pt');
  });

  test('tonada=neutro -> scoreTonada=0', () => {
    const r = detectFromEpisode([{ text: 'Hola buen dia confirmar cita' }]);
    expect(r.tonada).toBe('neutro');
    expect(r.scoreTonada).toBe(0);
  });
});

// ── consolidateTonadaConfidence ───────────────────────────────────────────────

describe('consolidateTonadaConfidence', () => {
  test('no array -> low neutro', () => {
    expect(consolidateTonadaConfidence(null)).toEqual({ tonada: 'neutro', confidence: 'low' });
  });
  test('array vacio -> low neutro', () => {
    expect(consolidateTonadaConfidence([])).toEqual({ tonada: 'neutro', confidence: 'low' });
  });

  test('9/10 argentina -> high', () => {
    const arr = Array(9).fill('argentina').concat(['neutro']);
    const r = consolidateTonadaConfidence(arr);
    expect(r.tonada).toBe('argentina');
    expect(r.confidence).toBe('high');
  });

  test('7/10 colombia -> medium', () => {
    const arr = Array(7).fill('colombia').concat(['neutro', 'argentina', 'neutro']);
    const r = consolidateTonadaConfidence(arr);
    expect(r.tonada).toBe('colombia');
    expect(r.confidence).toBe('medium');
  });

  test('5/10 mexico -> low (no llega a 7)', () => {
    const arr = Array(5).fill('mexico').concat(Array(5).fill('neutro'));
    const r = consolidateTonadaConfidence(arr);
    // bestTonada=mexico O neutro empate? mexico=5, neutro=5 -> mexico es first.
    // Pero ratio=0.5 < 0.7 -> low.
    expect(r.confidence).toBe('low');
  });

  test('menos de 10 episodios -> confidence=low siempre', () => {
    const arr = Array(5).fill('argentina');
    const r = consolidateTonadaConfidence(arr);
    expect(r.tonada).toBe('argentina');
    expect(r.confidence).toBe('low');
  });

  test('tonada ganadora neutro -> confidence=low', () => {
    const arr = Array(10).fill('neutro');
    const r = consolidateTonadaConfidence(arr);
    expect(r.tonada).toBe('neutro');
    expect(r.confidence).toBe('low');
  });

  test('10 todos argentina -> high', () => {
    const arr = Array(10).fill('argentina');
    const r = consolidateTonadaConfidence(arr);
    expect(r.confidence).toBe('high');
  });

  test('8/10 argentina + 2 neutro -> medium', () => {
    const arr = Array(8).fill('argentina').concat(['neutro', 'neutro']);
    const r = consolidateTonadaConfidence(arr);
    expect(r.confidence).toBe('medium');
  });
});

// ── Exports ───────────────────────────────────────────────────────────────────

describe('Exports', () => {
  test('TONADAS frozen', () => {
    expect(TONADAS.ARGENTINA).toBe('argentina');
    expect(TONADAS.COLOMBIA).toBe('colombia');
    expect(TONADAS.MEXICO).toBe('mexico');
    expect(TONADAS.NEUTRO).toBe('neutro');
  });
});
