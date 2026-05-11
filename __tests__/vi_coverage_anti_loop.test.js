'use strict';

/**
 * VI-BACKEND-COVERAGE: core/anti_loop_input.js + core/sentiment_analyzer.js — 100% branches
 */

// ═══════════════════════════════════════════════════════════════
// core/anti_loop_input.js
// ═══════════════════════════════════════════════════════════════

const {
  shouldRegenerate, recordInput, cleanupStale, getStats,
  normalizeForCompare, tokenSimilarity,
  WINDOW_MS, SIMILARITY_THRESHOLD, MAX_BUFFER_PER_PHONE,
  _resetForTests,
} = require('../core/anti_loop_input');

beforeEach(() => _resetForTests());

describe('normalizeForCompare', () => {
  test('null → "" (branch !text)', () => {
    expect(normalizeForCompare(null)).toBe('');
  });

  test('number → "" (branch typeof)', () => {
    expect(normalizeForCompare(42)).toBe('');
  });

  test('texto con acentos → normalizado', () => {
    const r = normalizeForCompare('Hóla MUNDO');
    expect(r).toBe('hola mundo');
  });

  test('puntuacion eliminada → colapsada a espacio unico', () => {
    const r = normalizeForCompare('hola!!!mundo???');
    expect(r).toBe('hola mundo'); // !!! → spaces → collapsed to 1 space
  });

  test('espacios multiples colapsados', () => {
    const r = normalizeForCompare('a   b   c');
    expect(r).toBe('a b c');
  });
});

describe('tokenSimilarity', () => {
  test('normA falsy → 0 (branch !normA)', () => {
    expect(tokenSimilarity('', 'hola')).toBe(0);
  });

  test('normB falsy → 0 (branch !normB)', () => {
    expect(tokenSimilarity('hola', '')).toBe(0);
  });

  test('normA === normB → 1 (exact match branch)', () => {
    expect(tokenSimilarity('hola mundo', 'hola mundo')).toBe(1);
  });

  test('tokensA.size = 0 → 0 (branch size === 0)', () => {
    // texto que colapsa a '' despues de split — no posible normalmente, pero
    // el branch cubre tokensA.size===0 via spaces only
    expect(tokenSimilarity('   ', 'hola')).toBe(0);
  });

  test('tokensB.size = 0 → 0', () => {
    expect(tokenSimilarity('hola', '   ')).toBe(0);
  });

  test('sin tokens en comun → 0', () => {
    expect(tokenSimilarity('hola', 'mundo')).toBe(0);
  });

  test('similitud parcial → valor entre 0 y 1', () => {
    const r = tokenSimilarity('hola mundo', 'hola tierra');
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });
});

describe('shouldRegenerate — branches', () => {
  test('!uid → regenerate=true, reason=invalid_args (branch !uid)', () => {
    const r = shouldRegenerate('', 'phone', 'input');
    expect(r.regenerate).toBe(true);
    expect(r.reason).toBe('invalid_args');
  });

  test('!phone → regenerate=true, reason=invalid_args (branch !phone)', () => {
    const r = shouldRegenerate('uid', '', 'input');
    expect(r.regenerate).toBe(true);
    expect(r.reason).toBe('invalid_args');
  });

  test('input vacio → reason=empty_input (branch !norm)', () => {
    const r = shouldRegenerate('uid1', '+123', '');
    expect(r.regenerate).toBe(true);
    expect(r.reason).toBe('empty_input');
  });

  test('input muy corto (< 3 chars) → reason=short_input', () => {
    const r = shouldRegenerate('uid1', '+123', 'ok');
    expect(r.regenerate).toBe(true);
    expect(r.reason).toBe('short_input');
  });

  test('input nuevo sin historial → novel_input', () => {
    const r = shouldRegenerate('uid1', '+123', 'hola como estas hoy');
    expect(r.regenerate).toBe(true);
    expect(r.reason).toBe('novel_input');
  });

  test('input exacto repetido → exact_repeat (branch hash match)', () => {
    recordInput('uid1', '+123', 'mismo mensaje exacto aqui');
    const r = shouldRegenerate('uid1', '+123', 'mismo mensaje exacto aqui');
    expect(r.regenerate).toBe(false);
    expect(r.reason).toBe('exact_repeat');
    expect(r.similarity).toBe(1);
  });

  test('input similar ≥95% → high_similarity (branch lines 141-144)', () => {
    // 20 vs 21 tokens: sim = 20/max(20,21) = 20/21 ≈ 0.952 >= SIMILARITY_THRESHOLD(0.95)
    const base = 'uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciseis diecisiete dieciocho diecinueve veinte';
    const similar = base + ' veintiuno'; // 21 tokens vs 20 → sim=20/21≈0.952
    recordInput('uid1', '+123', similar);
    const r = shouldRegenerate('uid1', '+123', base);
    expect(r.regenerate).toBe(false);
    expect(r.reason).toBe('high_similarity');
    expect(r.similarity).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });

  test('inputs distintos → novel_input (bestSim < threshold)', () => {
    recordInput('uid1', '+123', 'primer mensaje completamente diferente');
    const r = shouldRegenerate('uid1', '+123', 'segunda consulta sobre el producto');
    // Pueden ser sufficientemente diferentes
    expect(r.regenerate).toBe(true);
    expect(r.reason).toBe('novel_input');
  });
});

describe('recordInput', () => {
  test('!uid → return sin guardar (branch !uid || !phone)', () => {
    recordInput('', '+123', 'texto');
    const stats = getStats();
    expect(stats.tracked_phones).toBe(0);
  });

  test('!phone → return sin guardar', () => {
    recordInput('uid1', '', 'texto');
    expect(getStats().tracked_phones).toBe(0);
  });

  test('input vacio → return sin guardar (branch !norm)', () => {
    recordInput('uid1', '+123', '');
    expect(getStats().tracked_phones).toBe(0);
  });

  test('primer input → crea buffer', () => {
    recordInput('uid1', '+123', 'hola como vas hoy');
    expect(getStats().total_entries).toBe(1);
  });

  test('buffer > MAX_BUFFER → trim a MAX_BUFFER (branch if length > MAX)', () => {
    for (let i = 0; i <= MAX_BUFFER_PER_PHONE; i++) {
      recordInput('uid1', '+123', `mensaje numero ${i} con texto suficiente`);
    }
    // Debe haberse limitado a MAX_BUFFER_PER_PHONE
    const stats = getStats();
    expect(stats.total_entries).toBeLessThanOrEqual(MAX_BUFFER_PER_PHONE);
  });
});

describe('cleanupStale', () => {
  test('sin entries → no error', () => {
    expect(() => cleanupStale()).not.toThrow();
  });

  test('entries frescas → no se eliminan (branch fresh.length === buf.length)', () => {
    recordInput('uid1', '+123', 'mensaje fresco reciente largo');
    cleanupStale();
    expect(getStats().total_entries).toBe(1);
  });

  test('entries expiradas → key eliminada (branch fresh.length === 0)', () => {
    // Insertar entry con ts muy viejo
    const { _inputState } = require('../core/anti_loop_input');
    // Acceder directamente al estado (no es export oficial, usar recordInput + mock ts)
    recordInput('uid-exp', '+999', 'mensaje largo que expira pronto hoy');
    // Simular que expiró manipulando _inputState directamente no es posible sin export
    // Alternativa: mockear Date.now temporalmente
    const origNow = Date.now;
    Date.now = () => origNow() + WINDOW_MS + 1000; // +5min+1s
    cleanupStale();
    Date.now = origNow;
    expect(getStats().tracked_phones).toBe(0);
  });

  test('algunas entries expiradas → key actualizada (branch fresh.length !== buf.length line 185)', () => {
    const origNow = Date.now;
    const T0 = origNow();
    // Guardar entry 1 en T0
    Date.now = () => T0;
    recordInput('uid2', '+888', 'primer mensaje largo suficiente aqui');
    // Guardar entry 2 en T0+1 (1ms mas tarde)
    Date.now = () => T0 + 1;
    recordInput('uid2', '+888', 'segundo mensaje largo suficiente aqui');
    // Llamar cleanup en T0+WINDOW_MS+1: entry1 stale (diff=WINDOW+1>WINDOW), entry2 fresh (diff=WINDOW>= pero no >)
    Date.now = () => T0 + WINDOW_MS + 1;
    cleanupStale();
    // Verificar: key sigue existiendo (fresh.length=1), un entry eliminado
    const stats = getStats();
    Date.now = origNow;
    expect(stats.tracked_phones).toBe(1); // key no borrada
    expect(stats.total_entries).toBe(1);  // solo entry2 queda
  });
});

describe('getStats', () => {
  test('sin datos → tracked_phones=0', () => {
    const s = getStats();
    expect(s.tracked_phones).toBe(0);
    expect(s.total_entries).toBe(0);
    expect(s.window_ms).toBe(WINDOW_MS);
    expect(s.similarity_threshold).toBe(SIMILARITY_THRESHOLD);
    expect(s.max_buffer_per_phone).toBe(MAX_BUFFER_PER_PHONE);
  });

  test('con datos → counts correctos', () => {
    recordInput('uid1', '+123', 'primer mensaje largo aqui');
    recordInput('uid1', '+456', 'segundo mensaje largo aqui');
    const s = getStats();
    expect(s.tracked_phones).toBe(2);
    expect(s.total_entries).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// core/sentiment_analyzer.js
// Uses __setFirestoreForTests(db) hook — no config/firebase require needed
// ═══════════════════════════════════════════════════════════════

const {
  analyzeSentiment, analyzeConversation, SENTIMENTS,
  __setFirestoreForTests,
} = require('../core/sentiment_analyzer');

describe('analyzeSentiment — branches', () => {
  test('null → neutral, score=0 (branch !text)', () => {
    const r = analyzeSentiment(null);
    expect(r.sentiment).toBe('neutral');
    expect(r.score).toBe(0);
    expect(r.signals).toHaveLength(0);
  });

  test('texto urgente → urgent (branch urgentHits.length > 0)', () => {
    const r = analyzeSentiment('necesito esto urgente ya ahora mismo');
    expect(r.sentiment).toBe('urgent');
    expect(r.score).toBe(-10);
  });

  test('texto negativo sin urgente → negative (branch negativeHits > 0)', () => {
    const r = analyzeSentiment('esto es terrible tengo un problema grave');
    expect(r.sentiment).toBe('negative');
    expect(r.score).toBeLessThan(0);
  });

  test('texto positivo sin urgente/negativo → positive (branch positiveHits > 0)', () => {
    const r = analyzeSentiment('muchas gracias excelente servicio perfecto');
    expect(r.sentiment).toBe('positive');
    expect(r.score).toBeGreaterThan(0);
  });

  test('texto neutro → neutral, score=0 (branch all empty)', () => {
    const r = analyzeSentiment('el paquete llego hoy');
    expect(r.sentiment).toBe('neutral');
    expect(r.score).toBe(0);
  });

  test('SENTIMENTS exportado', () => {
    expect(SENTIMENTS).toContain('urgent');
    expect(SENTIMENTS).toContain('negative');
    expect(SENTIMENTS).toContain('positive');
    expect(SENTIMENTS).toContain('neutral');
  });
});

function makeDb(snap) {
  return {
    collection: jest.fn().mockReturnThis(),
    doc: jest.fn().mockReturnThis(),
    get: jest.fn().mockResolvedValue(snap),
  };
}

describe('analyzeSentiment — getDb fallback (branch _db || require)', () => {
  afterEach(() => __setFirestoreForTests(null));

  test('_db=null → require firebase (right branch of _db||) → throws module not found', async () => {
    __setFirestoreForTests(null); // _db = null → getDb fallback
    // config/firebase.js no existe → require throws → analyzeConversation propaga
    await expect(analyzeConversation('uid', '+1')).rejects.toThrow();
  });
});

describe('analyzeConversation — Firestore via __setFirestoreForTests', () => {
  afterEach(() => __setFirestoreForTests(null));

  test('!uid → throw (branch !uid || !phone)', async () => {
    await expect(analyzeConversation('', 'phone')).rejects.toThrow('uid and phone required');
  });

  test('!phone → throw', async () => {
    await expect(analyzeConversation('uid', '')).rejects.toThrow('uid and phone required');
  });

  test('snap con messages → analiza solo mensajes lead', async () => {
    const snap = {
      exists: true,
      data: () => ({
        messages: [
          { role: 'lead', content: 'muchas gracias perfecto' },
          { role: 'agent', content: 'con gusto' },
          { role: 'lead', content: 'terrible problema tengo' },
        ],
      }),
    };
    __setFirestoreForTests(makeDb(snap));
    const r = await analyzeConversation('uid1', '+123');
    expect(r.uid).toBe('uid1');
    expect(r.messageCount).toBe(2); // solo role=lead
  });

  test('snap sin messages key → messages=[] (branch messages || [])', async () => {
    const snap = { exists: true, data: () => ({}) }; // sin messages key
    __setFirestoreForTests(makeDb(snap));
    const r = await analyzeConversation('uid1', '+123');
    expect(r.messageCount).toBe(0);
    expect(r.overall).toBe('neutral');
  });

  test('snap no existe → messages=[] (branch !snap.exists)', async () => {
    const snap = { exists: false };
    __setFirestoreForTests(makeDb(snap));
    const r = await analyzeConversation('uid2', '+456');
    expect(r.messageCount).toBe(0);
  });
});

describe('analyzeConversation — overall ternarios', () => {
  afterEach(() => __setFirestoreForTests(null));

  function setDb(messages) {
    const snap = { exists: true, data: () => ({ messages }) };
    __setFirestoreForTests(makeDb(snap));
  }

  test('mayoria positivos → overall=positive', async () => {
    setDb([
      { role: 'lead', content: 'gracias excelente perfecto bueno bien' },
      { role: 'lead', content: 'genial gracias perfecto muchas' },
    ]);
    const r = await analyzeConversation('uid', '+1');
    expect(r.overall).toBe('positive');
  });

  test('mayoria neutral → overall=neutral', async () => {
    setDb([
      { role: 'lead', content: 'cuando llega el pedido' },
      { role: 'lead', content: 'necesito saber la hora de entrega' },
    ]);
    const r = await analyzeConversation('uid', '+1');
    expect(r.overall).toBe('neutral');
  });

  test('un urgente → overall=urgent', async () => {
    setDb([
      { role: 'lead', content: 'urgente necesito esto ya' },
      { role: 'lead', content: 'gracias muy bien perfecto' },
    ]);
    const r = await analyzeConversation('uid', '+1');
    expect(r.overall).toBe('urgent');
  });

  test('un negativo sin urgente → overall=negative', async () => {
    setDb([
      { role: 'lead', content: 'esto es terrible pesimo horrible' },
      { role: 'lead', content: 'hola como estas' },
    ]);
    const r = await analyzeConversation('uid', '+1');
    expect(r.overall).toBe('negative');
  });
});
