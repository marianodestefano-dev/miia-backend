'use strict';

const {
  reloadConfig, getConfig, contactAllows, resetCounters, clearCache,
  DEFAULTS, __setFirestoreForTests: setRateDb,
} = require('../core/owner_rate_limiter');

const {
  shouldRegenerate, recordInput, cleanupStale, getStats,
  normalizeForCompare, tokenSimilarity,
  WINDOW_MS, SIMILARITY_THRESHOLD, MAX_BUFFER_PER_PHONE,
  _resetForTests,
} = require('../core/anti_loop_input');

const UID = 'uid_t330';
const PHONE = '+571111222';

function makeOwnerDb(rateLimits = null) {
  return {
    collection: (col) => ({
      doc: (docId) => ({
        get: async () => {
          if (rateLimits) return { exists: true, data: () => ({ rateLimits }) };
          return { exists: false };
        },
      }),
    }),
  };
}

describe('T330 -- owner_rate_limiter + anti_loop_input (28 tests)', () => {

  beforeEach(() => {
    clearCache();
    _resetForTests();
  });

  // DEFAULTS
  test('DEFAULTS frozen', () => {
    expect(() => { DEFAULTS.perContact = 99; }).toThrow();
  });

  test('DEFAULTS: perContact=5, perTenant=50, windowSecs=30', () => {
    expect(DEFAULTS.perContact).toBe(5);
    expect(DEFAULTS.perTenant).toBe(50);
    expect(DEFAULTS.windowSecs).toBe(30);
  });

  // reloadConfig
  test('reloadConfig: uid null lanza', async () => {
    await expect(reloadConfig(null)).rejects.toThrow('uid requerido');
  });

  test('reloadConfig: sin config en Firestore usa DEFAULTS', async () => {
    setRateDb(makeOwnerDb(null));
    const cfg = await reloadConfig(UID);
    expect(cfg.perContact).toBe(5);
    expect(cfg.windowSecs).toBe(30);
  });

  test('reloadConfig: config custom sobreescribe defaults', async () => {
    setRateDb(makeOwnerDb({ perContact: 3, windowSecs: 60 }));
    const cfg = await reloadConfig(UID);
    expect(cfg.perContact).toBe(3);
    expect(cfg.windowSecs).toBe(60);
    expect(cfg.perTenant).toBe(50); // default no sobreescrito
  });

  test('reloadConfig: Firestore error -> defaults sin crash', async () => {
    const brokenDb = { collection: () => { throw new Error('down'); } };
    setRateDb(brokenDb);
    const cfg = await reloadConfig(UID);
    expect(cfg.perContact).toBe(5);
  });

  // getConfig
  test('getConfig: uid sin cache -> defaults', () => {
    const cfg = getConfig('uid_nuevo');
    expect(cfg.perContact).toBe(5);
  });

  test('getConfig: uid con cache -> config cargada', async () => {
    setRateDb(makeOwnerDb({ perContact: 2 }));
    await reloadConfig(UID);
    const cfg = getConfig(UID);
    expect(cfg.perContact).toBe(2);
  });

  // contactAllows
  test('contactAllows: uid/phone null -> allowed=false', () => {
    const r = contactAllows(null, PHONE);
    expect(r.allowed).toBe(false);
  });

  test('contactAllows: primer mensaje -> allowed=true', () => {
    const r = contactAllows(UID, PHONE);
    expect(r.allowed).toBe(true);
  });

  test('contactAllows: despues de perContact msgs -> bloqueado', () => {
    const NOW = Date.now();
    for (let i = 0; i < 5; i++) contactAllows(UID, PHONE, NOW + i);
    const r = contactAllows(UID, PHONE, NOW + 5);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('contact_rate_exceeded');
  });

  test('contactAllows: mensajes viejos (fuera de ventana) no cuentan', () => {
    const OLD = Date.now() - 40000; // 40s atras (ventana 30s)
    for (let i = 0; i < 5; i++) contactAllows(UID, PHONE, OLD + i);
    // Ahora en tiempo actual: ventana vencida, debería permitir
    const r = contactAllows(UID, PHONE, Date.now());
    expect(r.allowed).toBe(true);
  });

  // resetCounters
  test('resetCounters: limpia contadores del uid', () => {
    const NOW = Date.now();
    for (let i = 0; i < 5; i++) contactAllows(UID, PHONE, NOW + i);
    resetCounters(UID);
    const r = contactAllows(UID, PHONE, NOW + 10);
    expect(r.allowed).toBe(true);
  });

  // anti_loop_input constants
  test('WINDOW_MS = 5min', () => {
    expect(WINDOW_MS).toBe(5 * 60 * 1000);
  });

  test('SIMILARITY_THRESHOLD = 0.95', () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.95);
  });

  test('MAX_BUFFER_PER_PHONE = 5', () => {
    expect(MAX_BUFFER_PER_PHONE).toBe(5);
  });

  // normalizeForCompare
  test('normalizeForCompare: lowercase + strip accents', () => {
    expect(normalizeForCompare('Hólá Múndo')).toBe('hola mundo');
  });

  test('normalizeForCompare: null retorna ""', () => {
    expect(normalizeForCompare(null)).toBe('');
  });

  // tokenSimilarity
  test('tokenSimilarity: textos identicos = 1', () => {
    expect(tokenSimilarity('hola mundo', 'hola mundo')).toBe(1);
  });

  test('tokenSimilarity: sin palabras comun = 0', () => {
    expect(tokenSimilarity('gato azul', 'perro rojo')).toBe(0);
  });

  test('tokenSimilarity: parcial entre 0 y 1', () => {
    const r = tokenSimilarity('hola mundo que tal', 'hola mundo bien');
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });

  // shouldRegenerate
  test('shouldRegenerate: input nuevo -> regenerate=true', () => {
    const r = shouldRegenerate(UID, PHONE, 'Hola, me interesa el servicio');
    expect(r.regenerate).toBe(true);
    expect(r.reason).toBe('novel_input');
  });

  test('shouldRegenerate: input repetido exacto -> regenerate=false', () => {
    recordInput(UID, PHONE, 'PROMO ESPECIAL');
    const r = shouldRegenerate(UID, PHONE, 'PROMO ESPECIAL');
    expect(r.regenerate).toBe(false);
    expect(r.reason).toBe('exact_repeat');
    expect(r.similarity).toBe(1);
  });

  test('shouldRegenerate: input muy corto (<3 chars) siempre regenera', () => {
    recordInput(UID, PHONE, 'si');
    const r = shouldRegenerate(UID, PHONE, 'si');
    expect(r.regenerate).toBe(true);
    expect(r.reason).toBe('short_input');
  });

  test('shouldRegenerate: uid/phone null -> regenerate=true (invalid_args)', () => {
    const r = shouldRegenerate(null, PHONE, 'hola');
    expect(r.regenerate).toBe(true);
    expect(r.reason).toBe('invalid_args');
  });

  // recordInput + getStats
  test('recordInput + getStats: tracked_phones incrementa', () => {
    recordInput(UID, PHONE, 'mensaje de prueba');
    const stats = getStats();
    expect(stats.tracked_phones).toBeGreaterThan(0);
    expect(stats.total_entries).toBeGreaterThan(0);
  });

  // cleanupStale
  test('cleanupStale: no crash con state vacio', () => {
    expect(() => cleanupStale()).not.toThrow();
  });
});
