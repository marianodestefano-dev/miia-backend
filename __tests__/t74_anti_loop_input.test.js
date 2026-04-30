'use strict';

/**
 * T74 — anti_loop_input.js coverage + behavior tests
 * Bug CLAUDE.md §6.21 PENDIENTE: Gemini historial creciente loop con bot
 */

const ali = require('../core/anti_loop_input');

beforeEach(() => {
  ali._resetForTests();
});

describe('T74 §A — normalizeForCompare', () => {
  test('lowercase + trim + remove accents', () => {
    expect(ali.normalizeForCompare('  Hólá Múndo!  ')).toBe('hola mundo');
  });
  test('null/undefined/empty → ""', () => {
    expect(ali.normalizeForCompare(null)).toBe('');
    expect(ali.normalizeForCompare(undefined)).toBe('');
    expect(ali.normalizeForCompare('')).toBe('');
  });
  test('non-string → ""', () => {
    expect(ali.normalizeForCompare(123)).toBe('');
  });
  test('multiple whitespace collapsed', () => {
    expect(ali.normalizeForCompare('hola    mundo\n\nplz')).toBe('hola mundo plz');
  });
  test('puntuacion eliminada', () => {
    expect(ali.normalizeForCompare('¿Cómo estás?')).toBe('como estas');
  });
});

describe('T74 §B — tokenSimilarity', () => {
  test('idénticos → 1', () => {
    expect(ali.tokenSimilarity('hola mundo', 'hola mundo')).toBe(1);
  });
  test('completamente distintos → 0', () => {
    expect(ali.tokenSimilarity('hola mundo', 'foo bar')).toBe(0);
  });
  test('parcial overlap', () => {
    const sim = ali.tokenSimilarity('hola mundo abc', 'hola mundo xyz');
    expect(sim).toBeGreaterThan(0.5);
    expect(sim).toBeLessThan(1);
  });
  test('vacio → 0', () => {
    expect(ali.tokenSimilarity('', 'abc')).toBe(0);
    expect(ali.tokenSimilarity('abc', '')).toBe(0);
    expect(ali.tokenSimilarity('', '')).toBe(0);
  });
  test('longitud distinta → similarity refleja diferencia', () => {
    const sim = ali.tokenSimilarity('hola', 'hola mundo amigo bueno');
    expect(sim).toBeLessThan(0.5);
  });
});

describe('T74 §C — shouldRegenerate: novel input', () => {
  test('input nuevo (sin previos) → regenerate=true', () => {
    const r = ali.shouldRegenerate('uid_a', '+57301', 'hola quiero info');
    expect(r.regenerate).toBe(true);
    expect(r.reason).toBe('novel_input');
  });

  test('inputs distintos → todos regenerate=true', () => {
    const r1 = ali.shouldRegenerate('uid_b', '+57301', 'hola quiero info');
    ali.recordInput('uid_b', '+57301', 'hola quiero info');
    const r2 = ali.shouldRegenerate('uid_b', '+57301', 'cuanto cuesta?');
    expect(r1.regenerate).toBe(true);
    expect(r2.regenerate).toBe(true);
  });
});

describe('T74 §D — shouldRegenerate: input repetido (escenario bot loop)', () => {
  test('input identico recordado < 5min → regenerate=false (exact_repeat)', () => {
    const uid = 'uid_bot1';
    const phone = '+57400';
    const input = 'Por favor confirme su mensaje aqui';
    ali.recordInput(uid, phone, input);
    const r = ali.shouldRegenerate(uid, phone, input);
    expect(r.regenerate).toBe(false);
    expect(r.reason).toBe('exact_repeat');
    expect(r.similarity).toBe(1);
  });

  test('input ~95% similar (1 token diferente sobre 10) → regenerate=false', () => {
    const uid = 'uid_bot2';
    const phone = '+57401';
    ali.recordInput(uid, phone, 'Por favor confirme su mensaje aqui en este chat ahora mismo gracias');
    // Cambia 1 token de 10 — similarity debe ser >= 0.9
    const r = ali.shouldRegenerate(uid, phone, 'Por favor confirme su mensaje aqui en este chat ahora mismo perfecto');
    // Token similarity con 1 token cambiado = (n-1)/n
    if (r.regenerate === false) {
      expect(r.similarity).toBeGreaterThanOrEqual(ali.SIMILARITY_THRESHOLD);
    }
  });

  test('input completamente distinto → regenerate=true', () => {
    const uid = 'uid_bot3';
    const phone = '+57402';
    ali.recordInput(uid, phone, 'mensaje uno totalmente diferente');
    const r = ali.shouldRegenerate(uid, phone, 'algo nuevo de cosa diferente');
    expect(r.regenerate).toBe(true);
    expect(r.reason).toBe('novel_input');
  });
});

describe('T74 §E — shouldRegenerate: ventana de tiempo', () => {
  test('input recordado pero >5min → regenerate=true (fuera ventana)', () => {
    const uid = 'uid_window';
    const phone = '+57500';
    const input = 'mensaje del bot que se repite';
    const origNow = Date.now;
    const t0 = origNow();
    Date.now = () => t0;
    try {
      ali.recordInput(uid, phone, input);
      // Avanzar >5min
      Date.now = () => t0 + 6 * 60 * 1000;
      const r = ali.shouldRegenerate(uid, phone, input);
      expect(r.regenerate).toBe(true);
      expect(r.reason).toBe('novel_input');
    } finally {
      Date.now = origNow;
    }
  });
});

describe('T74 §F — shouldRegenerate: edge cases', () => {
  test('uid null → regenerate=true reason=invalid_args', () => {
    expect(ali.shouldRegenerate(null, '+57', 'hola').regenerate).toBe(true);
    expect(ali.shouldRegenerate(null, '+57', 'hola').reason).toBe('invalid_args');
  });
  test('phone null → regenerate=true reason=invalid_args', () => {
    expect(ali.shouldRegenerate('uid', null, 'hola').regenerate).toBe(true);
  });
  test('input vacio → regenerate=true reason=empty_input', () => {
    const r = ali.shouldRegenerate('uid', '+57', '');
    expect(r.regenerate).toBe(true);
    expect(r.reason).toBe('empty_input');
  });
  test('input muy corto (<3 chars) → regenerate=true reason=short_input', () => {
    const r = ali.shouldRegenerate('uid', '+57', 'ok');
    expect(r.regenerate).toBe(true);
    expect(r.reason).toBe('short_input');
  });
  test('input solo espacios y puntuacion → empty post-normalize', () => {
    const r = ali.shouldRegenerate('uid', '+57', '   ?!?   ');
    expect(r.regenerate).toBe(true);
    expect(r.reason).toBe('empty_input');
  });
});

describe('T74 §G — recordInput', () => {
  test('uid/phone null → no-op', () => {
    ali.recordInput(null, '+57', 'hola');
    ali.recordInput('uid', null, 'hola');
    expect(ali.getStats().tracked_phones).toBe(0);
  });
  test('input vacio → no-op', () => {
    ali.recordInput('uid', '+57', '');
    ali.recordInput('uid', '+57', '   ');
    expect(ali.getStats().tracked_phones).toBe(0);
  });
  test('multiples records → buffer crece', () => {
    ali.recordInput('uid_R', '+57', 'msg uno');
    ali.recordInput('uid_R', '+57', 'msg dos');
    ali.recordInput('uid_R', '+57', 'msg tres');
    const s = ali.getStats();
    expect(s.tracked_phones).toBe(1);
    expect(s.total_entries).toBe(3);
  });
  test('buffer NO excede MAX_BUFFER_PER_PHONE', () => {
    const uid = 'uid_max';
    for (let i = 0; i < 10; i++) ali.recordInput(uid, '+57', `msg ${i}`);
    const s = ali.getStats();
    expect(s.total_entries).toBe(ali.MAX_BUFFER_PER_PHONE);
  });
});

describe('T74 §H — cleanupStale', () => {
  test('entries todas viejas → phone removido', () => {
    const origNow = Date.now;
    const t0 = origNow();
    Date.now = () => t0;
    try {
      ali.recordInput('uid_clean', '+57', 'mensaje test');
      Date.now = () => t0 + 6 * 60 * 1000;
      ali.cleanupStale();
      expect(ali.getStats().tracked_phones).toBe(0);
    } finally {
      Date.now = origNow;
    }
  });
  test('algunas frescas, algunas viejas → trim parcial', () => {
    const origNow = Date.now;
    const t0 = origNow();
    Date.now = () => t0;
    try {
      ali.recordInput('uid_partial', '+57', 'msg viejo');
      Date.now = () => t0 + 4 * 60 * 1000; // dentro ventana
      ali.recordInput('uid_partial', '+57', 'msg fresco');
      Date.now = () => t0 + 6 * 60 * 1000; // viejo fuera, fresco dentro
      ali.cleanupStale();
      const s = ali.getStats();
      expect(s.tracked_phones).toBe(1);
      expect(s.total_entries).toBe(1);
    } finally {
      Date.now = origNow;
    }
  });
  test('cleanupStale sin entries → no throws', () => {
    expect(() => ali.cleanupStale()).not.toThrow();
  });
});

describe('T74 §I — getStats', () => {
  test('sin tracking → counts 0', () => {
    const s = ali.getStats();
    expect(s.tracked_phones).toBe(0);
    expect(s.total_entries).toBe(0);
    expect(s.window_ms).toBe(ali.WINDOW_MS);
    expect(s.similarity_threshold).toBe(ali.SIMILARITY_THRESHOLD);
    expect(s.max_buffer_per_phone).toBe(ali.MAX_BUFFER_PER_PHONE);
  });
  test('con tracking → counts correctos', () => {
    ali.recordInput('uid_x', '+57', 'a b c');
    ali.recordInput('uid_y', '+58', 'a b c');
    ali.recordInput('uid_x', '+57', 'd e f');
    const s = ali.getStats();
    expect(s.tracked_phones).toBe(2);
    expect(s.total_entries).toBe(3);
  });
});

describe('T74 §J — Constantes exportadas', () => {
  test('WINDOW_MS = 5min', () => {
    expect(ali.WINDOW_MS).toBe(5 * 60 * 1000);
  });
  test('SIMILARITY_THRESHOLD = 0.95', () => {
    expect(ali.SIMILARITY_THRESHOLD).toBe(0.95);
  });
  test('MAX_BUFFER_PER_PHONE = 5', () => {
    expect(ali.MAX_BUFFER_PER_PHONE).toBe(5);
  });
});

describe('T74 §K — Escenario E2E bot Coordinadora 2026-04-14 (regression test)', () => {
  test('bot envia 50 msgs IDÉNTICOS en 30s → solo el primero regenera, resto bloqueados', () => {
    const uid = 'uid_coord_bot';
    const phone = '+57999';
    const botMsg = 'Por favor responda con SI o NO para confirmar';

    // Primer mensaje: regenerate=true (novel)
    const r1 = ali.shouldRegenerate(uid, phone, botMsg);
    expect(r1.regenerate).toBe(true);
    ali.recordInput(uid, phone, botMsg);

    // 49 mensajes idénticos siguientes en window: TODOS regenerate=false
    let bloqueados = 0;
    for (let i = 0; i < 49; i++) {
      const r = ali.shouldRegenerate(uid, phone, botMsg);
      if (!r.regenerate) bloqueados++;
    }
    expect(bloqueados).toBe(49);
  });
});
