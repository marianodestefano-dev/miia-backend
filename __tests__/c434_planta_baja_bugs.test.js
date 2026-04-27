/**
 * Tests: C-434 Top 2 bugs prod Planta Baja (§6.19 + §6.21).
 *
 * §A — Bug §6.19 cache contactTypes invalidation TTL 30 días.
 *      Cierra bypass histórico bloqueo precautorio C-004 (incidente bot
 *      Coordinadora 2026-04-14, contactos pre-fix nunca pasaban por guard).
 *
 * §B — Bug §6.21 anti-loop por similarity input contacto (Jaccard trigrams).
 *      Complementa loopWatcher §6.20 (volumen out) detectando inputs repetidos
 *      del bot externo que generan respuestas variadas Gemini.
 *
 * Origen: C-434 [FIRMADO_VIVO_PLAN_PLANTA_BAJA_2026-04-27] anchor +
 * cita verbatim Mariano "autoridad amplia para Planta Baja: bugs + ...".
 */

'use strict';

const tmh = require('../whatsapp/tenant_message_handler');
const {
  isContactTypeStale,
  recordContactTypeFresh,
  isInputLoop,
  recordInput,
  CONTACT_TYPE_TTL_MS,
  LOOP_INPUT_WINDOW_MS,
  LOOP_INPUT_SIMILARITY_THRESHOLD,
} = tmh;

describe('C-434 §A — Bug §6.19 cache contactTypes TTL 30d', () => {
  test('A.1 — ctx sin contactTypesMeta inicializado → isContactTypeStale=true (forzar re-classify)', () => {
    const ctx = {};
    expect(isContactTypeStale(ctx, '5491100000000@s.whatsapp.net')).toBe(true);
  });

  test('A.2 — entry sin timestamp (legacy migration) → stale=true (re-classify primer touch)', () => {
    const ctx = { contactTypesMeta: {} };
    expect(isContactTypeStale(ctx, '5491100000000@s.whatsapp.net')).toBe(true);
  });

  test('A.3 — entry con timestamp reciente (<30d) → stale=false', () => {
    const ctx = { contactTypesMeta: { '5491100000000@s.whatsapp.net': Date.now() - 1000 * 60 * 60 } }; // 1h
    expect(isContactTypeStale(ctx, '5491100000000@s.whatsapp.net')).toBe(false);
  });

  test('A.4 — entry con timestamp >30d → stale=true (TTL expirado)', () => {
    const ctx = {
      contactTypesMeta: {
        '5491100000000@s.whatsapp.net': Date.now() - (CONTACT_TYPE_TTL_MS + 1000),
      },
    };
    expect(isContactTypeStale(ctx, '5491100000000@s.whatsapp.net')).toBe(true);
  });

  test('A.5 — recordContactTypeFresh setea timestamp + inicializa meta si falta', () => {
    const ctx = {};
    recordContactTypeFresh(ctx, '5491100000000@s.whatsapp.net');
    expect(ctx.contactTypesMeta).toBeDefined();
    expect(typeof ctx.contactTypesMeta['5491100000000@s.whatsapp.net']).toBe('number');
    // Después de recordContactTypeFresh, ya NO es stale
    expect(isContactTypeStale(ctx, '5491100000000@s.whatsapp.net')).toBe(false);
  });

  test('A.6 — meta con timestamp inválido (string) → stale=true (defensivo)', () => {
    const ctx = { contactTypesMeta: { '5491100000000@s.whatsapp.net': '2026-04-27' } };
    expect(isContactTypeStale(ctx, '5491100000000@s.whatsapp.net')).toBe(true);
  });
});

describe('C-434 §B — Bug §6.21 anti-loop por similarity input', () => {
  test('B.1 — buffer vacío → isInputLoop=false', () => {
    const ctx = {};
    expect(isInputLoop(ctx, '5491100000000@s.whatsapp.net', 'hola, agendo una cita')).toBe(false);
  });

  test('B.2 — input idéntico dentro de ventana 5min → match exact', () => {
    const ctx = {};
    recordInput(ctx, '5491100000000@s.whatsapp.net', 'hola, agendo una cita');
    const result = isInputLoop(ctx, '5491100000000@s.whatsapp.net', 'hola, agendo una cita');
    expect(result).toMatchObject({ match: 'exact' });
    expect(typeof result.age_ms).toBe('number');
  });

  test('B.3 — input similar 95%+ (Jaccard trigrams) dentro de ventana → match similar', () => {
    const ctx = {};
    recordInput(ctx, '5491100000000@s.whatsapp.net', 'estimado paciente, le confirmamos su turno para el lunes');
    const similar = 'estimado paciente, le confirmamos su turno para el lunes.'; // solo punto extra
    const result = isInputLoop(ctx, '5491100000000@s.whatsapp.net', similar);
    expect(result).toBeTruthy();
    expect(['exact', 'similar']).toContain(result.match);
  });

  test('B.4 — input claramente distinto (<95% similarity) → false', () => {
    const ctx = {};
    recordInput(ctx, '5491100000000@s.whatsapp.net', 'hola, agendo una cita para el lunes');
    const distinct = 'gracias por la atencion, hasta pronto';
    expect(isInputLoop(ctx, '5491100000000@s.whatsapp.net', distinct)).toBe(false);
  });

  test('B.5 — input idéntico FUERA de ventana 5min → false', () => {
    const ctx = {
      lastInputs: {
        '5491100000000@s.whatsapp.net': [
          { text: 'hola', ts: Date.now() - (LOOP_INPUT_WINDOW_MS + 1000) },
        ],
      },
    };
    expect(isInputLoop(ctx, '5491100000000@s.whatsapp.net', 'hola')).toBe(false);
  });

  test('B.6 — recordInput trunca buffer a 5 entries FIFO', () => {
    const ctx = {};
    for (let i = 0; i < 10; i++) {
      recordInput(ctx, '5491100000000@s.whatsapp.net', `msg ${i}`);
    }
    expect(ctx.lastInputs['5491100000000@s.whatsapp.net'].length).toBe(5);
    // Solo queda los últimos 5 (msg 5-9)
    const texts = ctx.lastInputs['5491100000000@s.whatsapp.net'].map(e => e.text);
    expect(texts).toEqual(['msg 5', 'msg 6', 'msg 7', 'msg 8', 'msg 9']);
  });

  test('B.7 — phones diferentes tienen buffers separados', () => {
    const ctx = {};
    recordInput(ctx, 'phone-a', 'hola');
    recordInput(ctx, 'phone-b', 'chau');
    expect(isInputLoop(ctx, 'phone-a', 'hola')).toMatchObject({ match: 'exact' });
    expect(isInputLoop(ctx, 'phone-b', 'hola')).toBe(false);
    expect(isInputLoop(ctx, 'phone-a', 'chau')).toBe(false);
  });

  test('B.8 — threshold 0.95 documentado coincide con LOOP_INPUT_SIMILARITY_THRESHOLD', () => {
    expect(LOOP_INPUT_SIMILARITY_THRESHOLD).toBe(0.95);
  });
});
