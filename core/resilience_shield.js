/**
 * MIIA Resilience Shield v1.0 — Sistema de resiliencia centralizado
 *
 * Monitorea TODOS los sistemas críticos y actúa:
 * - Gemini/IA: créditos, rate limits, errores de API
 * - Firestore: cuotas, timeouts, errores de escritura
 * - WhatsApp/Baileys: cubierto por Dual-Engine F1 en tenant_manager.js
 * - Node.js: OOM, uncaught exceptions, unhandled rejections
 * - Railway: restarts, SIGTERM, health checks
 *
 * Filosofía: Cada fallo registrado alimenta un dashboard de salud.
 * Si un sistema acumula fallos, MIIA toma acción preventiva.
 */

// ═══════════════════════════════════════════════════
// HEALTH STATE — Estado de salud de cada subsistema
// ═══════════════════════════════════════════════════

const SYSTEMS = {
  GEMINI: 'gemini',
  FIRESTORE: 'firestore',
  WHATSAPP: 'whatsapp',
  NODE: 'node'
};

const healthState = {
  gemini: { health: 100, consecutiveFails: 0, lastFail: null, lastFailReason: '', totalFails: 0, circuitOpen: false, circuitOpenedAt: null },
  firestore: { health: 100, consecutiveFails: 0, lastFail: null, lastFailReason: '', totalFails: 0, circuitOpen: false, circuitOpenedAt: null },
  whatsapp: { health: 100, consecutiveFails: 0, lastFail: null, lastFailReason: '', totalFails: 0 },
  node: { health: 100, unhandledErrors: 0, lastError: null, oomWarnings: 0 }
};

// Circuit breaker: si un sistema falla N veces seguidas, dejamos de intentar por un rato
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000; // 1 minuto

// ═══════════════════════════════════════════════════
// RECORD FAIL / SUCCESS
// ═══════════════════════════════════════════════════

/**
 * Registrar un fallo en un subsistema.
 * @param {string} system - SYSTEMS.GEMINI, SYSTEMS.FIRESTORE, etc.
 * @param {string} reason - Descripción corta del fallo
 * @param {object} [meta] - Metadata adicional (statusCode, etc.)
 * @returns {{ circuitOpened: boolean, health: number }}
 */
function recordFail(system, reason, meta = {}) {
  const s = healthState[system];
  if (!s) return { circuitOpened: false, health: 0 };

  s.consecutiveFails++;
  s.totalFails++;
  s.health = Math.max(0, s.health - 15);
  s.lastFail = Date.now();
  s.lastFailReason = reason;

  const emoji = system === 'gemini' ? '🧠' : system === 'firestore' ? '🔥' : system === 'whatsapp' ? '📱' : '⚙️';
  console.error(`[SHIELD] ${emoji} ${system.toUpperCase()} FAIL #${s.consecutiveFails}: ${reason} | Health: ${s.health}/100${meta.statusCode ? ` | HTTP ${meta.statusCode}` : ''}`);

  // Circuit breaker
  let circuitOpened = false;
  if (s.circuitOpen !== undefined && s.consecutiveFails >= CIRCUIT_BREAKER_THRESHOLD && !s.circuitOpen) {
    s.circuitOpen = true;
    s.circuitOpenedAt = Date.now();
    circuitOpened = true;
    console.error(`[SHIELD] 🔴 CIRCUIT OPEN: ${system.toUpperCase()} — pausando operaciones por ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s`);
  }

  // Auto-recovery: si hay un UID configurado, intentar recuperar automáticamente
  if (_activeOwnerUid && s.consecutiveFails >= 3) {
    autoRecover(system, reason, _activeOwnerUid).catch((err) =>
      console.error(`[SHIELD] autoRecover failed: ${err.message}`) // BUG-B: .catch() explicito
    );
  }

  return { circuitOpened, health: s.health };
}

// Owner UID activo para notificaciones automáticas
let _activeOwnerUid = null;
function setActiveOwnerUid(uid) { _activeOwnerUid = uid; }

/**
 * Registrar éxito en un subsistema. Resetea consecutive fails y recupera salud.
 * @param {string} system
 */
function recordSuccess(system) {
  const s = healthState[system];
  if (!s) return;

  s.consecutiveFails = 0;
  s.health = Math.min(100, s.health + 5);

  // Cerrar circuit breaker si estaba abierto
  if (s.circuitOpen) {
    s.circuitOpen = false;
    s.circuitOpenedAt = null;
    console.log(`[SHIELD] 🟢 CIRCUIT CLOSED: ${system.toUpperCase()} — operaciones restauradas`);
  }
}

/**
 * ¿El circuito está abierto para este sistema?
 * Si pasó el cooldown, lo cerramos automáticamente (half-open → permite 1 intento).
 * @param {string} system
 * @returns {boolean}
 */
function isCircuitOpen(system) {
  const s = healthState[system];
  if (!s || !s.circuitOpen) return false;
  if (!s.circuitOpenedAt) return false; // BUG-A fix: evita NaN si circuitOpenedAt es null

  // Auto-close después del cooldown (half-open: permite re-intentar)
  if (Date.now() - s.circuitOpenedAt > CIRCUIT_BREAKER_COOLDOWN_MS) {
    s.circuitOpen = false;
    s.circuitOpenedAt = null;
    console.log(`[SHIELD] 🟡 CIRCUIT HALF-OPEN: ${system.toUpperCase()} — permitiendo 1 intento`);
    return false;
  }

  return true;
}

// ═══════════════════════════════════════════════════
// GEMINI-SPECIFIC: Detectar créditos agotados
// ═══════════════════════════════════════════════════

/**
 * Analizar un error de Gemini y clasificarlo.
 * @param {number} statusCode
 * @param {string} errorBody
 * @returns {{ type: string, isFatal: boolean, action: string }}
 */
function classifyGeminiError(statusCode, errorBody = '') {
  const bodyLower = errorBody.toLowerCase();

  if (statusCode === 429) {
    if (bodyLower.includes('quota') || bodyLower.includes('resource_exhausted')) {
      return { type: 'QUOTA_EXHAUSTED', isFatal: true, action: 'Rotar a key de backup o pausar IA' };
    }
    return { type: 'RATE_LIMIT', isFatal: false, action: 'Retry con backoff' };
  }

  if (statusCode === 403) {
    if (bodyLower.includes('billing') || bodyLower.includes('disabled') || bodyLower.includes('not enabled')) {
      return { type: 'BILLING_DISABLED', isFatal: true, action: 'API key sin billing — requiere intervención manual' };
    }
    return { type: 'FORBIDDEN', isFatal: true, action: 'Verificar permisos de API key' };
  }

  if (statusCode === 503 || statusCode === 500) {
    return { type: 'SERVER_ERROR', isFatal: false, action: 'Retry con backoff' };
  }

  if (statusCode === 400) {
    if (bodyLower.includes('safety') || bodyLower.includes('blocked')) {
      return { type: 'SAFETY_BLOCKED', isFatal: false, action: 'Reformular prompt' };
    }
    return { type: 'BAD_REQUEST', isFatal: false, action: 'Verificar payload' };
  }

  return { type: 'UNKNOWN', isFatal: false, action: `HTTP ${statusCode} — investigar` };
}

// ═══════════════════════════════════════════════════
// NODE.JS: Captura global de errores
// ═══════════════════════════════════════════════════

/**
 * Registrar error no manejado de Node.js
 * @param {string} type - 'uncaughtException' | 'unhandledRejection'
 * @param {Error} err
 */
function recordNodeError(type, err) {
  healthState.node.unhandledErrors++;
  healthState.node.lastError = { type, message: err?.message, stack: err?.stack?.substring(0, 300), at: Date.now() };
  healthState.node.health = Math.max(0, healthState.node.health - 10);

  console.error(`[SHIELD] ⚙️ NODE ${type}: ${err?.message} | Total unhandled: ${healthState.node.unhandledErrors} | Health: ${healthState.node.health}/100`);
}

/**
 * Monitorear memoria de Node.js. Llamar periódicamente.
 * Si supera el threshold, loguear warning.
 * @param {number} [thresholdMB=450] - MB de heap antes de alertar
 * @returns {{ heapUsedMB: number, warning: boolean }}
 */
function checkMemory(thresholdMB = 450) {
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const warning = heapUsedMB > thresholdMB;

  if (warning) {
    healthState.node.oomWarnings++;
    healthState.node.health = Math.max(0, healthState.node.health - 5);
    console.warn(`[SHIELD] ⚠️ MEMORY WARNING: ${heapUsedMB}MB / ${thresholdMB}MB threshold | OOM warnings: ${healthState.node.oomWarnings}`);
  }

  return { heapUsedMB, warning };
}

// ═══════════════════════════════════════════════════
// DASHBOARD: Estado completo de salud
// ═══════════════════════════════════════════════════

/**
 * Obtener estado completo de salud de todos los sistemas.
 * Útil para endpoint /api/health o para logging periódico.
 * @returns {object}
 */
function getHealthDashboard() {
  const mem = process.memoryUsage();
  return {
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024)
    },
    systems: {
      gemini: {
        health: healthState.gemini.health,
        consecutiveFails: healthState.gemini.consecutiveFails,
        totalFails: healthState.gemini.totalFails,
        circuitOpen: healthState.gemini.circuitOpen,
        lastFailReason: healthState.gemini.lastFailReason
      },
      firestore: {
        health: healthState.firestore.health,
        consecutiveFails: healthState.firestore.consecutiveFails,
        totalFails: healthState.firestore.totalFails,
        circuitOpen: healthState.firestore.circuitOpen,
        lastFailReason: healthState.firestore.lastFailReason
      },
      whatsapp: {
        health: healthState.whatsapp.health,
        consecutiveFails: healthState.whatsapp.consecutiveFails,
        totalFails: healthState.whatsapp.totalFails
      },
      node: {
        health: healthState.node.health,
        unhandledErrors: healthState.node.unhandledErrors,
        oomWarnings: healthState.node.oomWarnings
      }
    },
    overall: Math.round(
      (healthState.gemini.health + healthState.firestore.health + healthState.whatsapp.health + healthState.node.health) / 4
    )
  };
}

// ═══════════════════════════════════════════════════
// SELF-NOTIFY: Avisar al owner via self-chat
// ═══════════════════════════════════════════════════

// Referencia al sender function — se setea desde server.js
let _notifySelfChat = null;

/**
 * Configurar la función de notificación al self-chat del owner.
 * Llamar una vez desde server.js después de tener acceso a safeSendMessage.
 * @param {function} fn - async (uid, message) => void
 */
function setNotifyFunction(fn) {
  _notifySelfChat = fn;
}

/**
 * Notificar al owner de un problema crítico via self-chat.
 * Rate limited: máximo 1 notificación por sistema cada 5 minutos.
 * @param {string} uid - Owner UID
 * @param {string} system - Sistema afectado
 * @param {string} message - Mensaje para el owner
 */
const _lastNotified = {};
async function notifyOwner(uid, system, message) {
  if (!_notifySelfChat) return;

  const key = `${uid}:${system}`;
  const now = Date.now();
  if (_lastNotified[key] && now - _lastNotified[key] < 5 * 60_000) return; // Max 1 cada 5min por sistema
  _lastNotified[key] = now;

  try {
    await _notifySelfChat(uid, `⚠️ **ALERTA SISTEMA** — ${system.toUpperCase()}\n${message}`);
    console.log(`[SHIELD] 📨 Notificación enviada al owner ${uid}: ${system}`);
  } catch (e) {
    console.error(`[SHIELD] Error notificando al owner: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════
// RECOVERY PLAYBOOK — Auto-reparación por patrones
// ═══════════════════════════════════════════════════

/**
 * Playbook de recuperación automática.
 * Cada entrada: patrón de error → acción de recuperación.
 * Si el error no matchea ningún patrón → se loguea como UNKNOWN para codificarlo después.
 *
 * Cubre: Gemini (rate limit, quota, billing, safety), Firestore (timeout, permission),
 *        WhatsApp (440, 515, timeout, ban), Node (OOM, unhandled)
 */
const RECOVERY_PLAYBOOK = [
  // ─── GEMINI ───
  { pattern: /429|rate.?limit/i, system: 'gemini', action: 'ROTATE_KEY', description: 'Rotar a API key alternativa' },
  { pattern: /quota|resource.?exhausted/i, system: 'gemini', action: 'ROTATE_KEY_AND_PAUSE', description: 'Rotar key + circuit breaker 60s' },
  { pattern: /403.*billing|billing.*disabled/i, system: 'gemini', action: 'NOTIFY_OWNER', description: 'Billing deshabilitado — requiere acción manual' },
  { pattern: /503|500|overloaded|internal/i, system: 'gemini', action: 'RETRY_BACKOFF', description: 'Retry con backoff exponencial' },
  { pattern: /safety|blocked|harm/i, system: 'gemini', action: 'REFORMULATE', description: 'Prompt bloqueado — reformular' },
  { pattern: /timeout|ETIMEDOUT|ECONNRESET/i, system: 'gemini', action: 'RETRY_BACKOFF', description: 'Timeout de red — retry' },

  // ─── FIRESTORE ───
  { pattern: /quota|resource.?exhausted/i, system: 'firestore', action: 'CIRCUIT_BREAK', description: 'Firestore quota — pausar escrituras' },
  { pattern: /permission|PERMISSION_DENIED/i, system: 'firestore', action: 'NOTIFY_OWNER', description: 'Permisos de Firestore incorrectos' },
  { pattern: /deadline|DEADLINE_EXCEEDED|timeout/i, system: 'firestore', action: 'RETRY_BACKOFF', description: 'Firestore timeout — retry' },
  { pattern: /unavailable|UNAVAILABLE/i, system: 'firestore', action: 'RETRY_BACKOFF', description: 'Firestore caído temporalmente' },

  // ─── WHATSAPP ───
  { pattern: /440|connection.?replaced/i, system: 'whatsapp', action: 'ENGINE_SWITCH', description: 'Socket duplicado — switch engine' },
  { pattern: /515|restart/i, system: 'whatsapp', action: 'RECONNECT_BACKOFF', description: 'Server restart — reconectar con backoff' },
  { pattern: /401|logged.?out/i, system: 'whatsapp', action: 'NOTIFY_OWNER', description: 'Sesión cerrada — requiere re-escaneo QR' },
  { pattern: /Bad MAC|decrypt/i, system: 'whatsapp', action: 'BLOCK_CREDS_WRITE', description: 'Crypto error — bloquear escritura de creds' },
  { pattern: /timeout|ETIMEDOUT/i, system: 'whatsapp', action: 'RECONNECT_BACKOFF', description: 'Timeout — reconectar con backoff' },

  // ─── NODE ───
  { pattern: /heap|memory|ENOMEM/i, system: 'node', action: 'GC_HINT', description: 'Memoria alta — sugerir GC' },
  { pattern: /ENOSPC/i, system: 'node', action: 'NOTIFY_OWNER', description: 'Disco lleno — requiere limpieza' },
];

/**
 * Buscar una estrategia de recuperación para un error.
 * @param {string} system - Sistema afectado
 * @param {string} errorString - Mensaje de error o código
 * @returns {{ action: string, description: string, isKnown: boolean }}
 */
function findRecoveryStrategy(system, errorString) {
  for (const entry of RECOVERY_PLAYBOOK) {
    if (entry.system === system && entry.pattern.test(errorString)) {
      return { action: entry.action, description: entry.description, isKnown: true };
    }
  }
  // Cross-system: buscar sin filtrar por sistema (por si el patrón es genérico)
  for (const entry of RECOVERY_PLAYBOOK) {
    if (entry.pattern.test(errorString)) {
      return { action: entry.action, description: `(cross-match from ${entry.system}) ${entry.description}`, isKnown: true };
    }
  }

  // UNKNOWN — loguear para que se codifique en la próxima sesión de desarrollo
  console.warn(`[SHIELD] ❓ UNKNOWN ERROR PATTERN: system=${system} error="${errorString}" — adding to unknown log for future playbook entry`);
  _unknownErrors.push({ system, error: errorString, at: Date.now() });
  // Mantener solo los últimos 50 unknown errors
  if (_unknownErrors.length > 50) _unknownErrors.shift();

  return { action: 'CIRCUIT_BREAK', description: 'Fallo desconocido — circuit breaker preventivo + notificar owner', isKnown: false };
}

// Log de errores desconocidos — para revisión en desarrollo
const _unknownErrors = [];
function getUnknownErrors() { return [..._unknownErrors]; }

/**
 * Ejecutar la acción de recuperación automáticamente.
 * @param {string} system
 * @param {string} errorString
 * @param {string} uid - Owner UID para notificaciones
 * @returns {Promise<{ action: string, executed: boolean }>}
 */
async function autoRecover(system, errorString, uid) {
  const strategy = findRecoveryStrategy(system, errorString);
  console.log(`[SHIELD] 🔧 Recovery: ${strategy.action} — ${strategy.description} | known=${strategy.isKnown}`);

  switch (strategy.action) {
    case 'ROTATE_KEY':
      // La rotación ya la maneja callGeminiAPI/generateAIContent
      return { action: strategy.action, executed: true };

    case 'ROTATE_KEY_AND_PAUSE':
      // Abrir circuit breaker para dar tiempo al rate limit
      if (healthState[system]) {
        healthState[system].circuitOpen = true;
        healthState[system].circuitOpenedAt = Date.now();
      }
      return { action: strategy.action, executed: true };

    case 'RETRY_BACKOFF':
      // El retry lo maneja el caller — solo confirmamos que es retriable
      return { action: strategy.action, executed: true };

    case 'CIRCUIT_BREAK':
      if (healthState[system] && healthState[system].circuitOpen !== undefined) {
        healthState[system].circuitOpen = true;
        healthState[system].circuitOpenedAt = Date.now();
        console.log(`[SHIELD] 🔴 Circuit breaker activado para ${system} (auto-recovery)`);
      }
      if (!strategy.isKnown && uid) {
        await notifyOwner(uid, system, `Fallo desconocido detectado: "${errorString}". Circuit breaker activado. Revisar logs.`);
      }
      return { action: strategy.action, executed: true };

    case 'NOTIFY_OWNER':
      if (uid) {
        await notifyOwner(uid, system, `${strategy.description}\nError: ${errorString}`);
      }
      return { action: strategy.action, executed: true };

    case 'ENGINE_SWITCH':
      // Lo maneja Dual-Engine F1 en tenant_manager.js
      return { action: strategy.action, executed: true };

    case 'RECONNECT_BACKOFF':
      // Lo maneja tenant_manager.js
      return { action: strategy.action, executed: true };

    case 'BLOCK_CREDS_WRITE':
      // Lo maneja baileys_session_store.js
      return { action: strategy.action, executed: true };

    case 'GC_HINT':
      if (global.gc) {
        global.gc();
        console.log(`[SHIELD] 🧹 GC ejecutado manualmente`);
      }
      return { action: strategy.action, executed: !!global.gc };

    case 'REFORMULATE':
      // El caller debe reformular — no podemos hacerlo acá
      return { action: strategy.action, executed: false };

    default:
      return { action: strategy.action, executed: false };
  }
}

// ═══════════════════════════════════════════════════
// PERIODIC HEALTH LOG
// ═══════════════════════════════════════════════════

let _healthInterval = null;

/**
 * Iniciar logging periódico de salud.
 * @param {number} [intervalMs=300000] - Cada cuánto loguear (default: 5 min)
 */
function startHealthMonitor(intervalMs = 300_000) {
  if (_healthInterval) clearInterval(_healthInterval);

  _healthInterval = setInterval(() => {
    const dashboard = getHealthDashboard();
    const status = dashboard.overall >= 80 ? '🟢' : dashboard.overall >= 50 ? '🟡' : '🔴';
    console.log(`[SHIELD] ${status} HEALTH: overall=${dashboard.overall}/100 | gemini=${dashboard.systems.gemini.health} firestore=${dashboard.systems.firestore.health} whatsapp=${dashboard.systems.whatsapp.health} node=${dashboard.systems.node.health} | heap=${dashboard.memory.heapUsedMB}MB | uptime=${dashboard.uptime}s`);

    // Memory check
    checkMemory(450);

    // Recuperación pasiva: si un sistema no ha fallado en 5+ minutos, recuperar +2 health
    const now = Date.now();
    for (const sys of ['gemini', 'firestore', 'whatsapp']) {
      const s = healthState[sys];
      if (s.health < 100 && s.consecutiveFails === 0 && (!s.lastFail || now - s.lastFail > 5 * 60_000)) {
        s.health = Math.min(100, s.health + 2);
      }
    }
    // Node health recovery: si no hubo errores en los últimos 5 minutos, recuperar
    const noRecentNodeErrors = !healthState.node.lastError || (now - healthState.node.lastError.at > 5 * 60_000);
    if (healthState.node.health < 100 && noRecentNodeErrors) {
      healthState.node.health = Math.min(100, healthState.node.health + 2);
      // Reset counter gradualmente cuando la salud se recupera por completo
      if (healthState.node.health >= 100) {
        healthState.node.unhandledErrors = 0;
      }
    }
  }, intervalMs);

  console.log(`[SHIELD] 🛡️ Resilience Shield v1.0 iniciado — health check cada ${intervalMs / 1000}s`);
}

module.exports = {
  SYSTEMS,
  recordFail,
  recordSuccess,
  isCircuitOpen,
  classifyGeminiError,
  recordNodeError,
  checkMemory,
  getHealthDashboard,
  setNotifyFunction,
  notifyOwner,
  startHealthMonitor,
  findRecoveryStrategy,
  autoRecover,
  getUnknownErrors,
  setActiveOwnerUid
};
