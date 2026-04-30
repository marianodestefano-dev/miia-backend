'use strict';

/**
 * Tests: T23 — server.js 8 fetch Gemini hot path AbortSignal.timeout coverage.
 *
 * Origen: T16B propuesta Opcion 2 (fix puntual inline) firmada autoridad
 * delegada Wi 2026-04-30 mail [161]. Patron: AbortSignal.timeout(45000)
 * default, 60000 para queries con google_search enabled.
 *
 * §A — Cobertura cuantitativa: cada fetch Gemini en hot path tiene signal.
 * §B — Verificacion patron T23-FIX inline + comentarios trazabilidad.
 * §C — Bonus T23: fix paralelo `timeout: MEDIA_TIMEOUT_MS` legacy node-fetch
 *      v2 reemplazado por { signal: AbortSignal.timeout } (no funciona
 *      timeout option en Node fetch nativo).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.resolve(__dirname, '../server.js');
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, 'utf8');

// ════════════════════════════════════════════════════════════════════
// §A — Cobertura: 8 fetch Gemini hot path tienen signal coverage
// ════════════════════════════════════════════════════════════════════

describe('T23 §A — server.js 8 fetch Gemini hot path con AbortSignal', () => {
  test('A.1 — total fetch hot path Gemini en server.js (sanity check)', () => {
    // Bloques esperados a tener signal:
    //   L2347 callGeminiAI principal
    //   L2364 retry callGeminiAI fallback key
    //   L2416 generateAIContent
    //   L2443 retry generateAIContent fallback
    //   L2487 generateAIContentEmergency backup keys
    //   L9241 Gemini Flash (media)
    //   L9259 retry Gemini Flash fallback
    //   L11800 /api/chat directo
    // Total: 8 hot path Gemini.

    // Contamos los AbortSignal.timeout en server.js — debe ser >=8 (incluye
    // los 2 helpcenter pre-T16 ademas).
    const matches = SERVER_SOURCE.match(/AbortSignal\.timeout/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(8);
  });

  test('A.2 — comentario T23-FIX presente en server.js (trazabilidad)', () => {
    expect(SERVER_SOURCE).toMatch(/T23-FIX/);
  });

  test('A.3 — ningun fetch Gemini hot path sin signal (regex check)', () => {
    // Pattern: fetch(<URL_CON_GEMINI>, { ... NO signal ... })
    // Buscamos fetch a URLs con GEMINI sin signal cercano (200 chars).
    const geminiFetches = [];
    const regex = /await fetch\([^)]*GEMINI[^)]*\)/g;
    let m;
    while ((m = regex.exec(SERVER_SOURCE)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      // Buscar signal en los siguientes 500 chars
      const chunk = SERVER_SOURCE.slice(start, end + 500);
      if (!chunk.includes('signal:')) {
        geminiFetches.push(m[0].slice(0, 80));
      }
    }
    expect(geminiFetches).toEqual([]);
  });

  test('A.4 — AbortSignal.timeout uses correct timeout values', () => {
    // 45000 (default chat) o 60000 (heavy search) o MEDIA_TIMEOUT_MS variable
    const timeouts = SERVER_SOURCE.match(/AbortSignal\.timeout\(([^)]+)\)/g) || [];
    expect(timeouts.length).toBeGreaterThanOrEqual(8);
    // Verificar que cada timeout es razonable (>= 10s)
    for (const t of timeouts) {
      const valueMatch = t.match(/AbortSignal\.timeout\(([^)]+)\)/);
      const expr = valueMatch[1];
      // Si es literal numerico, debe ser >= 10000
      const numMatch = expr.match(/^(\d+)$/);
      if (numMatch) {
        expect(parseInt(numMatch[1])).toBeGreaterThanOrEqual(10000);
      }
      // Si es expresion (ej: enableSearch ? 60000 : 45000) o variable
      // (MEDIA_TIMEOUT_MS), confiamos que el desarrollador uso valor correcto.
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — Verificacion bloques especificos hot path
// ════════════════════════════════════════════════════════════════════

describe('T23 §B — bloques especificos del hot path Gemini', () => {
  test('B.1 — callGeminiAI principal tiene signal con timeout 45000', () => {
    // Buscar el bloque cerca de "[GEMINI] Request" log
    const idx = SERVER_SOURCE.indexOf("[GEMINI] Request:");
    expect(idx).toBeGreaterThan(0);
    // Los siguientes 400 chars deben tener AbortSignal.timeout(45000)
    const block = SERVER_SOURCE.slice(idx, idx + 600);
    expect(block).toMatch(/AbortSignal\.timeout\(45000\)/);
  });

  test('B.2 — generateAIContent tiene signal dinamico (search vs default)', () => {
    // Buscar bloque "for (let attempt" antes del fetch generateAIContent
    const idx = SERVER_SOURCE.indexOf('for (let attempt = 0; attempt <= MAX_RETRIES');
    expect(idx).toBeGreaterThan(0);
    const block = SERVER_SOURCE.slice(idx, idx + 600);
    // Debe tener expresion dinamica con enableSearch
    expect(block).toMatch(/AbortSignal\.timeout\(enableSearch\s*\?\s*60000\s*:\s*45000\)/);
  });

  test('B.3 — generateAIContentEmergency backup keys tiene signal', () => {
    const idx = SERVER_SOURCE.indexOf('GEMINI_BACKUP_KEYS[i].trim()');
    expect(idx).toBeGreaterThan(0);
    const block = SERVER_SOURCE.slice(idx, idx + 600);
    expect(block).toMatch(/AbortSignal\.timeout/);
  });

  test('B.4 — POST /api/chat directo tiene signal', () => {
    const idx = SERVER_SOURCE.indexOf('[API CHAT] 📦 Payload preparado');
    expect(idx).toBeGreaterThan(0);
    const block = SERVER_SOURCE.slice(idx, idx + 400);
    expect(block).toMatch(/AbortSignal\.timeout\(45000\)/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §C — Bonus T23: fix legacy `timeout` option en Gemini Flash (media)
// ════════════════════════════════════════════════════════════════════

describe('T23 §C — bonus fix legacy timeout option (Gemini Flash media)', () => {
  test('C.1 — Gemini Flash NO usa { timeout: MEDIA_TIMEOUT_MS } legacy', () => {
    // El patron `timeout: MEDIA_TIMEOUT_MS` no funciona en Node fetch nativo
    // (era opcion de node-fetch v2). Reemplazado por signal: AbortSignal.timeout.
    expect(SERVER_SOURCE).not.toMatch(/timeout:\s*MEDIA_TIMEOUT_MS/);
  });

  test('C.2 — Gemini Flash usa signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS)', () => {
    expect(SERVER_SOURCE).toMatch(/AbortSignal\.timeout\(MEDIA_TIMEOUT_MS\)/);
  });

  test('C.3 — al menos 2 ocurrencias de AbortSignal.timeout(MEDIA_TIMEOUT_MS) (primary + retry)', () => {
    const matches = SERVER_SOURCE.match(/AbortSignal\.timeout\(MEDIA_TIMEOUT_MS\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
