'use strict';

/**
 * Tests: T34 — MMC Episode Distiller skeleton + integracion cimientos.
 *
 * Origen: T30 propuesta integracion. Wi firmo T34 mail [169] — "patron
 * Fase 1 con cimientos T15+T24". Skeleton, NO implementacion completa MMC.
 *
 * §A — Tests estaticos sobre source core/mmc_distiller.js
 * §B — Tests runtime: skeleton inerte sin MMC_FASE_1_ENABLED
 * §C — Tests integracion cimientos (T9 RC-1, T10 PII, T24 latency, T26 logger)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MMC_PATH = path.resolve(__dirname, '../core/mmc_distiller.js');
const MMC_SOURCE = fs.readFileSync(MMC_PATH, 'utf8');

// ════════════════════════════════════════════════════════════════════
// §A — Estructura source
// ════════════════════════════════════════════════════════════════════

describe('T34 §A — mmc_distiller.js skeleton structure', () => {
  test('A.1 — comentario T34-IMPLEMENT presente', () => {
    expect(MMC_SOURCE).toMatch(/T34-IMPLEMENT/);
  });

  test('A.2 — referencia spec base 13_MMC_DISEÑO_1_MIIA_OWNER.md v0.3', () => {
    expect(MMC_SOURCE).toMatch(/13_MMC_DISE.*MIIA_OWNER\.md/);
    expect(MMC_SOURCE).toMatch(/v0\.3/);
  });

  test('A.3 — guard MMC_FASE_1_ENABLED env var', () => {
    expect(MMC_SOURCE).toMatch(/MMC_FASE_1_ENABLED.*process\.env\.MMC_FASE_1_ENABLED/);
  });

  test('A.4 — distillEpisode async function definida', () => {
    expect(MMC_SOURCE).toMatch(/async function distillEpisode\(uid, phone, conversation\)/);
  });

  test('A.5 — exports distillEpisode + helpers', () => {
    expect(MMC_SOURCE).toMatch(/module\.exports\s*=\s*\{[^}]*distillEpisode/s);
    expect(MMC_SOURCE).toMatch(/isProcessingPhone/);
    expect(MMC_SOURCE).toMatch(/getProcessingCount/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — Skeleton inerte sin MMC_FASE_1_ENABLED
// ════════════════════════════════════════════════════════════════════

describe('T34 §B — skeleton inerte default', () => {
  let mmc;

  beforeAll(() => {
    // Mock dependencies
    jest.doMock('firebase-admin', () => ({
      firestore: () => ({ collection: () => ({ doc: () => ({ set: () => Promise.resolve() }) }) }),
    }));
    jest.doMock('../core/health_check', () => ({
      recordLatency: jest.fn(),
    }));
    jest.doMock('../whatsapp/tenant_manager', () => ({
      getUpsertStats: () => ({ count10min: 0, count20min: 0, lastUpsertAt: null }),
    }));
    delete process.env.MMC_FASE_1_ENABLED;
    delete require.cache[require.resolve('../core/mmc_distiller')];
    mmc = require('../core/mmc_distiller');
  });

  test('B.1 — MMC_FASE_1_ENABLED default false', () => {
    expect(mmc.MMC_FASE_1_ENABLED).toBe(false);
  });

  test('B.2 — distillEpisode retorna null sin activacion', async () => {
    const result = await mmc.distillEpisode('uid-test', '573123456789', []);
    expect(result).toBeNull();
  });

  test('B.3 — getProcessingCount inicia en 0', () => {
    mmc.clearProcessing();
    expect(mmc.getProcessingCount()).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// §C — Integracion cimientos (verificacion estatica)
// ════════════════════════════════════════════════════════════════════

describe('T34 §C — integracion cimientos sprint', () => {
  test('C.1 — T9 RC-1 guard: _processingPhones Set + skip si concurrent', () => {
    expect(MMC_SOURCE).toMatch(/_processingPhones\s*=\s*new Set\(\)/);
    expect(MMC_SOURCE).toMatch(/_processingPhones\.has\(phone\)/);
    expect(MMC_SOURCE).toMatch(/T9 RC-1/);
  });

  test('C.2 — T9 RC-1 release: finally _processingPhones.delete(phone)', () => {
    expect(MMC_SOURCE).toMatch(/_processingPhones\.delete\(phone\)/);
    // Debe estar en finally block para garantizar release
    const finallyIdx = MMC_SOURCE.indexOf('} finally {');
    const deleteIdx = MMC_SOURCE.indexOf('_processingPhones.delete(phone)');
    expect(finallyIdx).toBeLessThan(deleteIdx);
  });

  test('C.3 — T10 PII: usa slog.msgContent para content visible', () => {
    expect(MMC_SOURCE).toMatch(/logSanitizer\.slog\.msgContent/);
  });

  test('C.4 — T10 PII: maskUid en logger child bindings', () => {
    expect(MMC_SOURCE).toMatch(/logSanitizer\.maskUid\(uid\)/);
  });

  test('C.5 — T24 latency: recordLatency post-distill', () => {
    expect(MMC_SOURCE).toMatch(/recordLatency.*aiGateway/);
  });

  test('C.6 — T26 logger: child con component=mmc-distiller', () => {
    expect(MMC_SOURCE).toMatch(/logger\.child/);
    expect(MMC_SOURCE).toMatch(/component:\s*['"]mmc-distiller['"]/);
  });

  test('C.7 — T26 logger: structured metadata en logs (warn/info/error)', () => {
    expect(MMC_SOURCE).toMatch(/log\.info\(/);
    expect(MMC_SOURCE).toMatch(/log\.warn\(/);
    expect(MMC_SOURCE).toMatch(/log\.error\(/);
  });

  test('C.8 — Stub explicito: pendiente firma Mariano para Fase 1 completa', () => {
    expect(MMC_SOURCE).toMatch(/STUB:|stub: true/);
    expect(MMC_SOURCE).toMatch(/firma Mariano/i);
  });
});
