'use strict';

/**
 * MIIA Structured Logger — T26-IMPLEMENT (Fase 0 setup base).
 *
 * Origen: T18 propuesta logger Pino + wrapper compat slog. Wi firmo T26
 * mail [163] — "Implementar Pino logger setup minimo (Fase 0)".
 *
 * Scope Fase 0:
 *   - Wrapper minimalista sobre pino (level/format/transport configurable)
 *   - API compat: logger.{trace, debug, info, warn, error, fatal}
 *   - Helper structured(): bind metadata baseline (service, env, version)
 *   - NO migra call sites todavia (eso es Fase 1+, requiere firma Mariano)
 *
 * NO toca:
 *   - log_sanitizer.js installConsoleOverride (preserva semantica actual,
 *     migracion progresiva en Fase 1)
 *   - 5.986 console.log call sites existentes en TMH/server/etc
 *
 * Patron: similar a JUEGA MIIA api-miiadt lib/logger.js (referencia ARQ).
 */

const pino = require('pino');
const sanitizer = require('./log_sanitizer');

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const SERVICE_NAME = 'miia-backend';
const NODE_ENV = process.env.NODE_ENV || 'development';
const LOG_LEVEL = process.env.MIIA_LOG_LEVEL || (NODE_ENV === 'production' ? 'info' : 'debug');
const PKG_VERSION = (() => {
  try {
    return require('../package.json').version || 'unknown';
  } catch (_) {
    return 'unknown';
  }
})();

// Metadata baseline auto-injected en cada log
const BASELINE_META = {
  service: SERVICE_NAME,
  env: NODE_ENV,
  version: PKG_VERSION,
};

// ═══════════════════════════════════════════════════════════════
// PINO INSTANCE
// ═══════════════════════════════════════════════════════════════

const _pinoOpts = {
  level: LOG_LEVEL,
  base: BASELINE_META,
  timestamp: pino.stdTimeFunctions.isoTime,
  // Production: JSON structured (Railway parsea facil).
  // Dev: si MIIA_DEBUG_VERBOSE=true → JSON; si no, pretty (cuando esta instalado).
  // pino-pretty es dev-only opcional; sin instalar el output sigue JSON.
};

const _logger = pino(_pinoOpts);

// ═══════════════════════════════════════════════════════════════
// PUBLIC API — wrapper minimalista
// ═══════════════════════════════════════════════════════════════

/**
 * Crear child logger con metadata adicional bound.
 * Util para correlacion (uid, requestId, tenant).
 *
 * Ejemplo:
 *   const log = logger.child({ uid: 'abc', requestId: 'r-123' });
 *   log.info('Mensaje'); // incluye uid + requestId automaticamente
 */
function child(bindings) {
  return _logger.child(bindings || {});
}

/**
 * EXTRA #4.c (2026-05-12) — Sanitize args antes de logear.
 * Si NODE_ENV=production y !MIIA_DEBUG_VERBOSE, aplica sanitize() a strings
 * y sanitizeObject() a objetos. Si dev o verbose, no-op (pasa tal cual).
 */
function _sanitizeArgs(args) {
  if (!sanitizer.isActive || !sanitizer.isActive()) return args;
  return args.map(function (a) {
    if (typeof a === 'string') return sanitizer.sanitize(a);
    if (a && typeof a === 'object' && !(a instanceof Error)) return sanitizer.sanitizeObject(a);
    return a;
  });
}

/**
 * Logger publico con API estandar pino:
 *   trace, debug, info, warn, error, fatal
 *
 * Cada metodo acepta:
 *   logger.info('mensaje simple')
 *   logger.info({ extra: 'meta' }, 'mensaje con metadata')
 *   logger.error(error, 'fallo en X')  // pino auto-serializa Error
 *
 * Todos los args pasan por sanitizer.sanitize() si NODE_ENV=production.
 */
const logger = {
  trace: (...args) => _logger.trace(..._sanitizeArgs(args)),
  debug: (...args) => _logger.debug(..._sanitizeArgs(args)),
  info: (...args) => _logger.info(..._sanitizeArgs(args)),
  warn: (...args) => _logger.warn(..._sanitizeArgs(args)),
  error: (...args) => _logger.error(..._sanitizeArgs(args)),
  fatal: (...args) => _logger.fatal(..._sanitizeArgs(args)),
  child,
  // Internal: para tests + flush on SIGTERM
  _pino: _logger,
  _config: { SERVICE_NAME, NODE_ENV, LOG_LEVEL, PKG_VERSION, BASELINE_META },
  _sanitizeArgs,
};

// ═══════════════════════════════════════════════════════════════
// FLUSH ON SIGTERM (defensive — pino puede usar async transport)
// ═══════════════════════════════════════════════════════════════

function flushSync() {
  try {
    if (typeof _logger.flush === 'function') {
      _logger.flush();
    }
  } catch (_) {
    // ignore — flush es best-effort
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = logger;
module.exports.flushSync = flushSync;
module.exports.child = child;
