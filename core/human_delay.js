'use strict';

/**
 * HUMAN DELAY v1.0 — Delays inteligentes que simulan comportamiento humano real
 *
 * Reemplaza el delay fijo de 1.5-3s con delays contextuales:
 *   - Self-chat: rápido (el owner espera respuesta inmediata)
 *   - Lead conocido: normal (2-5s lectura + typing proporcional)
 *   - Lead nuevo: más lento (humano mira quién es primero, 5-15s)
 *   - Familia: rápido-moderado (1-3s)
 *   - Horario nocturno: mucho más lento (minutos, como si estuviera medio dormido)
 *
 * SECUENCIA CORRECTA: leer → delay lectura → typing indicator → delay typing → enviar
 * (Antes el typing aparecía ANTES de leer — eso delata a un bot)
 *
 * Rate limiter integration: delayMultiplier del nivel actual se aplica.
 */

/**
 * Calcular delay de "lectura" (antes de empezar a escribir)
 * Simula que el humano LEE el mensaje antes de responder
 *
 * @param {object} opts
 * @param {string} opts.contactType - 'owner'|'lead'|'familia'|'equipo'|'group'
 * @param {number} opts.messageLength - Largo del mensaje entrante
 * @param {boolean} opts.isFirstMessage - Primera interacción con este contacto
 * @param {number} opts.hour - Hora actual (0-23) en timezone del owner
 * @param {number} [opts.delayMultiplier=1] - Multiplicador del rate limiter
 * @returns {number} Delay en ms
 */
function calculateReadDelay(opts) {
  const {
    contactType, messageLength, isFirstMessage, hour,
    delayMultiplier = 1
  } = opts;

  let baseDelay;

  // Base por tipo de contacto
  switch (contactType) {
    case 'owner':
      // Self-chat: respuesta rápida (1-2s)
      baseDelay = 1000 + Math.random() * 1000;
      break;
    case 'familia':
    case 'equipo':
      // Familia: moderado (1.5-3s)
      baseDelay = 1500 + Math.random() * 1500;
      break;
    case 'lead':
      if (isFirstMessage) {
        // Lead nuevo: humano mira quién es (5-15s)
        baseDelay = 5000 + Math.random() * 10000;
      } else {
        // Lead conocido: normal (2.5-5s)
        baseDelay = 2500 + Math.random() * 2500;
      }
      break;
    default:
      baseDelay = 3000 + Math.random() * 3000;
  }

  // Ajuste por largo del mensaje (leer mensajes largos toma más)
  // ~200ms por cada 100 caracteres (velocidad lectura rápida)
  const readingTime = (messageLength / 100) * 200;
  baseDelay += Math.min(readingTime, 5000); // Máx 5s extra por lectura

  // Ajuste nocturno (22:00-07:00): delays mucho más largos
  if (hour >= 22 || hour < 7) {
    const nightMultiplier = 2 + Math.random() * 3; // 2x-5x más lento
    baseDelay *= nightMultiplier;
  }

  // Jitter: ±20% para que no sea predecible
  const jitter = 0.8 + Math.random() * 0.4;
  baseDelay *= jitter;

  // Rate limiter multiplier
  baseDelay *= delayMultiplier;

  // Caps
  if (contactType === 'owner') {
    return Math.min(baseDelay, 4000); // Self-chat: máx 4s
  }
  return Math.min(baseDelay, 60000); // Otros: máx 60s
}

/**
 * Calcular delay de "typing" (cuánto tarda en escribir la respuesta)
 * Simula velocidad de tipeo humano
 *
 * @param {object} opts
 * @param {number} opts.responseLength - Largo de la respuesta a enviar
 * @param {string} opts.contactType - Tipo de contacto
 * @param {number} [opts.delayMultiplier=1]
 * @returns {number} Delay en ms
 */
function calculateTypingDelay(opts) {
  const { responseLength, contactType, delayMultiplier = 1 } = opts;

  // Velocidad de tipeo: ~50-80ms por carácter (humano promedio en celular)
  const msPerChar = 50 + Math.random() * 30;
  let typingDelay = responseLength * msPerChar;

  // Self-chat: tipeo más rápido (el owner sabe que es MIIA)
  if (contactType === 'owner') {
    typingDelay *= 0.3; // 70% más rápido
  }

  // Jitter
  typingDelay *= (0.8 + Math.random() * 0.4);

  // Rate limiter
  typingDelay *= delayMultiplier;

  // Caps: mínimo 1.5s, máximo 15s
  return Math.max(1500, Math.min(typingDelay, 15000));
}

/**
 * Probabilidad de "no leer inmediatamente" (simula estar ocupado)
 * 1 de cada 8 mensajes tiene un delay largo extra (20-45s)
 *
 * @param {string} contactType
 * @returns {number} Delay extra en ms (0 si no aplica)
 */
function maybeBusyDelay(contactType) {
  // Self-chat: nunca "ocupado"
  if (contactType === 'owner') return 0;

  // 1 de cada 8: delay de "estaba ocupado"
  if (Math.random() < 0.125) {
    const busyDelay = 20000 + Math.random() * 25000; // 20-45s
    console.log(`[HUMAN-DELAY] ⏳ Simulando "ocupado" — delay extra ${Math.round(busyDelay / 1000)}s`);
    return busyDelay;
  }

  return 0;
}

/**
 * Obtener hora actual en timezone del owner
 * @param {string} [timezone] - Timezone IANA (default: America/Buenos_Aires)
 * @returns {number} Hora 0-23
 */
function getOwnerHour(timezone = 'America/Buenos_Aires') {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone,
    });
    return parseInt(formatter.format(now));
  } catch {
    return new Date().getHours();
  }
}

// ═══════════════════════════════════════════════════════════
// NIGHT MODE — MIIA "se duerme" automáticamente
// ═══════════════════════════════════════════════════════════

// Estado por tenant
const _nightState = {};

/**
 * Verificar si MIIA está en night mode (auto-sleep)
 * Night mode se activa aleatoriamente entre 22:15-23:05 y desactiva entre 7:00-8:00
 *
 * @param {string} uid - Tenant UID
 * @param {string} [timezone] - Timezone del owner
 * @returns {{ isNight: boolean, reason: string }}
 */
function checkNightMode(uid, timezone = 'America/Buenos_Aires') {
  if (!_nightState[uid]) {
    // Generar hora de dormir aleatoria para hoy (22:15-23:05)
    const sleepMinute = 15 + Math.floor(Math.random() * 50); // 15-65 min después de las 22
    const sleepHour = sleepMinute >= 60 ? 23 : 22;
    const sleepMin = sleepMinute >= 60 ? sleepMinute - 60 : sleepMinute;
    // Generar hora de despertar aleatoria (7:00-8:00)
    const wakeMinute = Math.floor(Math.random() * 60);
    _nightState[uid] = {
      sleepHour, sleepMin,
      wakeHour: 7, wakeMin: wakeMinute,
      date: new Date().toISOString().split('T')[0], // resetear cada día
    };
  }

  // Resetear si cambió el día
  const today = new Date().toISOString().split('T')[0];
  if (_nightState[uid].date !== today) {
    delete _nightState[uid];
    return checkNightMode(uid, timezone); // Regenerar para hoy
  }

  const hour = getOwnerHour(timezone);
  const ns = _nightState[uid];

  // Night: desde sleepHour:sleepMin hasta wakeHour:wakeMin del día siguiente
  const nowMinutes = hour * 60 + new Date().getMinutes();
  const sleepAt = ns.sleepHour * 60 + ns.sleepMin;
  const wakeAt = ns.wakeHour * 60 + ns.wakeMin;

  if (nowMinutes >= sleepAt || nowMinutes < wakeAt) {
    return { isNight: true, reason: `night_mode (sleep ${ns.sleepHour}:${String(ns.sleepMin).padStart(2,'0')}, wake ${ns.wakeHour}:${String(ns.wakeMin).padStart(2,'0')})` };
  }

  return { isNight: false, reason: 'daytime' };
}

/**
 * ¿MIIA debe responder en night mode?
 * Owner self-chat: SIEMPRE
 * Familia urgente: SIEMPRE
 * Lead: NO (delay hasta mañana)
 *
 * @param {string} uid
 * @param {string} contactType
 * @param {string} [timezone]
 * @returns {{ allowed: boolean, reason: string, delayUntilMorning: boolean }}
 */
function nightModeGate(uid, contactType, timezone) {
  const { isNight, reason } = checkNightMode(uid, timezone);
  if (!isNight) return { allowed: true, reason: 'daytime', delayUntilMorning: false };

  // Owner: siempre
  if (contactType === 'owner') {
    return { allowed: true, reason: 'night_owner_always', delayUntilMorning: false };
  }

  // Familia/equipo: permitido (puede ser urgente)
  if (contactType === 'familia' || contactType === 'equipo') {
    return { allowed: true, reason: 'night_family_allowed', delayUntilMorning: false };
  }

  // Leads y otros: delay hasta mañana
  console.log(`[NIGHT-MODE] 🌙 ${contactType} bloqueado por night mode (${reason})`);
  return { allowed: false, reason, delayUntilMorning: true };
}

module.exports = {
  calculateReadDelay,
  calculateTypingDelay,
  maybeBusyDelay,
  getOwnerHour,
  checkNightMode,
  nightModeGate,
};
