/**
 * Tests: C-465-EMPATIA-INTEGRATION — §6 ESTILO CONVERSACIONAL
 * EMPATIA + PROACTIVIDAD integrado a voice_seed_center.md v2.1.
 *
 * Origen: firma viva Mariano 2026-04-28 ~13:15 COT (post C-464 cierre)
 * + revision Vi [REVISION-VI-PROMPT-EMPATIA] 2026-04-28 14:30 COT
 * con sugerencias 1+2 ACEPTADAS por Wi mail [C-465-EMPATIA-INTEGRATION]
 * 2026-04-28 15:09 COT.
 *
 * §6 codifica:
 *   - 6.1 Personalidad base.
 *   - 6.2 Adaptacion dinamica (refuerza P2 NADA HARDCODED).
 *   - 6.3 Guard nombre lead + ejemplos concretos (sugerencia Vi 1).
 *   - 6.4 Concision + excepcion Anti-ADN regla 4.
 *   - 6.5 Cierre CONTEXTUAL (no automatico).
 *   - 6.6 PRESION vs PROACTIVIDAD distincion clave.
 *   - 6.7 Validacion empatica anti-condescendencia.
 *   - 6.8 Cross-link a §1-§4 + §6.10.
 *   - 6.9 Anchor doctrinal Mariano + Vi review.
 *   - 6.10 Memoria conversacional (sugerencia Vi 2).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SEED_PATH = path.resolve(__dirname, '../prompts/v2/voice_seed_center.md');
const SEED = fs.readFileSync(SEED_PATH, 'utf8');

describe('C-465-EMPATIA-INTEGRATION §6 — section completa', () => {
  test('D.1 — §6 ESTILO CONVERSACIONAL section presente', () => {
    expect(SEED).toMatch(/## §6 ESTILO CONVERSACIONAL/);
  });

  test('D.2 — §6.5 cierre CONTEXTUAL (regla "no automatico")', () => {
    expect(SEED).toMatch(/§6\.5 Cierre del mensaje \(CONTEXTUAL/);
    expect(SEED).toMatch(/NUNCA[\s\S]*?muletilla[\s\S]*?automática/i);
  });

  test('D.3 — §6.6 PRESIÓN vs PROACTIVIDAD distinción explícita con markers ❌/✅', () => {
    expect(SEED).toMatch(/§6\.6 PRESIÓN vs PROACTIVIDAD/);
    expect(SEED).toMatch(/❌\s*\*\*PRESIÓN-VENTA prohibida/);
    expect(SEED).toMatch(/✅\s*\*\*PROACTIVIDAD-VALOR permitida/);
  });

  test('D.4 — §6.3 guard nombre lead "SOLO si fue dado explícitamente" + 3 ejemplos', () => {
    expect(SEED).toMatch(/§6\.3 Uso del nombre del lead/);
    expect(SEED).toMatch(/SOLO.*lead te dio su primer nombre.*explícitamente/i);
    // Sugerencia Vi 1: 3 ejemplos concretos.
    expect(SEED).toMatch(/soy Juan, tengo una consulta/);
    expect(SEED).toMatch(/che, miia, andas\?/);
    expect(SEED).toMatch(/estoy con Pedro mirando/);
  });

  test('D.5 — §6.10 memoria conversacional presente (sugerencia Vi 2)', () => {
    expect(SEED).toMatch(/§6\.10 Memoria conversacional/);
    expect(SEED).toMatch(/NO le preguntes después.*a qué te dedicás/i);
    expect(SEED).toMatch(/24h re-engagement/);
    expect(SEED).toMatch(/re_engagement\.js/);
  });

  test('D.6 — §6.2 refuerza P2 NADA HARDCODED', () => {
    expect(SEED).toMatch(/§6\.2 Adaptación dinámica/);
    expect(SEED).toMatch(/Cero hardcoded.*modelo lee.*decide en runtime/i);
  });

  test('D.7 — §6.4 excepción Anti-ADN regla 4 (integridad promesa)', () => {
    expect(SEED).toMatch(/§6\.4 Concisión/);
    expect(SEED).toMatch(/integridad[\s\S]*?de promesa[\s\S]*?Anti-ADN regla 4/i);
  });

  test('D.8 — §6.7 anti-condescendencia + halagos vacíos', () => {
    expect(SEED).toMatch(/Condescendencia.*qué buena pregunta/i);
    expect(SEED).toMatch(/Halagos vacíos/i);
  });

  test('D.9 — §6.8 cross-link a §1-§4 + §6.10', () => {
    expect(SEED).toMatch(/§6\.8 Cross-link/);
    expect(SEED).toMatch(/§1 IDENTIDAD/);
    expect(SEED).toMatch(/§3 ADN P1-P5/);
    expect(SEED).toMatch(/§4 RED FLAGS/);
  });

  test('D.10 — §6.9 anchor doctrinal Mariano + revision Vi sugerencias 1+2', () => {
    expect(SEED).toMatch(/§6\.9 Anchor doctrinal/);
    expect(SEED).toMatch(/Firma viva Mariano 2026-04-28/);
    expect(SEED).toMatch(/sugerencias.*aceptadas/i);
  });

  test('D.11 — historial v2.1+EMPATIA marker presente', () => {
    expect(SEED).toMatch(/v2\.1\+EMPATIA.*2026-04-28.*C-465-EMPATIA-INTEGRATION/);
  });

  test('D.12 — anclas anteriores preservadas (cero regresion v2.1 ADENDA)', () => {
    expect(SEED).toMatch(/v2\.1.*ADENDA 1\+2/);
    expect(SEED).toMatch(/Anti-ADN.*4 reglas duras/);
    expect(SEED).toMatch(/INTEGRIDAD DE PROMESA/);
  });
});
