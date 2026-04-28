/**
 * Tests: C-441 MMC Nightly Distillation Runner.
 *
 * Origen: CARTA_C-441 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27].
 *
 * Tests estáticos sobre regex del runner (continuidad C-440 patrón) +
 * smoke E2E con mocks. Sin dependencia Firebase real.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const RUNNER_PATH = path.resolve(__dirname, '../scripts/run_mmc_nightly_distillation.js');
const SOURCE = fs.readFileSync(RUNNER_PATH, 'utf8');

const MIIA_CENTER_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';
const MIIA_PERSONAL_UID = 'bq2BbtCVF8cZo30tum584zrGATJ3';

describe('C-441 §A — Runner script estructura', () => {
  test('A.1 — UID hardcoded MIIA CENTER (etapa 1 §2-bis estricta)', () => {
    expect(SOURCE).toContain(`'${MIIA_CENTER_UID}'`);
    // Personal NO debe aparecer hardcoded
    expect(SOURCE).not.toContain(`'${MIIA_PERSONAL_UID}'`);
  });

  test('A.2 — runNightlyDistillation invocado', () => {
    expect(SOURCE).toMatch(/runNightlyDistillation\s*\(/);
  });

  test('A.3 — getEpisodesFn provisto via _fetchClosedPending', () => {
    expect(SOURCE).toMatch(/getEpisodesFn\s*:/);
    expect(SOURCE).toMatch(/_fetchClosedPending/);
  });

  test('A.4 — limit batch 50 (DEFAULT_BATCH_LIMIT del distiller)', () => {
    expect(SOURCE).toMatch(/limit\s*:\s*50/);
  });

  test('A.5 — log [V2-ALERT][MMC-NIGHTLY-FATAL] en error catastrofico', () => {
    expect(SOURCE).toContain('[V2-ALERT][MMC-NIGHTLY-FATAL]');
  });

  test('A.6 — env vars Firebase requeridas validadas pre-init', () => {
    expect(SOURCE).toMatch(/FIREBASE_PROJECT_ID/);
    expect(SOURCE).toMatch(/FIREBASE_CLIENT_EMAIL/);
    expect(SOURCE).toMatch(/FIREBASE_PRIVATE_KEY/);
  });

  test('A.7 — adaptador Gemini reusa aiGateway smartCall', () => {
    expect(SOURCE).toMatch(/aiGateway\.smartCall/);
  });

  test('A.8 — exit code 0 OK / 1 error (cron-friendly)', () => {
    expect(SOURCE).toMatch(/process\.exit\(0\)/);
    expect(SOURCE).toMatch(/process\.exit\(1\)/);
  });
});

describe('C-441 §B — Sintaxis + módulo carga sin error', () => {
  test('B.1 — sintaxis JS válida (Node parser)', () => {
    expect(() => {
      // Cargar el módulo sin ejecutar main()
      delete require.cache[require.resolve('../scripts/run_mmc_nightly_distillation.js')];
      require('../scripts/run_mmc_nightly_distillation.js');
    }).not.toThrow();
  });

  test('B.2 — exports MIIA_CENTER_UID + helpers', () => {
    delete require.cache[require.resolve('../scripts/run_mmc_nightly_distillation.js')];
    const mod = require('../scripts/run_mmc_nightly_distillation.js');
    expect(mod.MIIA_CENTER_UID).toBe(MIIA_CENTER_UID);
    expect(typeof mod._fetchClosedPending).toBe('function');
    expect(typeof mod._makeGeminiClientForDistillation).toBe('function');
  });
});

describe('C-441 §C — Adaptador Gemini para distiller', () => {
  test('C.1 — generateContent retorna {text} shape esperado por distiller', async () => {
    delete require.cache[require.resolve('../scripts/run_mmc_nightly_distillation.js')];
    const mod = require('../scripts/run_mmc_nightly_distillation.js');
    // Mock aiGateway temporalmente
    const aiGateway = require('../ai/ai_gateway');
    const origSmartCall = aiGateway.smartCall;
    aiGateway.smartCall = async () => ({ text: '{"topic":"t1","summary":"s1"}' });
    try {
      const client = mod._makeGeminiClientForDistillation();
      const r = await client.generateContent({ prompt: 'test', signal: null });
      expect(r).toHaveProperty('text');
      expect(typeof r.text).toBe('string');
    } finally {
      aiGateway.smartCall = origSmartCall;
    }
  });
});
