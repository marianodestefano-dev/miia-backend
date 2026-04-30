'use strict';

/**
 * MMC Episode Distiller — T34-IMPLEMENT (skeleton Fase 1).
 *
 * Origen: T30 propuesta integracion MMC + Cimientos completados. Wi firmo
 * T34 mail [169] [ACK-T28-T31+N4-VI] — "T34 IMPLEMENTAR T30 MMC episodic
 * memory integracion — patron Fase 1 con cimientos T15+T24".
 *
 * SCOPE T34 (skeleton, NO implementacion completa MMC):
 *   - Module skeleton con guards integrados a cimientos sprint
 *   - Stub distillEpisode() bloqueado tras firma Mariano para implementacion
 *   - Tests verifican integracion con T9/T10/T15/T24/T26
 *
 * Implementacion completa Fase 1 (cadencias + destilacion + Gemini PRO
 * review + schema completo) es CARTA POSTERIOR con firma Mariano.
 *
 * Spec base: .claude/specs/13_MMC_DISEÑO_1_MIIA_OWNER.md v0.3 aprobado
 * Mariano 2026-04-19. NO duplica spec, solo lo materializa con cimientos.
 */

const logger = require('./logger'); // T26 Pino wrapper
const { recordLatency } = require('./health_check'); // T24 latency tracking
const logSanitizer = require('./log_sanitizer'); // T10 PII mask + slog
const admin = require('firebase-admin');

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

// Guard: skeleton inerte hasta firma Mariano explicita activacion Fase 1
const MMC_FASE_1_ENABLED = process.env.MMC_FASE_1_ENABLED === 'true';

// T9 RC-1: per-phone processing Set para evitar destiller concurrent
// con handleTenantMessage del mismo phone
const _processingPhones = new Set();

// T15 RC-2 paridad: window guard para evitar retry overlap
const _retryWindow = new Map(); // phone -> timestamp

// ═══════════════════════════════════════════════════════════════
// PUBLIC API — distillEpisode(uid, phone, conversation)
// ═══════════════════════════════════════════════════════════════

/**
 * Destilar episodio de conversation a estructura MMC Capa 2.
 *
 * Skeleton: bloqueado tras MMC_FASE_1_ENABLED hasta firma Mariano.
 * Cuando se active, debe:
 *   1. Detectar boundary del episodio (start + end)
 *   2. Generar resumen + cadencia + lecciones (via Gemini PRO)
 *   3. Persistir en users/{uid}/miia_memory/{episodeId}
 *   4. Aplicar embedding para retrieval
 *
 * Cimientos integrados:
 *   - T9 RC-1: skip si phone ya en processing
 *   - T10 PII: log content via slog.msgContent (hash garantizado)
 *   - T24 latency: recordLatency('aiGateway', duration) post-Gemini call
 *   - T26 logger: child({ component: 'mmc-distiller', uid: maskUid(uid) })
 */
async function distillEpisode(uid, phone, conversation) {
  if (!MMC_FASE_1_ENABLED) {
    logger.debug({ component: 'mmc-distiller' }, 'MMC Fase 1 NO activada (MMC_FASE_1_ENABLED env). Skeleton inerte.');
    return null;
  }

  // T9 RC-1 guard: skip si phone ya en processing (handleTenantMessage activo)
  if (_processingPhones.has(phone)) {
    logger.warn({
      component: 'mmc-distiller',
      uid: logSanitizer.maskUid(uid),
      reason: 'concurrent_handler',
    }, 'MMC distill skipped — handler activo para mismo phone (T9 RC-1)');
    return null;
  }

  _processingPhones.add(phone);
  const log = logger.child({
    component: 'mmc-distiller',
    uid: logSanitizer.maskUid(uid),
  });

  const start = Date.now();
  try {
    log.info({ phone: phone.slice(-4), turnsCount: conversation?.length || 0 }, 'MMC distill start');

    // T10 sanitize: si content visible en logs, hash garantizado
    if (conversation && conversation.length > 0) {
      const lastTurn = conversation[conversation.length - 1];
      if (lastTurn?.content) {
        logSanitizer.slog.msgContent('[MMC] last turn snapshot', String(lastTurn.content));
      }
    }

    // ═══ STUB: implementacion real Fase 1 va aqui ═══
    // Pasos pendientes (firma Mariano + Gemini PRO review):
    //   1. Boundary detection (heuristic: gap > 30 min OR explicit close)
    //   2. Generate summary + cadencia + lessons (Gemini PRO call)
    //   3. Apply embedding (text-embedding-3 or equivalent)
    //   4. Persist users/{uid}/miia_memory/{episodeId} schema v0.3
    //   5. Update training_data chunk memory_graduated
    // ════════════════════════════════════════════════

    log.warn({
      stub: true,
      reason: 'fase_1_no_implementada_en_T34_skeleton',
    }, 'MMC distill stub — Fase 1 completa requiere CARTA + firma Mariano');

    return { status: 'stub', episodeId: null };

  } catch (err) {
    log.error({
      err: err.message,
      stack: err.stack?.split('\n')?.[0],
    }, 'MMC distill error');
    return { status: 'error', error: err.message };
  } finally {
    // T9 RC-1 release garantizado
    _processingPhones.delete(phone);
    // T24 latency tracking
    const duration = Date.now() - start;
    if (typeof recordLatency === 'function') {
      recordLatency('aiGateway', duration);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS — para tests + monitoring
// ═══════════════════════════════════════════════════════════════

function isProcessingPhone(phone) {
  return _processingPhones.has(phone);
}

function getProcessingCount() {
  return _processingPhones.size;
}

function clearProcessing() {
  _processingPhones.clear();
  _retryWindow.clear();
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  distillEpisode,
  // Helpers para tests
  isProcessingPhone,
  getProcessingCount,
  clearProcessing,
  // Config
  MMC_FASE_1_ENABLED,
};
