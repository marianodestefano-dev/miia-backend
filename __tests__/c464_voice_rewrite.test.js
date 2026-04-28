/**
 * Tests: C-464-VOICE-REWRITE — voice_seed_center.md v2.0 ADN MIIA
 * producto vertical-agnostico + voice_v2_loader.js subregistros nuevos.
 *
 * Origen: CARTA C-464 [FIRMADA_VIVO_MARIANO_2026-04-28] ADN COMPLETO.
 *
 * Bug previo: voice_seed_center.md v1.0 sesgo MediLink (15 menciones).
 *   Bug raíz §A C-446-FIX-ADN. Auditor RF11 mitigation runtime, pero
 *   raíz era el seed mismo.
 *
 * Fix: rewrite v2.0 con ADN ventas P1-P5 firmado Mariano + subregistros
 *   leads_miia / clientes_miia / follow_up_cold_miia.
 *
 * NADA HARDCODED: tono adaptativo via prompt instruction (Gemini lee).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SEED_PATH = path.resolve(__dirname, '../prompts/v2/voice_seed_center.md');
const LOADER_PATH = path.resolve(__dirname, '../core/voice_v2_loader.js');

const SEED = fs.readFileSync(SEED_PATH, 'utf8');
const LOADER = fs.readFileSync(LOADER_PATH, 'utf8');

// ════════════════════════════════════════════════════════════════════
// §A — voice_seed_center.md v2.0 estructura
// ════════════════════════════════════════════════════════════════════

describe('C-464-VOICE-REWRITE §A — seed v2.0 estructura', () => {
  test('A.1 — header v2.0 + firma viva Mariano 2026-04-28 presentes', () => {
    expect(SEED).toMatch(/v2\.0/);
    expect(SEED).toMatch(/firma viva Mariano 2026-04-28/i);
    expect(SEED).toContain('C-464-VOICE-REWRITE');
  });

  test('A.2 — subregistros nuevos leads_miia + clientes_miia + follow_up_cold_miia', () => {
    expect(SEED).toMatch(/`leads_miia`/);
    expect(SEED).toMatch(/`clientes_miia`/);
    expect(SEED).toMatch(/`follow_up_cold_miia`/);
  });

  test('A.3 — auto-presentación canónica P1', () => {
    expect(SEED).toMatch(/Soy MIIA, una Asistente Virtual/i);
  });

  test('A.4 — Anti-ADN 3 reglas duras presentes (P3)', () => {
    expect(SEED).toMatch(/NUNCA divulgo/);
    expect(SEED).toMatch(/NUNCA fallo la probadita/);
    expect(SEED).toMatch(/NUNCA doy por hecho que el lead va a comprar/);
  });

  test('A.5 — Hilo conductor 5 STEPS presentes (P4)', () => {
    expect(SEED).toMatch(/STEP 1 — DISCOVERY/);
    expect(SEED).toMatch(/STEP 2 — PRIMERA PROBADITA REAL/);
    expect(SEED).toMatch(/STEP 3 — SEGUNDA OFERTA/);
    expect(SEED).toMatch(/STEP 4 — PROFUNDIZAR/);
    expect(SEED).toMatch(/STEP 5 — VALOR EXPERIMENTADO/);
  });

  test('A.6 — Tono adaptativo dinámico instruction (P2 NADA HARDCODED)', () => {
    expect(SEED).toMatch(/DETECTA EL TONO DEL LEAD/);
    expect(SEED).toMatch(/NADA HARDCODED/i);
  });

  test('A.7 — Demos WOW por categoría interés (P5)', () => {
    expect(SEED).toMatch(/Si menciona DEPORTE/i);
    expect(SEED).toMatch(/Si menciona FINANZAS/i);
    expect(SEED).toMatch(/Si menciona NOTICIAS/i);
  });

  test('A.8 — Red flags actualizadas con MediLink leak + sales-image + promesa rota', () => {
    expect(SEED).toMatch(/Mención a "MediLink"/);
    expect(SEED).toMatch(/Imagen \/ GIF de venta/);
    expect(SEED).toMatch(/Promesa rota/);
    expect(SEED).toMatch(/Insistir en compra/);
  });

  test('A.9 — Cross-link C-446 + C-464 trazabilidad', () => {
    expect(SEED).toMatch(/C-446/);
    expect(SEED).toMatch(/C-464/);
  });

  test('A.10 — Subregistro placeholder soporte_miia presente', () => {
    expect(SEED).toMatch(/`soporte_miia`/);
    expect(SEED).toMatch(/PLACEHOLDER/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — voice_v2_loader.js mapping actualizado
// ════════════════════════════════════════════════════════════════════

describe('C-464-VOICE-REWRITE §B — loader mapping CENTER', () => {
  test('B.1 — SUBREGISTRO_HEADERS_CENTER usa leads_miia (no leads_medilink)', () => {
    expect(LOADER).toMatch(/lead:\s*['"`]### §2\.1 `leads_miia`/);
  });

  test('B.2 — clientes_miia mapping correcto', () => {
    expect(LOADER).toMatch(/client:\s*['"`]### §2\.2 `clientes_miia`/);
  });

  test('B.3 — follow_up_cold_miia mapping correcto', () => {
    expect(LOADER).toMatch(/follow_up_cold:\s*['"`]### §2\.3 `follow_up_cold_miia`/);
  });

  test('B.4 — comment block actualizado a leads_miia (no leads_medilink en CENTER section)', () => {
    expect(LOADER).toMatch(/leads_miia.*lead nuevo MIIA producto/);
  });

  test('B.5 — Personal SUBREGISTRO_HEADERS sigue con medilink_team intacto', () => {
    // Personal usa voice_seed.md viejo (no tocado en C-464).
    expect(LOADER).toMatch(/medilink_team:/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §C — module load smoke (no rompe importacion)
// ════════════════════════════════════════════════════════════════════

describe('C-464-VOICE-REWRITE §C — module load smoke', () => {
  test('C.1 — voice_v2_loader.js carga sin error', () => {
    expect(() => {
      delete require.cache[require.resolve('../core/voice_v2_loader.js')];
      require('../core/voice_v2_loader.js');
    }).not.toThrow();
  });

  test('C.2 — exports correctos preservados', () => {
    delete require.cache[require.resolve('../core/voice_v2_loader.js')];
    const mod = require('../core/voice_v2_loader.js');
    expect(typeof mod.loadVoiceDNAForCenter).toBe('function');
    expect(typeof mod.loadVoiceDNAForGroup).toBe('function');
    expect(typeof mod.isV2EligibleUid).toBe('function');
    expect(mod.SUBREGISTRO_HEADERS_CENTER).toBeDefined();
  });

  test('C.3 — SUBREGISTRO_HEADERS_CENTER mapping correcto runtime', () => {
    delete require.cache[require.resolve('../core/voice_v2_loader.js')];
    const mod = require('../core/voice_v2_loader.js');
    expect(mod.SUBREGISTRO_HEADERS_CENTER.lead).toContain('leads_miia');
    expect(mod.SUBREGISTRO_HEADERS_CENTER.client).toContain('clientes_miia');
    expect(mod.SUBREGISTRO_HEADERS_CENTER.follow_up_cold).toContain('follow_up_cold_miia');
    expect(mod.SUBREGISTRO_HEADERS_CENTER.lead).not.toContain('medilink');
  });
});
