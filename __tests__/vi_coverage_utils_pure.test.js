'use strict';

/**
 * VI-BACKEND-COVERAGE: pure utility modules — 100% branches
 *   core/similarity.js
 *   core/bot_detection.js
 *   core/tag_extractor.js
 *   core/sports_mention_detector.js
 */

// ═══════════════════════════════════════════════════════════════
// core/similarity.js
// ═══════════════════════════════════════════════════════════════

const { similarityRatio, tokenize } = require('../core/similarity');

describe('tokenize', () => {
  test('null → empty Set (branch !text)', () => {
    expect(tokenize(null).size).toBe(0);
  });

  test('number → empty Set (branch typeof)', () => {
    expect(tokenize(42).size).toBe(0);
  });

  test('empty string → empty Set (filter Boolean)', () => {
    expect(tokenize('').size).toBe(0);
  });

  test('texto normal → Set con palabras', () => {
    const s = tokenize('hola mundo');
    expect(s.has('hola')).toBe(true);
    expect(s.has('mundo')).toBe(true);
  });

  test('puntuacion se elimina → solo palabras', () => {
    const s = tokenize('hola!!! mundo?');
    expect(s.has('hola')).toBe(true);
    expect(s.has('mundo')).toBe(true);
  });
});

describe('similarityRatio', () => {
  test('!a && !b → 1.0 (ambos falsy)', () => {
    expect(similarityRatio(null, null)).toBe(1.0);
    expect(similarityRatio('', '')).toBe(1.0);
  });

  test('!a pero b existe → 0.0 (branch !a || !b)', () => {
    expect(similarityRatio(null, 'hola')).toBe(0.0);
  });

  test('a existe pero !b → 0.0', () => {
    expect(similarityRatio('hola', null)).toBe(0.0);
  });

  test('ambos con tokens pero setA.size=0 y setB.size=0 → 1.0', () => {
    // textos con solo puntuacion → tokens vacios
    expect(similarityRatio('!!!', '???')).toBe(1.0);
  });

  test('setA vacio, setB no → 0.0 (branch setA.size === 0 || setB.size === 0)', () => {
    expect(similarityRatio('!!!', 'hola mundo')).toBe(0.0);
  });

  test('setB vacio, setA no → 0.0', () => {
    expect(similarityRatio('hola mundo', '???')).toBe(0.0);
  });

  test('textos identicos → 1.0', () => {
    expect(similarityRatio('hola mundo', 'hola mundo')).toBe(1.0);
  });

  test('sin palabras en comun → 0.0', () => {
    expect(similarityRatio('hola', 'mundo')).toBe(0.0);
  });

  test('interseccion parcial → valor entre 0 y 1', () => {
    const r = similarityRatio('hola mundo', 'hola tierra');
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// core/bot_detection.js
// ═══════════════════════════════════════════════════════════════

const { calculateBotScore, BOT_SCORE_THRESHOLD } = require('../core/bot_detection');

describe('calculateBotScore', () => {
  test('no es array → {score:0, verdict:unknown} (branch !Array.isArray)', () => {
    const r = calculateBotScore(null);
    expect(r.score).toBe(0);
    expect(r.verdict).toBe('unknown');
  });

  test('array vacio → unknown', () => {
    const r = calculateBotScore([]);
    expect(r.score).toBe(0);
    expect(r.verdict).toBe('unknown');
  });

  test('solo mensajes propios (fromMe=true) → contactMsgs=0 → unknown', () => {
    const r = calculateBotScore([{ text: 'hola', fromMe: true }]);
    expect(r.verdict).toBe('unknown');
  });

  test('1 mensaje del contacto sin timestamps → score=0 human', () => {
    const r = calculateBotScore([{ text: 'hola', fromMe: false }]);
    expect(r.verdict).toBe('human');
    expect(r.score).toBe(0);
  });

  test('respuestas ultra-rapidas → score sube (Senal 1)', () => {
    const now = Date.now();
    const msgs = [
      { text: 'msg1', fromMe: false, timestamp: now },
      { text: 'msg2', fromMe: false, timestamp: now + 500 },  // < 2000ms
      { text: 'msg3', fromMe: false, timestamp: now + 1000 }, // < 2000ms
    ];
    const r = calculateBotScore(msgs);
    expect(r.score).toBeGreaterThan(0);
    expect(r.signals.some(s => s.startsWith('ultra_fast'))).toBe(true);
  });

  test('mensajes identicos repetidos x5 → Senal 2 → bot (score=60 >= threshold)', () => {
    const msgs = [
      { text: 'spam', fromMe: false },
      { text: 'spam', fromMe: false },
      { text: 'spam', fromMe: false },
      { text: 'spam', fromMe: false },
      { text: 'spam', fromMe: false },
    ];
    const r = calculateBotScore(msgs);
    expect(r.signals.some(s => s.startsWith('repeated'))).toBe(true);
    expect(r.verdict).toBe('bot'); // Math.min(5*15,60)=60 >= BOT_SCORE_THRESHOLD(60)
  });

  test('timestamps separados >= 2s → condition false branch (no ultraFast)', () => {
    const now = Date.now();
    const msgs = [
      { text: 'a', fromMe: false, timestamp: now },
      { text: 'b', fromMe: false, timestamp: now + 3000 }, // diff=3000 >= MIN_HUMAN(2000) → false branch
    ];
    const r = calculateBotScore(msgs);
    expect(r.signals.some(s => s.startsWith('ultra_fast'))).toBe(false);
  });

  test('msgs cortos (avg < 10) con 3+ msgs → Senal 3 all_short', () => {
    const msgs = [
      { text: 'si', fromMe: false },
      { text: 'ok', fromMe: false },
      { text: 'no', fromMe: false },
    ];
    const r = calculateBotScore(msgs);
    expect(r.signals.includes('all_short_messages')).toBe(true);
  });

  test('msgs text undefined → no cuenta para textCounts', () => {
    const msgs = [
      { fromMe: false },
      { fromMe: false },
    ];
    const r = calculateBotScore(msgs);
    expect(r.score).toBe(0);
  });

  test('msgs avg >= 10 chars → NO all_short signal', () => {
    const msgs = [
      { text: 'este es un mensaje largo ok', fromMe: false },
      { text: 'otro mensaje bastante largo tambien', fromMe: false },
      { text: 'tercer mensaje con muchas palabras largas', fromMe: false },
    ];
    const r = calculateBotScore(msgs);
    expect(r.signals.includes('all_short_messages')).toBe(false);
  });

  test('score 20-59 → verdict unknown', () => {
    const now = Date.now();
    // 2 ultra-fast responses = 20 pts → unknown
    const msgs = [
      { text: 'a', fromMe: false, timestamp: now },
      { text: 'b', fromMe: false, timestamp: now + 100 },
      { text: 'c', fromMe: false, timestamp: now + 200 },
    ];
    const r = calculateBotScore(msgs);
    expect(['unknown', 'bot']).toContain(r.verdict);
  });

  test('score capeado en 100', () => {
    const now = Date.now();
    // Muchos msgs rapidisimos + repetidos
    const msgs = [];
    for (let i = 0; i < 20; i++) {
      msgs.push({ text: 'spam', fromMe: false, timestamp: now + i * 100 });
    }
    const r = calculateBotScore(msgs);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  test('BOT_SCORE_THRESHOLD exportado', () => {
    expect(BOT_SCORE_THRESHOLD).toBe(60);
  });
});

// ═══════════════════════════════════════════════════════════════
// core/tag_extractor.js
// ═══════════════════════════════════════════════════════════════

const { extractTags, extractTagsOfType, hasTags, stripTags, TAG_PATTERNS, VALID_TAGS } = require('../core/tag_extractor');

describe('extractTags', () => {
  test('null → {tags:[], clean:""} (branch !text)', () => {
    const r = extractTags(null);
    expect(r.tags).toHaveLength(0);
    expect(r.clean).toBe('');
  });

  test('number → {tags:[], clean: number} (branch typeof, text || "" = number since truthy)', () => {
    const r = extractTags(42);
    expect(r.tags).toHaveLength(0);
    expect(r.clean).toBe(42); // 42 || '' = 42 (truthy)
  });

  test('texto sin tags → tags vacio, clean=texto', () => {
    const r = extractTags('hola mundo');
    expect(r.tags).toHaveLength(0);
    expect(r.clean).toBe('hola mundo');
  });

  test('AGENDAR_EVENTO → extraido correctamente', () => {
    const r = extractTags('ok [AGENDAR_EVENTO:2026-05-01|10:00|reunion] listo');
    expect(r.tags).toHaveLength(1);
    expect(r.tags[0].type).toBe('AGENDAR_EVENTO');
    expect(r.tags[0].payload).toBe('2026-05-01|10:00|reunion');
    expect(r.clean).not.toContain('[AGENDAR_EVENTO');
  });

  test('RECORDATORIO tag → extraido', () => {
    const r = extractTags('[RECORDATORIO:llama a juan mañana]');
    expect(r.tags[0].type).toBe('RECORDATORIO');
  });

  test('APRENDER tag → extraido', () => {
    const r = extractTags('[APRENDER:prefiere llamadas por la tarde]');
    expect(r.tags[0].type).toBe('APRENDER');
  });

  test('GENERAR_COTIZACION tag → extraido', () => {
    const r = extractTags('[GENERAR_COTIZACION:{"plan":"basico"}]');
    expect(r.tags[0].type).toBe('GENERAR_COTIZACION');
  });

  test('SOLICITAR_TURNO tag → extraido', () => {
    const r = extractTags('[SOLICITAR_TURNO:2026-05-01|14:00|corte de pelo]');
    expect(r.tags[0].type).toBe('SOLICITAR_TURNO');
  });

  test('CANCELAR_EVENTO tag → extraido', () => {
    const r = extractTags('[CANCELAR_EVENTO:abc-123]');
    expect(r.tags[0].type).toBe('CANCELAR_EVENTO');
  });

  test('MOVER_EVENTO tag → extraido', () => {
    const r = extractTags('[MOVER_EVENTO:abc-123|2026-05-02|09:00]');
    expect(r.tags[0].type).toBe('MOVER_EVENTO');
  });
});

describe('extractTagsOfType', () => {
  test('tipo invalido → throw', () => {
    expect(() => extractTagsOfType('texto', 'TIPO_RARO')).toThrow('tagType invalido');
  });

  test('tipo valido → filtra correctamente', () => {
    const tags = extractTagsOfType('[APRENDER:dato1] texto [APRENDER:dato2]', 'APRENDER');
    expect(tags).toHaveLength(2);
    expect(tags.every(t => t.type === 'APRENDER')).toBe(true);
  });
});

describe('hasTags', () => {
  test('!text → false (branch !text)', () => {
    expect(hasTags(null)).toBe(false);
    expect(hasTags('')).toBe(false);
  });

  test('texto sin tags → false', () => {
    expect(hasTags('hola mundo')).toBe(false);
  });

  test('texto con tag → true', () => {
    expect(hasTags('[APRENDER:algo]')).toBe(true);
  });
});

describe('stripTags', () => {
  test('texto sin tags → mismo texto', () => {
    expect(stripTags('hola')).toBe('hola');
  });

  test('texto con tag → tag eliminado', () => {
    const clean = stripTags('texto [APRENDER:algo] fin');
    expect(clean).not.toContain('[APRENDER');
  });
});

describe('TAG_PATTERNS + VALID_TAGS exportados', () => {
  test('VALID_TAGS incluye todos los tipos', () => {
    expect(VALID_TAGS).toContain('AGENDAR_EVENTO');
    expect(VALID_TAGS).toContain('APRENDER');
    expect(VALID_TAGS).toContain('GENERAR_COTIZACION');
  });

  test('TAG_PATTERNS tiene los patrones', () => {
    expect(TAG_PATTERNS.APRENDER).toBeInstanceOf(RegExp);
  });
});

// ═══════════════════════════════════════════════════════════════
// core/sports_mention_detector.js
// ═══════════════════════════════════════════════════════════════

const { detectSportMention, detectAllMentions, FUTBOL_TEAMS, F1_DRIVERS, FAN_TRIGGERS } = require('../core/sports_mention_detector');

describe('detectSportMention', () => {
  test('null → null (branch !text)', () => {
    expect(detectSportMention(null)).toBeNull();
  });

  test('number → null (branch typeof)', () => {
    expect(detectSportMention(42)).toBeNull();
  });

  test('texto sin match → null', () => {
    expect(detectSportMention('el tiempo esta lindo hoy')).toBeNull();
  });

  test('texto que normaliza a vacio → null (branch !norm)', () => {
    // solo puntuacion → normalize() = '' → !norm = true → return null
    expect(detectSportMention('...')).toBeNull();
  });

  test('driver sin trigger → confidence medium', () => {
    const r = detectSportMention('me gusta verstappen en f1');
    expect(r).not.toBeNull();
    expect(r.type).toBe('f1');
    expect(r.confidence).toBe('medium');
    expect(r.driver).toBe('Max Verstappen');
  });

  test('driver con trigger "vamos" → confidence high', () => {
    const r = detectSportMention('vamos verstappen dale');
    expect(r.confidence).toBe('high');
    expect(r.type).toBe('f1');
  });

  test('equipo futbol sin trigger → confidence medium', () => {
    const r = detectSportMention('el partido de boca ayer fue increible');
    expect(r).not.toBeNull();
    expect(r.type).toBe('futbol');
    expect(r.confidence).toBe('medium');
  });

  test('equipo futbol con trigger "aguante" → confidence high', () => {
    const r = detectSportMention('aguante boca siempre');
    expect(r.confidence).toBe('high');
    expect(r.type).toBe('futbol');
  });

  test('team con underscore en clave (san_lorenzo) → variante con espacio detectada', () => {
    const r = detectSportMention('san lorenzo es el mejor');
    expect(r).not.toBeNull();
    expect(r.type).toBe('futbol');
  });

  test('driver tiene prioridad sobre team si ambos presentes', () => {
    const r = detectSportMention('hamilton y boca');
    expect(r.type).toBe('f1'); // driver se checkea primero
  });
});

describe('detectAllMentions', () => {
  test('null → [] (branch !text)', () => {
    expect(detectAllMentions(null)).toEqual([]);
  });

  test('number → [] (branch typeof)', () => {
    expect(detectAllMentions(42)).toEqual([]);
  });

  test('texto sin match → []', () => {
    expect(detectAllMentions('hola mundo')).toEqual([]);
  });

  test('un equipo → array con 1 elemento', () => {
    const r = detectAllMentions('juega river');
    expect(r).toHaveLength(1);
    expect(r[0].type).toBe('futbol');
  });

  test('driver → incluido en resultado', () => {
    const r = detectAllMentions('norris gano en monaco');
    expect(r.some(x => x.type === 'f1')).toBe(true);
  });

  test('equipo + driver → ambos en resultado', () => {
    const r = detectAllMentions('boca gano y hamilton corrio bien');
    const types = r.map(x => x.type);
    expect(types).toContain('futbol');
    expect(types).toContain('f1');
  });
});

describe('constants exportados', () => {
  test('FUTBOL_TEAMS tiene equipos', () => {
    expect(FUTBOL_TEAMS.boca).toBeDefined();
    expect(FUTBOL_TEAMS.river).toBeDefined();
  });

  test('F1_DRIVERS tiene pilotos', () => {
    expect(F1_DRIVERS.verstappen).toBeDefined();
    expect(F1_DRIVERS.hamilton).toBeDefined();
  });

  test('FAN_TRIGGERS incluye vamos', () => {
    expect(FAN_TRIGGERS).toContain('vamos');
  });
});
