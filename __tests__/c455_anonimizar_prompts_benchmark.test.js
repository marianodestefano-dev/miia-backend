/**
 * Tests: C-455-ANONIMIZAR-PROMPTS-BENCHMARK — verifica que los nombres
 * reales de familia Mariano (Ale, Silvia) hayan sido reemplazados por
 * placeholders genericos (Laura, Maria) en scripts/benchmark/prompts.js.
 *
 * Origen: ITER 2 RRC-VI-001 candidata C-455. APROBADO Wi autoridad
 * delegada 2026-04-28.
 *
 * Fix: sed in-place replace
 *   Ale -> Laura
 *   Silvia -> Maria
 *
 * Ancla: Wi 2026-04-22 + confirmacion Mariano 2026-04-22 (ambos reales).
 *
 * Razon: pre-apertura repo a segundo dev / portfolio / inversor due-
 * diligence. Casos T1 OWNER_CHAT + T3 AUDITOR siguen funcionalmente
 * validos (dependen de estructura conversacion, no nombres especificos).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PROMPTS_PATH = path.resolve(__dirname, '../scripts/benchmark/prompts.js');
const SOURCE = fs.readFileSync(PROMPTS_PATH, 'utf8');

describe('C-455-ANONIMIZAR-PROMPTS-BENCHMARK — nombres reales removidos', () => {
  test('A.1 — "Ale" (mayuscula word-boundary) NO existe', () => {
    expect(SOURCE).not.toMatch(/\bAle\b/);
  });

  test('A.2 — "Silvia" NO existe', () => {
    expect(SOURCE).not.toMatch(/\bSilvia\b/);
  });

  test('A.3 — "ale" minuscula word-boundary NO existe (textos user/contexto)', () => {
    expect(SOURCE).not.toMatch(/\bale\b/);
  });

  test('A.4 — "silvia" minuscula NO existe', () => {
    expect(SOURCE).not.toMatch(/\bsilvia\b/);
  });

  test('A.5 — "Laura" placeholder presente (al menos 1 ocurrencia)', () => {
    expect(SOURCE).toMatch(/\bLaura\b/);
  });

  test('A.6 — "Maria" placeholder presente (al menos 1 ocurrencia)', () => {
    expect(SOURCE).toMatch(/\bMaria\b/);
  });

  test('A.7 — modulo carga sin error (sintaxis JS valida)', () => {
    expect(() => {
      delete require.cache[require.resolve('../scripts/benchmark/prompts.js')];
      const mod = require('../scripts/benchmark/prompts.js');
      expect(mod.T1_OWNER_CHAT).toBeDefined();
      expect(mod.T3_AUDITOR).toBeDefined();
      expect(mod.T4_EMBEDDING_TEXT).toBeDefined();
    }).not.toThrow();
  });
});
