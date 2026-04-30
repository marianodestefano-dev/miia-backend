'use strict';

/**
 * RATE LIMITER v1.0 — Auto-límite inteligente para sobrevivir en WhatsApp
 *
 * MIIA se auto-regula SIN que el owner configure nada (Decisión #14).
 *
 * 5 NIVELES basados en ventana rolling de 24 horas:
 *   🟢 GREEN  (<60%)  → Normal, sin restricciones
 *   🟡 YELLOW (60-75%) → Empezar a espaciar respuestas
 *   🟠 ORANGE (75-90%) → Respuestas más cortas, delays más largos
 *   🔴 RED    (90-95%) → Solo urgentes (self-chat + familia urgente)
 *   ⛔ STOP   (95-100%) → SILENCIO TOTAL excepto self-chat
 *
 * Límites WhatsApp estimados (Baileys, cuenta personal):
 *   - ~250 mensajes salientes / 24h es zona segura
 *   - ~400 es zona de riesgo
 *   - ~500+ es ban casi seguro
 *
 * MIIA explica pausas naturalmente en self-chat cuando sube de nivel.
 */

// ═══════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════

const DEFAULT_DAILY_LIMIT = 250; // Mensajes salientes / 24h (zona segura)

const LEVELS = {
  GREEN:  { name: 'GREEN',  emoji: '🟢', minPct: 0,   maxPct: 60,  delayMultiplier: 1.0, maxMsgLength: null, allowLeads: true,  allowFamily: true },
  YELLOW: { name: 'YELLOW', emoji: '🟡', minPct: 60,  maxPct: 75,  delayMultiplier: 1.5, maxMsgLength: null, allowLeads: true,  allowFamily: true },
  ORANGE: { name: 'ORANGE', emoji: '🟠', minPct: 75,  maxPct: 90,  delayMultiplier: 2.5, maxMsgLength: 500,  allowLeads: true,  allowFamily: true },
  RED:    { name: 'RED',    emoji: '🔴', minPct: 90,  maxPct: 95,  delayMultiplier: 4.0, maxMsgLength: 300,  allowLeads: false, allowFamily: true },
  STOP:   { name: 'STOP',   emoji: '⛔', minPct: 95,  maxPct: 100, delayMultiplier: 0,   maxMsgLength: 0,    allowLeads: false, allowFamily: false },
};

// ═══════════════════════════════════════════════════════════
// ESTADO POR TENANT (en memoria, no persiste — se resetea con restart)
// ═══════════════════════════════════════════════════════════

// { tenantUid: { timestamps: [epoch, epoch, ...], lastLevel: 'GREEN', lastNotified: epoch } }
const _state = {};

function _getState(uid) {
  if (!_state[uid]) {
    _state[uid] = { timestamps: [], lastLevel: 'GREEN', lastNotified: 0 };
  }
  return _state[uid];
}

// ═══════════════════════════════════════════════════════════
// FUNCIONES PRINCIPALES
// ═══════════════════════════════════════════════════════════

/**
 * Registrar un mensaje saliente
 * @param {string} uid - Tenant UID
 */
function recordOutgoing(uid) {
  const state = _getState(uid);
  state.timestamps.push(Date.now());
  // Limpiar timestamps >24h para no acumular memoria
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  state.timestamps = state.timestamps.filter(t => t >= cutoff);
}

/**
 * Obtener cantidad de mensajes en las últimas 24h
 * @param {string} uid - Tenant UID
 * @returns {number}
 */
function getCount24h(uid) {
  const state = _getState(uid);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  state.timestamps = state.timestamps.filter(t => t >= cutoff);
  return state.timestamps.length;
}

/**
 * Obtener nivel actual de auto-límite
 * @param {string} uid - Tenant UID
 * @param {number} [dailyLimit] - Límite personalizado (default 250)
 * @returns {{ level: object, count: number, pct: number, remaining: number }}
 */
function getLevel(uid, dailyLimit = DEFAULT_DAILY_LIMIT) {
  const count = getCount24h(uid);
  const pct = Math.min(100, (count / dailyLimit) * 100);

  let level = LEVELS.GREEN;
  if (pct >= 95) level = LEVELS.STOP;
  else if (pct >= 90) level = LEVELS.RED;
  else if (pct >= 75) level = LEVELS.ORANGE;
  else if (pct >= 60) level = LEVELS.YELLOW;

  return {
    level,
    count,
    pct: Math.round(pct),
    remaining: Math.max(0, dailyLimit - count),
  };
}

/**
 * ¿MIIA debe responder a este tipo de contacto dado el nivel actual?
 *
 * @param {string} uid - Tenant UID
 * @param {string} contactType - 'owner'|'lead'|'familia'|'equipo'|'group'
 * @param {number} [dailyLimit] - Límite personalizado
 * @returns {{ allowed: boolean, level: object, reason: string, delayMultiplier: number, maxMsgLength: number|null }}
 */
function shouldRespond(uid, contactType, dailyLimit = DEFAULT_DAILY_LIMIT) {
  const { level, count, pct, remaining } = getLevel(uid, dailyLimit);
  const state = _getState(uid);

  // Self-chat del owner → SIEMPRE permitido (es la esencia de MIIA)
  if (contactType === 'owner') {
    return {
      allowed: true,
      level,
      reason: 'self-chat always allowed',
      delayMultiplier: level.delayMultiplier,
      maxMsgLength: level.maxMsgLength,
    };
  }

  // STOP → solo self-chat
  if (level.name === 'STOP') {
    return { allowed: false, level, reason: `STOP (${pct}%) — solo self-chat`, delayMultiplier: 0, maxMsgLength: 0 };
  }

  // RED → solo self-chat + familia urgente
  if (level.name === 'RED') {
    if (contactType === 'familia' || contactType === 'equipo') {
      return { allowed: true, level, reason: `RED — familia/equipo permitido`, delayMultiplier: level.delayMultiplier, maxMsgLength: level.maxMsgLength };
    }
    return { allowed: false, level, reason: `RED (${pct}%) — leads bloqueados`, delayMultiplier: 0, maxMsgLength: 0 };
  }

  // GREEN/YELLOW/ORANGE → leads y familia permitidos
  return {
    allowed: true,
    level,
    reason: `${level.name} (${pct}%) — ${remaining} msgs restantes`,
    delayMultiplier: level.delayMultiplier,
    maxMsgLength: level.maxMsgLength,
  };
}

/**
 * Generar mensaje natural para self-chat cuando MIIA sube de nivel
 *
 * @param {string} oldLevel - Nivel anterior
 * @param {string} newLevel - Nivel nuevo
 * @param {number} remaining - Mensajes restantes
 * @returns {string|null} Mensaje para self-chat (null si no cambió de nivel)
 */
function getLevelChangeMessage(oldLevel, newLevel, remaining) {
  if (oldLevel === newLevel) return null;

  switch (newLevel) {
    case 'YELLOW':
      return `💡 Ey, vengo mandando bastantes mensajes hoy (${remaining} me quedan para estar tranqui). Voy a espaciar un poquito las respuestas para no levantar sospechas 😉`;
    case 'ORANGE':
      return `⚠️ Ojo, ya mandé muchos mensajes hoy. Voy a ser más concisa y tardar un poco más en responder. Si hay algo urgente, escribime y lo priorizo.`;
    case 'RED':
      return `🔴 Llegué al límite seguro del día. Solo voy a responder a tu familia y a vos. Los leads van a tener que esperar hasta mañana. Mejor prevenir que lamentar.`;
    case 'STOP':
      return `⛔ Frené todo. Mandé demasiados mensajes hoy y no quiero que WhatsApp sospeche. Solo te respondo a vos. Mañana arrancamos fresh.`;
    case 'GREEN':
      return `🟢 Todo tranqui de nuevo, ya se liberó el cupo de mensajes. Vuelvo a responder normal a todos.`;
    default:
      return null;
  }
}

/**
 * Verificar si hubo cambio de nivel y retornar notificación si corresponde
 *
 * @param {string} uid - Tenant UID
 * @param {number} [dailyLimit]
 * @returns {{ changed: boolean, message: string|null, oldLevel: string, newLevel: string }}
 */
function checkLevelChange(uid, dailyLimit = DEFAULT_DAILY_LIMIT) {
  const state = _getState(uid);
  const { level, remaining } = getLevel(uid, dailyLimit);
  const oldLevel = state.lastLevel;
  const newLevel = level.name;

  if (oldLevel !== newLevel) {
    state.lastLevel = newLevel;
    const now = Date.now();
    // No notificar más de 1 vez cada 30 min por cambio de nivel
    if (now - state.lastNotified < 30 * 60 * 1000) {
      return { changed: true, message: null, oldLevel, newLevel };
    }
    state.lastNotified = now;
    const message = getLevelChangeMessage(oldLevel, newLevel, remaining);
    console.log(`[RATE-LIMITER] ${level.emoji} ${uid.substring(0, 8)}... nivel: ${oldLevel} → ${newLevel} (${remaining} restantes)`);
    return { changed: true, message, oldLevel, newLevel };
  }

  return { changed: false, message: null, oldLevel, newLevel };
}

/**
 * Métricas para health endpoint
 * @returns {object}
 */
function getMetrics() {
  const result = {};
  for (const [uid, state] of Object.entries(_state)) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const count = state.timestamps.filter(t => t >= cutoff).length;
    result[uid.substring(0, 8)] = { count, level: state.lastLevel };
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// CIRCUIT BREAKER — Protección contra cascada de fallos en APIs externas
// ═══════════════════════════════════════════════════════════════
//
// Si una API (Gemini, Gmail, Calendar) falla N veces consecutivas,
// el circuit breaker se "abre" y rechaza requests por un cooldown period.
// Esto evita gastar recursos en requests que van a fallar.
//
// Estados: CLOSED (normal) → OPEN (bloqueado) → HALF_OPEN (probando)

const _circuits = {};
const CB_FAILURE_THRESHOLD = 3;   // Fallos consecutivos para abrir
const CB_COOLDOWN_MS = 30_000;    // 30s de cooldown antes de probar de nuevo
const CB_SUCCESS_TO_CLOSE = 2;    // Éxitos consecutivos en HALF_OPEN para cerrar

/**
 * Obtener o crear circuit breaker para un servicio.
 * @param {string} service - Nombre del servicio ('gemini', 'gmail', 'calendar', etc.)
 * @returns {Object} Estado del circuit
 */
function _getCircuit(service) {
  if (!_circuits[service]) {
    _circuits[service] = {
      state: 'CLOSED',          // CLOSED | OPEN | HALF_OPEN
      failures: 0,
      successes: 0,
      lastFailure: null,
      lastStateChange: Date.now(),
      totalFailures: 0,
      totalSuccess: 0,
    };
  }
  return _circuits[service];
}

/**
 * ¿El circuit breaker permite ejecutar una request a este servicio?
 * @param {string} service - Nombre del servicio
 * @returns {{ allowed: boolean, state: string, reason: string }}
 */
function circuitAllows(service) {
  const circuit = _getCircuit(service);

  if (circuit.state === 'CLOSED') {
    return { allowed: true, state: 'CLOSED', reason: 'circuit closed (normal)' };
  }

  if (circuit.state === 'OPEN') {
    // ¿Ya pasó el cooldown?
    if (Date.now() - circuit.lastStateChange > CB_COOLDOWN_MS) {
      circuit.state = 'HALF_OPEN';
      circuit.successes = 0;
      circuit.lastStateChange = Date.now();
      console.log(`[CIRCUIT-BREAKER] 🟡 ${service}: OPEN → HALF_OPEN (probando)`);
      return { allowed: true, state: 'HALF_OPEN', reason: 'testing after cooldown' };
    }
    return { allowed: false, state: 'OPEN', reason: `circuit open — cooldown ${Math.ceil((CB_COOLDOWN_MS - (Date.now() - circuit.lastStateChange)) / 1000)}s` };
  }

  // HALF_OPEN → dejar pasar para probar
  return { allowed: true, state: 'HALF_OPEN', reason: 'half-open test request' };
}

/**
 * Registrar éxito de una request.
 * @param {string} service
 */
function circuitSuccess(service) {
  const circuit = _getCircuit(service);
  circuit.totalSuccess++;

  if (circuit.state === 'HALF_OPEN') {
    circuit.successes++;
    if (circuit.successes >= CB_SUCCESS_TO_CLOSE) {
      circuit.state = 'CLOSED';
      circuit.failures = 0;
      circuit.lastStateChange = Date.now();
      console.log(`[CIRCUIT-BREAKER] 🟢 ${service}: HALF_OPEN → CLOSED (recovered)`);
    }
  } else if (circuit.state === 'CLOSED') {
    circuit.failures = 0; // Reset en éxito
  }
}

/**
 * Registrar fallo de una request.
 * @param {string} service
 * @param {string} [error] - Mensaje de error
 */
function circuitFailure(service, error = '') {
  const circuit = _getCircuit(service);
  circuit.failures++;
  circuit.totalFailures++;
  circuit.lastFailure = { ts: new Date().toISOString(), error };

  if (circuit.state === 'HALF_OPEN') {
    // Fallo en prueba → volver a OPEN
    circuit.state = 'OPEN';
    circuit.lastStateChange = Date.now();
    console.warn(`[CIRCUIT-BREAKER] 🔴 ${service}: HALF_OPEN → OPEN (test failed: ${error})`);
  } else if (circuit.state === 'CLOSED' && circuit.failures >= CB_FAILURE_THRESHOLD) {
    circuit.state = 'OPEN';
    circuit.lastStateChange = Date.now();
    console.error(`[CIRCUIT-BREAKER] 🔴 ${service}: CLOSED → OPEN (${circuit.failures} consecutive failures: ${error})`);
  }
}

/**
 * Estado de todos los circuit breakers para monitoreo.
 */
function getCircuitStatus() {
  const result = {};
  for (const [service, circuit] of Object.entries(_circuits)) {
    result[service] = {
      state: circuit.state,
      failures: circuit.failures,
      totalFailures: circuit.totalFailures,
      totalSuccess: circuit.totalSuccess,
      lastFailure: circuit.lastFailure,
    };
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// PER-CONTACT RATE LIMIT — Max mensajes por contacto por minuto
// ═══════════════════════════════════════════════════════════════

const _contactLimits = {}; // { "uid:phone": [timestamp, ...] }
const CONTACT_WINDOW_MS = 30_000; // Ventana de 30 segundos (ajuste C-019)
const CONTACT_MAX_FAMILY = 10;    // Familia/equipo: 10 msgs / 30s
const CONTACT_MAX_DEFAULT = 5;    // Leads/clientes/unknown: 5 msgs / 30s

/**
 * ¿Se puede enviar un mensaje más a este contacto?
 * Per-tenant isolation: cada tenant tiene su propio contador.
 * Límites diferenciados: familia/equipo=10, resto=5 (ajuste C-019).
 * @param {string} uid - UID del tenant
 * @param {string} phone - JID del contacto destino
 * @param {string} [contactType] - Tipo de contacto (familia, equipo, lead, etc.)
 * @returns {boolean}
 */
function contactAllows(uid, phone, contactType) {
  const key = `${uid}:${phone}`;
  if (!_contactLimits[key]) _contactLimits[key] = [];
  const cutoff = Date.now() - CONTACT_WINDOW_MS;
  _contactLimits[key] = _contactLimits[key].filter(t => t >= cutoff);
  const max = (contactType === 'familia' || contactType === 'equipo') ? CONTACT_MAX_FAMILY : CONTACT_MAX_DEFAULT;
  return _contactLimits[key].length < max;
}

/**
 * Registrar envío a contacto.
 * @param {string} uid - UID del tenant
 * @param {string} phone - JID del contacto destino
 */
function contactRecord(uid, phone) {
  const key = `${uid}:${phone}`;
  if (!_contactLimits[key]) _contactLimits[key] = [];
  _contactLimits[key].push(Date.now());
}

module.exports = {
  // Rate limiter original
  recordOutgoing,
  getCount24h,
  getLevel,
  shouldRespond,
  getLevelChangeMessage,
  checkLevelChange,
  getMetrics,
  LEVELS,
  DEFAULT_DAILY_LIMIT,
  // Circuit breaker
  circuitAllows,
  circuitSuccess,
  circuitFailure,
  getCircuitStatus,
  CB_FAILURE_THRESHOLD,
  CB_COOLDOWN_MS,
  CB_SUCCESS_TO_CLOSE,
  // Per-contact limit (ajuste C-019: ventana 30s, familia=10, resto=5)
  contactAllows,
  contactRecord,
  CONTACT_WINDOW_MS,
  CONTACT_MAX_FAMILY,
  CONTACT_MAX_DEFAULT,
};
