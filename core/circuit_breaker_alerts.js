'use strict';

/**
 * CIRCUIT BREAKER ALERTS — T76 Vi 2026-04-30
 *
 * Modulo standalone que detecta transitions OPEN/CLOSED del circuit breaker
 * Gemini (resilience_shield) y dispara alertas user-facing al owner self-chat.
 *
 * Bug origen: cuando el circuit breaker abre, owner NO se entera. Logs de
 * Railway no son visibles para Mariano. Lead manda mensaje, MIIA no responde,
 * owner no sabe por que. Resultado: percepcion "MIIA esta caida" sin
 * informacion accionable.
 *
 * IMPACTO USUARIO post-fix:
 *   - Owner recibe en self-chat MIIA mensaje claro: "MIIA temporalmente lenta
 *     - IA en recovery. Reintenta en N min. Tu agenda + recordatorios siguen
 *     OK."
 *   - Cuando recovery completa: "MIIA ya recupero. Volvemos a respuestas
 *     normales."
 *   - Anti-spam: 1 alerta por transition (open + close), no por cada mensaje
 *     en estado abierto.
 *
 * Diseño:
 *   - Standalone module con pollState(currentIsOpen, system) callback
 *     dispatcher.
 *   - State per-system: { lastIsOpen, openedAt, lastNotifiedAt, openCount24h }
 *   - notifyOpen(callback) / notifyClosed(callback) registran handlers.
 *   - Caller (TMH heartbeat / health_aggregator) invoca pollState() peridico.
 *
 * Wire-in en TMH/server.js queda para T-future con firma (zona critica §5).
 *
 * Standard: Google + Amazon + NASA — pure callbacks, observable, anti-spam.
 */

const COOLDOWN_BETWEEN_NOTIFY_MS = 60_000; // mínimo 1 min entre notificaciones del mismo system
const STATE_PURGE_24H_MS = 24 * 60 * 60 * 1000;

// State per-system: { lastIsOpen, openedAt, lastNotifiedAt, openTransitions, closeTransitions }
const _state = {};

// Registered callbacks (ordenados FIFO)
const _onOpenCallbacks = [];
const _onClosedCallbacks = [];

function _ensureState(system) {
  if (!_state[system]) {
    _state[system] = {
      lastIsOpen: false,
      openedAt: null,
      lastNotifiedAt: 0,
      openTransitions: 0,
      closeTransitions: 0,
      _openTimestamps: [],
    };
  }
  return _state[system];
}

/**
 * Registrar callback para evento OPEN.
 * @param {Function} fn - (system, meta) => void|Promise
 */
function onOpen(fn) {
  if (typeof fn !== 'function') throw new Error('onOpen requires function');
  _onOpenCallbacks.push(fn);
}

/**
 * Registrar callback para evento CLOSED.
 * @param {Function} fn - (system, meta) => void|Promise
 */
function onClosed(fn) {
  if (typeof fn !== 'function') throw new Error('onClosed requires function');
  _onClosedCallbacks.push(fn);
}

/**
 * Poll state actual del circuito y dispara callbacks si hay transition.
 * Idempotente: 2 polls consecutivos sin transition = no-op.
 *
 * @param {boolean} currentIsOpen - resultado actual de shield.isCircuitOpen(system)
 * @param {string} system - nombre del sistema (gemini, firestore, etc.)
 * @param {object} [meta] - metadata para callbacks (statusCode, reason, etc.)
 * @returns {{ transition: 'opened'|'closed'|null, notified: boolean }}
 */
function pollState(currentIsOpen, system, meta = {}) {
  if (!system) return { transition: null, notified: false };
  const s = _ensureState(system);
  const now = Date.now();

  // Sin cambio
  if (currentIsOpen === s.lastIsOpen) {
    return { transition: null, notified: false };
  }

  // Anti-spam: cooldown global por system
  const respectCooldown = (now - s.lastNotifiedAt) < COOLDOWN_BETWEEN_NOTIFY_MS;

  let transition = null;
  let notified = false;

  if (currentIsOpen && !s.lastIsOpen) {
    // Transition OPEN
    transition = 'opened';
    s.openTransitions++;
    s.openedAt = now;
    s._openTimestamps.push(now);
    // Trim a últimas 24h
    s._openTimestamps = s._openTimestamps.filter(t => (now - t) < STATE_PURGE_24H_MS);
    if (!respectCooldown) {
      s.lastNotifiedAt = now;
      _dispatchCallbacks(_onOpenCallbacks, system, { ...meta, openCount24h: s._openTimestamps.length });
      notified = true;
    }
  } else if (!currentIsOpen && s.lastIsOpen) {
    // Transition CLOSED
    transition = 'closed';
    s.closeTransitions++;
    const downtimeMs = s.openedAt ? (now - s.openedAt) : 0;
    if (!respectCooldown) {
      s.lastNotifiedAt = now;
      _dispatchCallbacks(_onClosedCallbacks, system, { ...meta, downtime_ms: downtimeMs });
      notified = true;
    }
    s.openedAt = null;
  }

  s.lastIsOpen = currentIsOpen;
  return { transition, notified };
}

/**
 * Dispatch async best-effort. Errores en callbacks NO bloquean otros.
 */
function _dispatchCallbacks(arr, system, meta) {
  for (const fn of arr) {
    Promise.resolve()
      .then(() => fn(system, meta))
      .catch(err => {
        console.error(`[CB-ALERTS] callback error system=${system}: ${err.message}`);
      });
  }
}

/**
 * Build mensaje user-facing para owner self-chat (transition OPEN).
 * @param {string} system - 'gemini', 'firestore', etc.
 * @param {object} meta - { openCount24h, statusCode, reason }
 * @returns {string} mensaje listo para enviar
 */
function buildOpenMessage(system, meta = {}) {
  const sysLabel = system === 'gemini' ? 'la IA'
    : system === 'firestore' ? 'la base de datos'
    : system === 'whatsapp' ? 'WhatsApp'
    : system;

  const count = meta.openCount24h || 1;
  const recurrence = count > 1 ? ` (${count}ª vez en 24h — revisar)` : '';

  return `⚠️ MIIA temporalmente lenta — ${sysLabel} en recovery${recurrence}.\n` +
         `Reintento automático en ~1 min. Tu agenda + recordatorios siguen OK.\n` +
         `Si persiste >5 min, escribime "MIIA estado" para diagnóstico.`;
}

/**
 * Build mensaje user-facing para owner self-chat (transition CLOSED).
 * @param {string} system
 * @param {object} meta - { downtime_ms }
 * @returns {string}
 */
function buildClosedMessage(system, meta = {}) {
  const sysLabel = system === 'gemini' ? 'la IA'
    : system === 'firestore' ? 'la base de datos'
    : system === 'whatsapp' ? 'WhatsApp'
    : system;
  const downtimeS = Math.round((meta.downtime_ms || 0) / 1000);
  const downtimeStr = downtimeS < 60 ? `${downtimeS}s`
    : `${Math.round(downtimeS / 60)}min`;
  return `✅ MIIA recuperada — ${sysLabel} OK tras ${downtimeStr}. Volvemos a respuestas normales.`;
}

/**
 * Stats per-system.
 */
function getStats(system) {
  const s = _state[system];
  if (!s) return null;
  return {
    system,
    lastIsOpen: s.lastIsOpen,
    openedAt: s.openedAt,
    openTransitions: s.openTransitions,
    closeTransitions: s.closeTransitions,
    openCount24h: s._openTimestamps.length,
  };
}

function getAllStats() {
  return Object.keys(_state).map(getStats);
}

/**
 * Reset (solo tests).
 */
function _resetForTests() {
  for (const k of Object.keys(_state)) delete _state[k];
  _onOpenCallbacks.length = 0;
  _onClosedCallbacks.length = 0;
}

module.exports = {
  pollState,
  onOpen,
  onClosed,
  buildOpenMessage,
  buildClosedMessage,
  getStats,
  getAllStats,
  COOLDOWN_BETWEEN_NOTIFY_MS,
  STATE_PURGE_24H_MS,
  // Test-only
  _resetForTests,
};
