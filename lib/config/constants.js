'use strict';

/**
 * MIIA BACKEND — Centralized Constants Registry
 *
 * Origen: T59 Wi → Vi 2026-04-30. Patrón TECH-DEBT.1 LudoMIIA.
 *
 * Propósito:
 *   - Single source of truth de magic numbers usados en hot paths.
 *   - Cada hot path TODAVÍA tiene su `const` local (zero break en código existente).
 *   - Este registry sirve como índice + documentación para:
 *     a) Onboarding nuevo dev (qué thresholds existen y por qué)
 *     b) Future refactor: cuando se quiera consolidar, los nuevos call sites
 *        importan de aquí.
 *     c) Audit ISO 27001: revisión central de timeouts, rate limits, sampling.
 *
 * Diseño:
 *   - Frozen object por categoría (Object.freeze evita mutación accidental).
 *   - Cada constante con comment WHY (no solo WHAT).
 *   - Si una constante cambia de valor: actualizar AQUÍ + el hot path que la usa.
 *
 * NO toca código existente. Refactor real (importar en lugar de hardcodear)
 * queda para T-future con firma + tests por hot path migrado.
 */

// ═══════════════════════════════════════════════════════════════
// AI / GEMINI (ai/gemini_client.js)
// ═══════════════════════════════════════════════════════════════

const AI = Object.freeze({
  // Timeouts en ms para fetch a Gemini
  FETCH_TIMEOUT_MS: 45000,            // default timeout — Gemini no responde más allá de esto
  FETCH_TIMEOUT_HEAVY_MS: 60000,      // queries pesadas (google_search, thinking)
  FETCH_WARNING_MS: 40000,            // log warn antes del abort
  // Retries (gemini_client RETRY_DELAYS)
  MAX_RETRIES: 3,
  RETRY_DELAYS_MS: Object.freeze([8000, 20000, 45000]),
  // Modelo default Gemini
  DEFAULT_MODEL: 'gemini-2.5-flash',
  // Sampling Sentry (T57 spec)
  SENTRY_TRACES_SAMPLE: 0.1,
  SENTRY_PROFILES_SAMPLE: 0.05,
});

// ═══════════════════════════════════════════════════════════════
// RATE LIMITING (core/rate_limiter.js)
// ═══════════════════════════════════════════════════════════════

const RATE_LIMIT = Object.freeze({
  // Thresholds per-tenant 24h
  GREEN_THRESHOLD: 10,                // <10 msgs/24h = GREEN (free flow)
  YELLOW_THRESHOLD: 20,               // 10-20 = YELLOW (warning)
  ORANGE_THRESHOLD: 30,               // 20-30 = ORANGE (caution)
  RED_THRESHOLD: 40,                  // 30-40 = RED (alarming)
  STOP_THRESHOLD: 50,                 // >=50 = STOP (block sends)
  // Per-contact (anti-loop)
  CONTACT_LIMIT_DEFAULT: 5,           // 5 msgs/30s genéricos
  CONTACT_LIMIT_FAMILY: 10,           // 10 msgs/30s familia/equipo (ráfagas naturales)
  CONTACT_WINDOW_MS: 30000,           // 30s ventana per-contact
  // Circuit breaker
  CB_FAILURES_TO_OPEN: 5,             // 5 fails consecutivos = circuit OPEN
  CB_OPEN_TO_HALF_OPEN_MS: 60000,     // 1 min OPEN → HALF_OPEN
  CB_SUCCESS_TO_CLOSE: 3,             // 3 successes en HALF_OPEN = CLOSED
});

// ═══════════════════════════════════════════════════════════════
// LOOP WATCHER (core/loop_watcher.js)
// ═══════════════════════════════════════════════════════════════

const LOOP_WATCHER = Object.freeze({
  THRESHOLD: 10,                      // 10 msgs combinados (in+out) en ventana = loop
  WINDOW_MS: 30000,                   // 30s ventana
  STALE_CLEANUP_MS: 300000,           // 5 min sin actividad → limpiar entry
  CLEANUP_INTERVAL_MS: 120000,        // limpieza cada 2 min
  COT_OFFSET_HOURS: 5,                // UTC-5 para autoResetDaily MIIA CENTER
});

// ═══════════════════════════════════════════════════════════════
// HUMAN DELAY (core/human_delay.js)
// ═══════════════════════════════════════════════════════════════

const HUMAN_DELAY = Object.freeze({
  // Read delay caps por contactType
  OWNER_MAX_MS: 4000,                 // self-chat — owner espera respuesta rápida
  GENERIC_MAX_MS: 60000,              // otros — máximo 1 min de "lectura"
  // Typing delay
  CHAR_MS_MIN: 50,                    // 50ms por char (rápido)
  CHAR_MS_MAX: 80,                    // 80ms por char (humano promedio celular)
  TYPING_MIN_MS: 1500,                // floor mínimo
  TYPING_MAX_MS: 15000,               // cap máximo
  OWNER_TYPING_MULTIPLIER: 0.3,       // owner ve 70% más rápido
  // Reading time per char
  READING_MS_PER_100_CHARS: 200,
  READING_MAX_EXTRA_MS: 5000,
  // Night mode
  NIGHT_MULTIPLIER_MIN: 2,            // 2x más lento de noche
  NIGHT_MULTIPLIER_MAX: 5,            // 5x más lento
  NIGHT_HOUR_START: 22,               // 22:00 → night
  NIGHT_HOUR_END: 7,                  // 07:00 → daytime
  // Busy delay (1/8 chance)
  BUSY_PROBABILITY: 0.125,
  BUSY_DELAY_MIN_MS: 20000,
  BUSY_DELAY_MAX_MS: 45000,
});

// ═══════════════════════════════════════════════════════════════
// VALIDATOR (core/miia_validator.js)
// ═══════════════════════════════════════════════════════════════

const VALIDATOR = Object.freeze({
  MAX_MESSAGE_LENGTH: 4000,           // WhatsApp soporta ~65K, pero >4K es mala UX
  TRUNCATE_AT_LAST_PERIOD: true,      // cortar en último '.' antes del límite
});

// ═══════════════════════════════════════════════════════════════
// STRUCTURED LOGGER / METRICS (core/structured_logger.js, core/tenant_metrics.js)
// ═══════════════════════════════════════════════════════════════

const METRICS = Object.freeze({
  ROLLING_WINDOW_MS: 5 * 60 * 1000,   // 5 min ventana per-tenant + global
  ALERT_ERROR_RATE_WARN: 5,           // >5% error rate → warning
  ALERT_ERROR_RATE_CRITICAL: 10,      // >10% → critical
  MIN_MESSAGES_FOR_ALERT: 5,          // <5 msgs → no alert (insufficient data)
});

// ═══════════════════════════════════════════════════════════════
// AUDIT TRAIL (lib/audit_trail.js)
// ═══════════════════════════════════════════════════════════════

const AUDIT = Object.freeze({
  BUFFER_SIZE: 1000,                  // eventos in-memory rolling
  HASH_ALGO: 'sha256',
  GENESIS_HASH: '0'.repeat(64),
});

// ═══════════════════════════════════════════════════════════════
// HEALTH AGGREGATOR (core/health_aggregator.js)
// ═══════════════════════════════════════════════════════════════

const HEALTH = Object.freeze({
  PROBE_TIMEOUT_MS: 3000,             // Firestore probe timeout
  // Severity ladder
  SEVERITY: Object.freeze({
    OK: 0,
    UNKNOWN: 1,
    DEGRADED: 2,
    CRITICAL: 3,
    ERROR: 4,
  }),
  // Baileys ratios
  TENANT_OK_RATIO: 0.9,               // >=90% online → ok
  TENANT_DEGRADED_RATIO: 0.5,         // 50-90% → degraded
  TENANT_CRITICAL_RATIO: 0.5,         // <50% → critical
  // Tenant errored thresholds
  CRYPTO_ERROR_THRESHOLD: 5,          // >5 cryptoErrors → tenant errored
});

// ═══════════════════════════════════════════════════════════════
// COUNTRIES / TIMEZONES (core/message_logic.js getTimezoneForCountry)
// ═══════════════════════════════════════════════════════════════

const TIMEZONE_DEFAULT = 'America/Bogota';

// ═══════════════════════════════════════════════════════════════
// TODO / FUTURE WORK
// ═══════════════════════════════════════════════════════════════

/**
 * Esta es una snapshot. Para migrar un hot path:
 *   1. Importar la constante desde aquí
 *   2. Reemplazar el `const X = ...` local
 *   3. Run tests
 *   4. Commit con [REFACTOR-CONSTS]
 *
 * Hot paths candidatos (no migrados aún):
 *   - ai/gemini_client.js (timeouts)
 *   - core/rate_limiter.js (thresholds)
 *   - core/loop_watcher.js (THRESHOLD, WINDOW_MS)
 *   - core/human_delay.js (delays)
 *   - core/miia_validator.js (MAX_MESSAGE_LENGTH)
 *   - core/structured_logger.js (WINDOW_MS)
 *   - core/tenant_metrics.js (WINDOW_MS)
 *   - lib/audit_trail.js (DEFAULT_BUFFER_SIZE)
 */

module.exports = {
  AI,
  RATE_LIMIT,
  LOOP_WATCHER,
  HUMAN_DELAY,
  VALIDATOR,
  METRICS,
  AUDIT,
  HEALTH,
  TIMEZONE_DEFAULT,
};
