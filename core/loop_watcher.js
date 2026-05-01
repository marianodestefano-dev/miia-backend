/**
 * LOOP WATCHER — Circuit breaker anti-loop per-contact
 *
 * Detecta cuando MIIA entra en loop con un contacto (ej: bot de formulario)
 * y pausa automaticamente + alerta al owner.
 *
 * COMPORTAMIENTO DIFERENCIADO (C-021):
 *
 *   TMH (tenants — numero personal del owner):
 *     Pausa INDEFINIDA. Solo el owner puede reactivar con
 *     "MIIA retomá con +XXX". Razon: es el numero personal,
 *     si algo entro en loop ahi, mejor cortar definitivo.
 *
 *   server.js (MIIA CENTER — numero auto-venta +573054169969):
 *     Pausa con AUTO-RESET al dia siguiente 00:00 COT.
 *     Un lead puede tener un mal dia o bot pegado; al dia
 *     siguiente quizas escribe normal y es cliente genuino.
 *     El owner tambien puede reactivar manualmente antes del reset.
 *
 * Creado post-incidente bot Coordinadora (2026-04-14, CARTA C-013).
 * Ajustado C-019: ventana 30s, threshold 10 combinado (in+out).
 * Ajustado C-021: pausa diferenciada TMH (indefinida) vs server.js (daily reset).
 *
 * API:
 *   recordMessage(uid, phone, opts)     — registrar mensaje (entrante O saliente)
 *   isLoopPaused(uid, phone)            — esta pausado por loop detectado?
 *   checkAndRecord(uid, phone, opts)    — combo: check si pausado + registrar si no
 *   resetLoop(uid, phone)               — owner ordena retomar
 *   getPausedContacts(uid)              — lista de contactos pausados (para reportes)
 *
 * opts.autoResetDaily: boolean (default false)
 *   false → pausa INDEFINIDA (TMH)
 *   true  → pausa hasta 00:00 COT del dia siguiente (MIIA CENTER)
 *
 * Integrado en:
 *   - tenant_message_handler.js sendTenantMessage() (outgoing, indefinido)
 *   - tenant_message_handler.js handleTenantMessage() (incoming, indefinido)
 *   - server.js safeSendMessage() (outgoing, autoResetDaily)
 *   - server.js handleIncomingMessage() (incoming, autoResetDaily)
 */

'use strict';

// Config (ajuste C-019)
const LOOP_THRESHOLD = 10;       // msgs combinados (in+out) en la ventana = loop
const LOOP_WINDOW_MS = 30_000;   // ventana de deteccion: 30 segundos
const STALE_CLEANUP_MS = 300_000; // limpiar entries >5 min sin actividad (NO pausados)

// State: { "uid:phone": { count, firstAt, lastAt, paused, pausedAt, autoResetAt, resumedBy } }
// autoResetAt: null = pausa indefinida, timestamp = auto-reset a esa hora
const _loopState = {};

/**
 * Calcular timestamp del proximo 00:00 hora Colombia (America/Bogota = UTC-5, sin DST).
 * @returns {number} timestamp UTC del proximo 00:00 COT
 */
function _getNextResetCOT() {
  const now = Date.now();
  const COT_OFFSET_MS = 5 * 3600_000; // UTC-5
  // Hora actual en COT
  const nowCOT = new Date(now - COT_OFFSET_MS);
  // BUG-C fix: evitar setUTCHours(24) (undefined behavior). Avanzar 1 dia en frame COT + midnight.
  const d = new Date(now - COT_OFFSET_MS); // frame COT
  d.setUTCDate(d.getUTCDate() + 1);        // dia siguiente en frame COT
  d.setUTCHours(0, 0, 0, 0);               // midnight en frame COT
  return d.getTime() + COT_OFFSET_MS;       // convertir de vuelta a UTC real
}

/**
 * Generar key per-tenant per-contact.
 */
function _key(uid, phone) {
  return `${uid}:${phone}`;
}

/**
 * Limpiar entries stale (sin actividad en >5 min y NO pausados).
 * Entries PAUSADOS NUNCA se limpian por cleanup (C-019).
 * Auto-reset diario se maneja en isLoopPaused, no aca.
 */
function _cleanup() {
  const now = Date.now();
  for (const [key, state] of Object.entries(_loopState)) {
    if (state.paused) continue; // pausados NUNCA se limpian por stale
    if ((now - state.lastAt) > STALE_CLEANUP_MS) {
      delete _loopState[key];
    }
  }
}

// Cleanup cada 2 minutos
setInterval(_cleanup, 120_000);

/**
 * Esta este contacto pausado por loop detectado?
 * C-021: Si tiene autoResetAt y ya paso → auto-despausar.
 * Si no tiene autoResetAt → pausa INDEFINIDA.
 * @param {string} uid
 * @param {string} phone
 * @returns {boolean}
 */
function isLoopPaused(uid, phone) {
  const key = _key(uid, phone);
  const state = _loopState[key];
  if (!state || !state.paused) return false;

  // C-021: auto-reset diario para MIIA CENTER
  if (state.autoResetAt && Date.now() >= state.autoResetAt) {
    const pausedMinutes = Math.round((Date.now() - state.pausedAt) / 60000);
    console.log(`[LOOP-WATCHER] 📅 Auto-reset diario: ${phone} (tenant ${uid}) reactivado tras ${pausedMinutes} min de pausa.`);
    delete _loopState[key];
    return false;
  }

  return true;
}

/**
 * Registrar un mensaje (entrante O saliente) con un contacto.
 * C-019: cuenta COMBINADO (incoming del contacto + outgoing de MIIA).
 * @param {string} uid
 * @param {string} phone
 * @param {{ autoResetDaily?: boolean }} [opts] — autoResetDaily=true para MIIA CENTER
 * @returns {{ loopDetected: boolean, count: number }}
 */
function recordMessage(uid, phone, opts) {
  const key = _key(uid, phone);
  const now = Date.now();
  const autoResetDaily = opts?.autoResetDaily || false;

  if (!_loopState[key]) {
    _loopState[key] = {
      count: 1, firstAt: now, lastAt: now,
      paused: false, pausedAt: 0, autoResetAt: null, resumedBy: null
    };
    return { loopDetected: false, count: 1 };
  }

  const state = _loopState[key];

  // Si esta pausado, no incrementar (ya esta bloqueado)
  if (state.paused) {
    return { loopDetected: false, count: state.count };
  }

  // Si la ventana expiro, resetear contadores
  if ((now - state.firstAt) > LOOP_WINDOW_MS) {
    state.count = 1;
    state.firstAt = now;
    state.lastAt = now;
    return { loopDetected: false, count: 1 };
  }

  // Incrementar
  state.count++;
  state.lastAt = now;

  // Detectar loop
  if (state.count > LOOP_THRESHOLD) {
    state.paused = true;
    state.pausedAt = now;
    state.autoResetAt = autoResetDaily ? _getNextResetCOT() : null;
    state.resumedBy = null;
    const elapsed = Math.round((state.lastAt - state.firstAt) / 1000);
    const pauseType = autoResetDaily ? 'HASTA 00:00 COT' : 'INDEFINIDAMENTE';
    console.error(`[LOOP-WATCHER] 🚨 LOOP DETECTADO: ${phone} (tenant ${uid}) — ${state.count} msgs combinados en ${elapsed}s. PAUSADO ${pauseType}.`);
    return { loopDetected: true, count: state.count };
  }

  return { loopDetected: false, count: state.count };
}

/**
 * Check + record combo. Retorna si OK para enviar, o si esta pausado.
 * @param {string} uid
 * @param {string} phone
 * @param {{ autoResetDaily?: boolean }} [opts]
 * @returns {{ allowed: boolean, loopDetected: boolean, count: number }}
 */
function checkAndRecord(uid, phone, opts) {
  // Primero verificar pausa existente (incluye auto-reset diario si aplica)
  if (isLoopPaused(uid, phone)) {
    const state = _loopState[_key(uid, phone)];
    return { allowed: false, loopDetected: false, count: state.count };
  }

  // Registrar (pasando opts para que recordMessage sepa si es autoResetDaily)
  const result = recordMessage(uid, phone, opts);

  if (result.loopDetected) {
    return { allowed: false, loopDetected: true, count: result.count };
  }

  return { allowed: true, loopDetected: false, count: result.count };
}

/**
 * Owner ordena retomar con un contacto pausado.
 * Funciona para AMBOS tipos de pausa (indefinida y daily).
 * @param {string} uid
 * @param {string} phone
 * @returns {boolean} true si estaba pausado y se despausó
 */
function resetLoop(uid, phone) {
  const key = _key(uid, phone);
  const state = _loopState[key];
  if (!state || !state.paused) {
    console.log(`[LOOP-WATCHER] ℹ️ Reset pedido para ${phone} (tenant ${uid}) pero NO estaba pausado.`);
    return false;
  }
  const pausedMinutes = Math.round((Date.now() - state.pausedAt) / 60000);
  const wasAutoReset = state.autoResetAt ? ' (era pausa diaria)' : ' (era pausa indefinida)';
  console.log(`[LOOP-WATCHER] 🔄 Reset por orden del owner: ${phone} (tenant ${uid}). Estuvo pausado ${pausedMinutes} min${wasAutoReset}.`);
  delete _loopState[key];
  return true;
}

/**
 * Obtener lista de contactos pausados para un tenant.
 * Util para reportes al owner.
 * @param {string} uid
 * @returns {Array<{phone: string, pausedAt: number, count: number, autoResetAt: number|null}>}
 */
function getPausedContacts(uid) {
  const result = [];
  for (const [key, state] of Object.entries(_loopState)) {
    if (state.paused && key.startsWith(`${uid}:`)) {
      const phone = key.substring(uid.length + 1);
      result.push({ phone, pausedAt: state.pausedAt, count: state.count, autoResetAt: state.autoResetAt });
    }
  }
  return result;
}

module.exports = {
  recordMessage,
  isLoopPaused,
  checkAndRecord,
  resetLoop,
  getPausedContacts,
  LOOP_THRESHOLD,
  LOOP_WINDOW_MS,
};
