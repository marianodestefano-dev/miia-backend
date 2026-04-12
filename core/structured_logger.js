'use strict';

/**
 * STRUCTURED LOGGER — Logging con formato JSON + métricas en tiempo real
 *
 * STANDARD: Google + Amazon + NASA
 *
 * NO reemplaza console.log existente (eso sería suicida en una sesión).
 * En cambio, provee:
 *   1. Logger estructurado para módulos NUEVOS
 *   2. Métricas en memoria (mensajes/min, errores/min, latencia promedio)
 *   3. Endpoint /api/metrics para dashboard
 *   4. Alertas automáticas cuando error_rate > threshold
 *
 * USO:
 *   const logger = require('./structured_logger').createLogger('TMH');
 *   logger.info('Mensaje procesado', { uid, phone, latencyMs: 150 });
 *   logger.error('Gemini timeout', { uid, provider: 'gemini', error: err.message });
 */

// ═══════════════════════════════════════════════════════════════
// MÉTRICAS EN MEMORIA (rolling window de 5 minutos)
// ═══════════════════════════════════════════════════════════════

const WINDOW_MS = 5 * 60 * 1000; // 5 minutos

const _metrics = {
  messages: [],      // { ts, uid, latencyMs }
  errors: [],        // { ts, module, error }
  aiCalls: [],       // { ts, provider, latencyMs, success }
  tagProcessed: [],  // { ts, tag, success }
};

function _pruneOld(arr) {
  const cutoff = Date.now() - WINDOW_MS;
  while (arr.length > 0 && arr[0].ts < cutoff) arr.shift();
}

// ═══════════════════════════════════════════════════════════════
// LOGGER FACTORY
// ═══════════════════════════════════════════════════════════════

/**
 * Crear un logger para un módulo específico.
 * @param {string} module - Nombre del módulo (ej: 'TMH', 'SERVER', 'HEALTH')
 * @returns {Object} Logger con métodos info/warn/error/metric
 */
function createLogger(module) {
  const _log = (level, message, data = {}) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      module,
      message,
      ...data,
    };

    // Formato legible para Railway logs + JSON parseable
    const emoji = level === 'ERROR' ? '❌' : level === 'WARN' ? '⚠️' : level === 'INFO' ? '📋' : '📊';
    const dataStr = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';

    switch (level) {
      case 'ERROR':
        console.error(`${emoji} [${module}] ${message}${dataStr}`);
        _metrics.errors.push({ ts: Date.now(), module, error: message });
        _pruneOld(_metrics.errors);
        break;
      case 'WARN':
        console.warn(`${emoji} [${module}] ${message}${dataStr}`);
        break;
      default:
        console.log(`${emoji} [${module}] ${message}${dataStr}`);
    }

    return entry;
  };

  return {
    info: (msg, data) => _log('INFO', msg, data),
    warn: (msg, data) => _log('WARN', msg, data),
    error: (msg, data) => _log('ERROR', msg, data),

    /** Registrar una métrica de mensaje procesado */
    messageProcessed: (uid, latencyMs) => {
      _metrics.messages.push({ ts: Date.now(), uid, latencyMs });
      _pruneOld(_metrics.messages);
    },

    /** Registrar una llamada a AI */
    aiCall: (provider, latencyMs, success) => {
      _metrics.aiCalls.push({ ts: Date.now(), provider, latencyMs, success });
      _pruneOld(_metrics.aiCalls);
    },

    /** Registrar procesamiento de tag */
    tagProcessed: (tag, success) => {
      _metrics.tagProcessed.push({ ts: Date.now(), tag, success });
      _pruneOld(_metrics.tagProcessed);
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// MÉTRICAS AGREGADAS
// ═══════════════════════════════════════════════════════════════

/**
 * Obtener métricas agregadas de los últimos 5 minutos.
 * @returns {Object} Métricas para /api/metrics
 */
function getMetrics() {
  _pruneOld(_metrics.messages);
  _pruneOld(_metrics.errors);
  _pruneOld(_metrics.aiCalls);
  _pruneOld(_metrics.tagProcessed);

  const now = Date.now();
  const windowMinutes = WINDOW_MS / 60000;

  // Mensajes
  const msgCount = _metrics.messages.length;
  const avgLatency = msgCount > 0
    ? Math.round(_metrics.messages.reduce((s, m) => s + (m.latencyMs || 0), 0) / msgCount)
    : 0;

  // Errores
  const errorCount = _metrics.errors.length;
  const errorRate = msgCount > 0 ? Math.round((errorCount / msgCount) * 100) : 0;

  // AI calls
  const aiCount = _metrics.aiCalls.length;
  const aiSuccessRate = aiCount > 0
    ? Math.round(_metrics.aiCalls.filter(a => a.success).length / aiCount * 100)
    : 100;
  const aiAvgLatency = aiCount > 0
    ? Math.round(_metrics.aiCalls.reduce((s, a) => s + (a.latencyMs || 0), 0) / aiCount)
    : 0;

  // Tags
  const tagCount = _metrics.tagProcessed.length;
  const tagSuccessRate = tagCount > 0
    ? Math.round(_metrics.tagProcessed.filter(t => t.success).length / tagCount * 100)
    : 100;

  // Errores por módulo
  const errorsByModule = {};
  for (const e of _metrics.errors) {
    errorsByModule[e.module] = (errorsByModule[e.module] || 0) + 1;
  }

  return {
    window: `${windowMinutes}min`,
    timestamp: new Date().toISOString(),
    messages: {
      count: msgCount,
      perMinute: Math.round(msgCount / windowMinutes * 10) / 10,
      avgLatencyMs: avgLatency,
    },
    errors: {
      count: errorCount,
      rate: `${errorRate}%`,
      byModule: errorsByModule,
      alert: errorRate > 5 ? 'HIGH_ERROR_RATE' : null,
    },
    ai: {
      calls: aiCount,
      successRate: `${aiSuccessRate}%`,
      avgLatencyMs: aiAvgLatency,
    },
    tags: {
      processed: tagCount,
      successRate: `${tagSuccessRate}%`,
    },
  };
}

/**
 * ¿Hay alerta activa? (error rate > 5%)
 */
function hasActiveAlert() {
  _pruneOld(_metrics.messages);
  _pruneOld(_metrics.errors);
  const msgCount = _metrics.messages.length;
  const errorCount = _metrics.errors.length;
  if (msgCount < 5) return null; // No suficientes datos
  const rate = (errorCount / msgCount) * 100;
  if (rate > 10) return { level: 'critical', message: `Error rate ${Math.round(rate)}% (${errorCount}/${msgCount} en 5min)` };
  if (rate > 5) return { level: 'warning', message: `Error rate ${Math.round(rate)}% (${errorCount}/${msgCount} en 5min)` };
  return null;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  createLogger,
  getMetrics,
  hasActiveAlert,
  WINDOW_MS,
};
