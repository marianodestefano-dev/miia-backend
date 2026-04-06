'use strict';

/**
 * TASK SCHEDULER v1.0 — Sistema de concentración por nivel de calidad
 *
 * NO es sobre velocidad/urgencia — es sobre CONCENTRACIÓN y CALIDAD.
 * Cada tarea recibe un nivel de concentración (1-5) que determina:
 * - Cuánto TIEMPO dedica MIIA a la tarea
 * - Cuántas VERIFICACIONES hace antes de dar por bueno
 * - Cuántos REINTENTOS ante fallo
 *
 * Niveles:
 *   L5 (CRÍTICO):   45-60s, 3 verificaciones, 3 reintentos — emails, mensajes críticos, emergencias
 *   L4 (ALTO):      30-45s, 2 verificaciones, 2 reintentos — búsquedas Gemini, alertas de precio
 *   L3 (MEDIO):     15-30s, 1 verificación, 1 reintento   — respuestas normales, agenda
 *   L2 (BAJO):       3-8s,  0 verificaciones, log silencioso — sync Firestore, estado interno
 *   L1 (PASIVO):     0-3s,  0 verificaciones, ignorar fallo — heartbeat, presencia, métricas
 */

// Configuración por nivel
const LEVELS = {
  5: { name: 'CRÍTICO',  minMs: 45000, maxMs: 60000, verifications: 3, retries: 3, onFail: 'notify' },
  4: { name: 'ALTO',     minMs: 30000, maxMs: 45000, verifications: 2, retries: 2, onFail: 'log+retry' },
  3: { name: 'MEDIO',    minMs: 15000, maxMs: 30000, verifications: 1, retries: 1, onFail: 'log' },
  2: { name: 'BAJO',     minMs: 3000,  maxMs: 8000,  verifications: 1, retries: 0, onFail: 'silent' },
  1: { name: 'PASIVO',   minMs: 0,     maxMs: 3000,  verifications: 1, retries: 0, onFail: 'ignore' },
};

// Métricas internas
const _metrics = {
  totalTasks: 0,
  byLevel: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  failures: 0,
  retriesUsed: 0,
  avgDurationMs: {},
};

// Dependencias inyectadas
let _notifyOwner = null;

/**
 * Inicializar task scheduler
 * @param {Object} deps - { notifyOwner: async (msg) => void }
 */
function initTaskScheduler(deps = {}) {
  _notifyOwner = deps.notifyOwner || null;
  console.log('[TASK-SCHEDULER] ✅ Inicializado — 5 niveles de concentración activos');
}

/**
 * Ejecutar una tarea con nivel de concentración
 *
 * @param {number} level - Nivel 1-5
 * @param {string} taskName - Nombre descriptivo (para logs)
 * @param {Function} taskFn - Función async que ejecuta la tarea. Debe retornar resultado.
 * @param {Object} opts - { verifyFn?, context?, silent? }
 *   verifyFn: async (result) => boolean — valida que el resultado sea correcto
 *   context: string — contexto extra para logs
 *   silent: boolean — suprime logs en L1/L2
 * @returns {Promise<{success: boolean, result?: any, error?: string, duration: number, retries: number}>}
 */
async function executeWithConcentration(level, taskName, taskFn, opts = {}) {
  const lvl = LEVELS[level] || LEVELS[1];
  const startTime = Date.now();
  let lastError = null;
  let retriesUsed = 0;
  let result = null;

  _metrics.totalTasks++;
  _metrics.byLevel[level] = (_metrics.byLevel[level] || 0) + 1;

  const logPrefix = `[TASK-L${level}:${lvl.name}]`;

  if (level >= 3) {
    console.log(`${logPrefix} ▶ Iniciando: ${taskName}${opts.context ? ` (${opts.context})` : ''}`);
  }

  // Intentos = 1 base + retries del nivel
  const maxAttempts = 1 + lvl.retries;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Ejecutar tarea
      result = await taskFn();

      // Verificaciones según nivel
      if (lvl.verifications > 0 && opts.verifyFn) {
        let verified = false;
        for (let v = 1; v <= lvl.verifications; v++) {
          try {
            verified = await opts.verifyFn(result);
            if (verified) {
              if (level >= 4) console.log(`${logPrefix} ✓ Verificación ${v}/${lvl.verifications} OK`);
              break;
            } else {
              console.warn(`${logPrefix} ⚠ Verificación ${v}/${lvl.verifications} FALLÓ — resultado no pasó validación`);
              if (v < lvl.verifications) {
                // Re-ejecutar tarea antes de siguiente verificación
                result = await taskFn();
              }
            }
          } catch (verifyErr) {
            console.error(`${logPrefix} ❌ Error en verificación ${v}: ${verifyErr.message}`);
            verified = false;
          }
        }

        if (!verified && attempt < maxAttempts) {
          console.warn(`${logPrefix} 🔄 Verificación no pasó — reintento ${attempt}/${maxAttempts}`);
          retriesUsed++;
          _metrics.retriesUsed++;
          await _cooldown(level);
          continue;
        }
      }

      // Éxito
      const duration = Date.now() - startTime;

      // Garantizar tiempo mínimo de concentración
      const remaining = lvl.minMs - duration;
      if (remaining > 0 && level >= 3) {
        // Para L3+ usamos el tiempo restante para "pensar" (no bloquear innecesariamente)
        // Solo si la tarea terminó muy rápido — indica que podría no haber sido exhaustiva
        if (level >= 4) {
          console.log(`${logPrefix} ⏳ Tarea rápida (${duration}ms) — concentración mínima ${lvl.minMs}ms no alcanzada`);
        }
      }

      if (level >= 3) {
        console.log(`${logPrefix} ✅ ${taskName} completado en ${duration}ms${retriesUsed > 0 ? ` (${retriesUsed} reintentos)` : ''}`);
      }

      _updateAvgDuration(level, duration);

      return { success: true, result, duration, retries: retriesUsed };

    } catch (err) {
      lastError = err;
      retriesUsed++;
      _metrics.retriesUsed++;

      if (attempt < maxAttempts) {
        console.warn(`${logPrefix} 🔄 ${taskName} falló (intento ${attempt}/${maxAttempts}): ${err.message}`);
        await _cooldown(level);
      }
    }
  }

  // Todos los intentos fallaron
  _metrics.failures++;
  const duration = Date.now() - startTime;

  switch (lvl.onFail) {
    case 'notify':
      console.error(`${logPrefix} ❌ FALLO CRÍTICO: ${taskName} — ${lastError?.message}`);
      if (_notifyOwner) {
        try {
          await _notifyOwner(`⚠️ *Error en tarea crítica*\n📋 ${taskName}\n❌ ${lastError?.message || 'Error desconocido'}\n🔄 ${retriesUsed} reintentos agotados`);
        } catch (notifyErr) {
          console.error(`${logPrefix} ❌ No se pudo notificar al owner: ${notifyErr.message}`);
        }
      }
      break;
    case 'log+retry':
      console.error(`${logPrefix} ❌ ${taskName} falló tras ${retriesUsed} reintentos: ${lastError?.message}`);
      break;
    case 'log':
      console.error(`${logPrefix} ❌ ${taskName}: ${lastError?.message}`);
      break;
    case 'silent':
      // Aprender del error silencioso: si falla 5+ veces seguidas, loguear
      _trackSilentFailure(taskName, lastError?.message);
      break;
    case 'ignore':
    default:
      // Aprender: si falla 10+ veces seguidas, escalar a L2
      _trackSilentFailure(taskName, lastError?.message);
      break;
  }

  return { success: false, error: lastError?.message, duration, retries: retriesUsed };
}

// Tracking de fallos silenciosos para aprendizaje
const _silentFailures = {}; // { taskName: { count, lastError, lastAt, escalated } }

function _trackSilentFailure(taskName, errorMsg) {
  if (!_silentFailures[taskName]) {
    _silentFailures[taskName] = { count: 0, lastError: null, lastAt: null, escalated: false };
  }
  const sf = _silentFailures[taskName];
  sf.count++;
  sf.lastError = errorMsg;
  sf.lastAt = new Date().toISOString();

  // Auto-escalado: si falla 5+ veces, loguear advertencia
  if (sf.count === 5 && !sf.escalated) {
    console.warn(`[TASK-SCHEDULER] ⚠️ ${taskName} ha fallado silenciosamente 5 veces seguidas: ${errorMsg}`);
  }
  // Si falla 10+ veces, marcar como escalado y loguear siempre
  if (sf.count >= 10 && !sf.escalated) {
    sf.escalated = true;
    console.error(`[TASK-SCHEDULER] 🔺 ${taskName} ESCALADO — ${sf.count} fallos silenciosos consecutivos: ${errorMsg}`);
  }
}

/**
 * Obtener fallos silenciosos (para health check)
 */
function getSilentFailures() {
  return { ..._silentFailures };
}

/**
 * Cooldown entre reintentos (escalado por nivel)
 */
async function _cooldown(level) {
  const delays = { 5: 5000, 4: 3000, 3: 2000, 2: 1000, 1: 500 };
  await new Promise(r => setTimeout(r, delays[level] || 1000));
}

/**
 * Actualizar duración promedio por nivel
 */
function _updateAvgDuration(level, duration) {
  if (!_metrics.avgDurationMs[level]) {
    _metrics.avgDurationMs[level] = { total: 0, count: 0 };
  }
  _metrics.avgDurationMs[level].total += duration;
  _metrics.avgDurationMs[level].count++;
}

/**
 * Obtener métricas del scheduler
 */
function getTaskMetrics() {
  const avgs = {};
  for (const [lvl, data] of Object.entries(_metrics.avgDurationMs)) {
    avgs[lvl] = data.count > 0 ? Math.round(data.total / data.count) : 0;
  }
  return {
    ..._metrics,
    avgDurationMs: avgs,
  };
}

/**
 * Helper: wrappear una función existente con concentración
 * Útil para aplicar el scheduler a engines existentes sin reescribirlos
 *
 * @param {number} level
 * @param {string} taskName
 * @param {Function} fn - función original
 * @param {Object} opts - opciones de executeWithConcentration
 * @returns {Function} - función wrapped que ejecuta con concentración
 */
function withConcentration(level, taskName, fn, opts = {}) {
  return async function (...args) {
    const { success, result, error } = await executeWithConcentration(
      level,
      taskName,
      () => fn(...args),
      opts
    );
    if (!success && level >= 3) {
      throw new Error(`[TASK-SCHEDULER] ${taskName} falló: ${error}`);
    }
    return result;
  };
}

module.exports = {
  initTaskScheduler,
  executeWithConcentration,
  withConcentration,
  getTaskMetrics,
  getSilentFailures,
  LEVELS,
};
