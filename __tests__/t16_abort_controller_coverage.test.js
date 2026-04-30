'use strict';

/**
 * Tests: T16 — AbortController coverage en 11 archivos HIGH risk.
 *
 * Origen: T16 audit 2026-04-29 (13 archivos sin AbortController detectados,
 * 11 implementados HIGH-1+2+3 firmados Wi autoridad delegada).
 *
 * Cobertura: cada archivo modificado debe tener al menos un AbortController/
 * AbortSignal.timeout por cada fetch().
 *
 * Patrones aceptados:
 *   - HIGH-1 (AI adapters): controller + setTimeout abort + clearTimeout
 *   - HIGH-2 (integrations): AbortSignal.timeout(15000) inline
 *   - HIGH-3 (sports/secundarios): AbortSignal.timeout(10000) inline
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..');

const HIGH_1_FILES = [
  'ai/adapters/claude_adapter.js',
  'ai/adapters/openai_adapter.js',
  'ai/adapters/mistral_adapter.js',
  'ai/adapters/groq_adapter.js',
];

const HIGH_2_FILES = [
  'core/instagram_handler.js',
  'integrations/adapters/gmail_integration.js',
  'integrations/adapters/youtube_integration.js',
  'integrations/adapters/spotify_integration.js',
  'voice/tts_engine.js',
];

const HIGH_3_FILES = [
  'sports/adapters/mlb_adapter.js',
  'sports/adapters/f1_adapter.js',
];

function readFile(rel) {
  return fs.readFileSync(path.join(BACKEND_ROOT, rel), 'utf8');
}

function countMatches(text, regex) {
  return (text.match(regex) || []).length;
}

// ════════════════════════════════════════════════════════════════════
// §A — Cobertura cuantitativa: AbortController/AbortSignal por fetch
// ════════════════════════════════════════════════════════════════════

describe('T16 §A — cobertura AbortController por fetch', () => {
  for (const file of [...HIGH_1_FILES, ...HIGH_2_FILES, ...HIGH_3_FILES]) {
    test(`${file} — abort coverage >= fetch count`, () => {
      const src = readFile(file);
      const fetchCount = countMatches(src, /\bfetch\s*\(/g);
      const abortCount = countMatches(src, /AbortController|AbortSignal\.timeout/g);
      expect(abortCount).toBeGreaterThanOrEqual(fetchCount);
    });
  }
});

// ════════════════════════════════════════════════════════════════════
// §B — HIGH-1: patrón gemini_client.js (controller + setTimeout abort)
// ════════════════════════════════════════════════════════════════════

describe('T16 §B — HIGH-1 AI adapters tienen patrón AbortController completo', () => {
  for (const file of HIGH_1_FILES) {
    test(`${file} — tiene controller + setTimeout abort`, () => {
      const src = readFile(file);
      expect(src).toMatch(/new AbortController\(\)/);
      expect(src).toMatch(/controller\.abort\(\)/);
      expect(src).toMatch(/setTimeout/);
      expect(src).toMatch(/signal:\s*controller\.signal/);
      expect(src).toMatch(/T16-FIX HIGH-1/);
    });

    test(`${file} — tiene clearTimeout en happy path Y catch path`, () => {
      const src = readFile(file);
      const clearTimeoutCount = countMatches(src, /clearTimeout/g);
      // Cada fetch debe tener al menos 2 clearTimeouts (warning + abort), x2 (try + catch)
      // Mínimo 4 clearTimeouts para 2 fetches con coverage doble
      expect(clearTimeoutCount).toBeGreaterThanOrEqual(4);
    });
  }
});

// ════════════════════════════════════════════════════════════════════
// §C — HIGH-2: AbortSignal.timeout(15000) inline
// ════════════════════════════════════════════════════════════════════

describe('T16 §C — HIGH-2 integraciones usan AbortSignal.timeout(15000)', () => {
  for (const file of HIGH_2_FILES) {
    test(`${file} — usa AbortSignal.timeout(15000)`, () => {
      const src = readFile(file);
      expect(src).toMatch(/AbortSignal\.timeout\(15000\)/);
    });
  }
});

// ════════════════════════════════════════════════════════════════════
// §D — HIGH-3: AbortSignal.timeout(10000) inline
// ════════════════════════════════════════════════════════════════════

describe('T16 §D — HIGH-3 secundarios usan AbortSignal.timeout(10000)', () => {
  for (const file of HIGH_3_FILES) {
    test(`${file} — usa AbortSignal.timeout(10000)`, () => {
      const src = readFile(file);
      expect(src).toMatch(/AbortSignal\.timeout\(10000\)/);
    });

    test(`${file} — NO usa { timeout } legacy node-fetch v2`, () => {
      const src = readFile(file);
      // El patron viejo `{ timeout: 10000 }` no funciona en Node fetch nativo
      // Debe haber sido reemplazado por { signal: AbortSignal.timeout(10000) }
      expect(src).not.toMatch(/fetch\([^)]+,\s*\{\s*timeout:\s*\d+\s*\}\s*\)/);
    });
  }
});

// ════════════════════════════════════════════════════════════════════
// §E — Comentario de trazabilidad T16-FIX presente
// ════════════════════════════════════════════════════════════════════

describe('T16 §E — comentarios de trazabilidad', () => {
  for (const file of HIGH_1_FILES) {
    test(`${file} — comentario T16-FIX HIGH-1 presente`, () => {
      const src = readFile(file);
      expect(src).toMatch(/T16-FIX HIGH-1/);
    });
  }

  for (const file of HIGH_2_FILES) {
    test(`${file} — comentario T16-FIX HIGH-2 presente`, () => {
      const src = readFile(file);
      expect(src).toMatch(/T16-FIX HIGH-2/);
    });
  }

  for (const file of HIGH_3_FILES) {
    test(`${file} — comentario T16-FIX HIGH-3 presente`, () => {
      const src = readFile(file);
      expect(src).toMatch(/T16-FIX HIGH-3/);
    });
  }
});
