// ════════════════════════════════════════════════════════════════════════════
// MIIA — Morning Briefing Engine
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// REEMPLAZA el polling constante (30s sport, 5min integrations, 30min prices).
// NUEVO DISEÑO:
//   1. 10:00 AM (hora owner) → consulta del día: deportes, precios, integraciones
//   2. Si hay evento HOY → agenda timer interno para arrancar polling en vivo
//   3. Durante evento → polling real (60s fútbol, 15s F1, etc.)
//   4. Post-evento → para polling, resumen, silencio
//
// De ~3,200 polls/día → 2 consultas (10AM + 3PM) + polls solo durante eventos vivos
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const BRIEFING_HOURS = [10, 15]; // 10:00 AM + 3:00 PM (refuerzo tarde/noche)
const CHECK_INTERVAL_MS = 60000; // Chequear cada 1 min si es hora de briefing

let _deps = null;
let _ownerUid = null;
let _briefingsDone = {}; // { '2026-04-07_10': true, '2026-04-07_15': true }
let _lastBriefingDate = null; // Fecha del último briefing (YYYY-MM-DD)
let _activeEventTimers = []; // Timers de eventos programados para hoy
let _activeLivePollers = []; // Intervalos de polling en vivo activos
let _checkInterval = null;

/**
 * Inicializa el morning briefing engine.
 * @param {string} ownerUid
 * @param {Object} deps - { sportEngine, integrationEngine, priceTracker, travelTracker,
 *                          getScheduleConfig, isWithinSchedule, safeSendMessage, OWNER_PHONE }
 */
function init(ownerUid, deps) {
  _ownerUid = ownerUid;
  _deps = deps;

  // Chequear cada minuto si es hora del briefing
  _checkInterval = setInterval(checkMorningTime, CHECK_INTERVAL_MS);
  console.log(`[MORNING-BRIEFING] ✅ Inicializado — briefing diario a las ${MORNING_HOUR}:00 (hora owner)`);

  // Chequear inmediatamente por si ya pasó la hora o es justo ahora
  checkMorningTime();
}

/**
 * Obtiene la hora actual en timezone del owner.
 */
async function getOwnerLocalTime() {
  try {
    const scheduleConfig = await _deps.getScheduleConfig(_ownerUid);
    const tz = scheduleConfig?.timezone || 'America/Bogota';
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    return { hour: now.getHours(), minute: now.getMinutes(), date: now.toISOString().split('T')[0], tz };
  } catch (e) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    return { hour: now.getHours(), minute: now.getMinutes(), date: now.toISOString().split('T')[0], tz: 'America/Bogota' };
  }
}

/**
 * Chequea si es hora del briefing matutino.
 */
async function checkMorningTime() {
  if (!_deps || !_ownerUid) return;

  const { hour, minute, date } = await getOwnerLocalTime();

  // Reset al cambiar de día
  if (_lastBriefingDate !== date) {
    _briefingsDone = {};
    _lastBriefingDate = date;
    clearActiveTimers();
  }

  // ¿Es hora de algún briefing? (10:00-10:05, 15:00-15:05)
  for (const briefingHour of BRIEFING_HOURS) {
    const key = `${date}_${briefingHour}`;
    if (hour === briefingHour && minute <= 5 && !_briefingsDone[key]) {
      _briefingsDone[key] = true;
      const label = briefingHour === 10 ? '☀️ Briefing matutino' : '🌤️ Briefing de refuerzo';
      console.log(`[MORNING-BRIEFING] ${label} (${briefingHour}:00)...`);
      await runMorningBriefing();
      break; // Solo 1 por ciclo
    }
  }
}

/**
 * Ejecuta el briefing matutino completo.
 * Consulta: deportes del día, precios, integraciones.
 * Agenda timers para eventos en vivo.
 */
async function runMorningBriefing() {
  const results = { sports: [], prices: null, integrations: null };

  // ═══ 1. DEPORTES: ¿hay eventos hoy asociados al owner? ═══
  try {
    if (_deps.sportEngine?.checkSchedules) {
      const todayEvents = await _deps.sportEngine.checkSchedules();
      if (todayEvents && todayEvents.length > 0) {
        results.sports = todayEvents;
        console.log(`[MORNING-BRIEFING] ⚽ ${todayEvents.length} evento(s) deportivo(s) hoy`);

        // Agendar polling en vivo para cada evento
        for (const event of todayEvents) {
          scheduleEventPolling(event);
        }
      } else {
        console.log('[MORNING-BRIEFING] ⚽ Sin eventos deportivos hoy');
      }
    }
  } catch (e) {
    console.error(`[MORNING-BRIEFING] ❌ Error chequeando deportes: ${e.message}`);
  }

  // ═══ 2. PRECIOS: chequear cambios en productos seguidos ═══
  try {
    if (_deps.priceTracker?.checkPrices) {
      await _deps.priceTracker.checkPrices(_ownerUid);
      console.log('[MORNING-BRIEFING] 💰 Chequeo de precios completado');
    }
  } catch (e) {
    console.error(`[MORNING-BRIEFING] ❌ Error chequeando precios: ${e.message}`);
  }

  // ═══ 3. INTEGRACIONES: YouTube, clima, noticias, etc. ═══
  try {
    if (_deps.integrationEngine?.runIntegrationEngine) {
      await _deps.integrationEngine.runIntegrationEngine();
      console.log('[MORNING-BRIEFING] 📱 Integraciones ejecutadas');
    }
  } catch (e) {
    console.error(`[MORNING-BRIEFING] ❌ Error en integraciones: ${e.message}`);
  }

  // ═══ 4. VIAJES: chequear vuelos ═══
  try {
    if (_deps.travelTracker?.checkFlightAlerts) {
      await _deps.travelTracker.checkFlightAlerts(_ownerUid);
      console.log('[MORNING-BRIEFING] ✈️ Chequeo de vuelos completado');
    }
  } catch (e) {
    console.error(`[MORNING-BRIEFING] ❌ Error chequeando vuelos: ${e.message}`);
  }

  console.log(`[MORNING-BRIEFING] ✅ Briefing completo — ${results.sports.length} eventos agendados para polling en vivo`);
}

/**
 * Agenda el polling en vivo para un evento deportivo.
 * Calcula cuánto falta para el inicio y programa un timer.
 * @param {Object} event - { matchId, name, startTime, sport, pollIntervalMs }
 */
function scheduleEventPolling(event) {
  try {
    const now = Date.now();
    const startTime = new Date(event.startTime).getTime();
    const delayMs = Math.max(0, startTime - now - 300000); // 5 min antes del evento

    if (delayMs > 24 * 3600000) {
      console.log(`[MORNING-BRIEFING] ⏭️ Evento ${event.name} es mañana o después — ignorando`);
      return;
    }

    const pollInterval = event.pollIntervalMs || 60000;
    const eventDuration = event.maxDurationMs || 4 * 3600000; // 4h max por defecto

    console.log(`[MORNING-BRIEFING] ⏰ ${event.name} — polling en ${Math.round(delayMs / 60000)} min (cada ${pollInterval / 1000}s)`);

    const timer = setTimeout(() => {
      console.log(`[MORNING-BRIEFING] 🔴 EN VIVO: ${event.name} — iniciando polling (cada ${pollInterval / 1000}s)`);

      // Iniciar polling en vivo
      const poller = setInterval(async () => {
        try {
          if (_deps.sportEngine?.pollEvent) {
            await _deps.sportEngine.pollEvent(event);
          } else if (_deps.sportEngine?.runSportsEngine) {
            await _deps.sportEngine.runSportsEngine();
          }
        } catch (e) {
          console.error(`[MORNING-BRIEFING] ❌ Error polling ${event.name}: ${e.message}`);
        }
      }, pollInterval);

      _activeLivePollers.push({ poller, event, startedAt: Date.now() });

      // Auto-stop después de la duración máxima del evento
      setTimeout(() => {
        clearInterval(poller);
        _activeLivePollers = _activeLivePollers.filter(p => p.poller !== poller);
        console.log(`[MORNING-BRIEFING] 🏁 FIN: ${event.name} — polling detenido`);
      }, eventDuration);

    }, delayMs);

    _activeEventTimers.push({ timer, event });
  } catch (e) {
    console.error(`[MORNING-BRIEFING] ❌ Error agendando evento ${event.name}: ${e.message}`);
  }
}

/**
 * Limpia todos los timers y pollers activos.
 */
function clearActiveTimers() {
  for (const { timer } of _activeEventTimers) clearTimeout(timer);
  for (const { poller } of _activeLivePollers) clearInterval(poller);
  _activeEventTimers = [];
  _activeLivePollers = [];
  console.log('[MORNING-BRIEFING] 🧹 Timers y pollers limpiados para nuevo día');
}

/**
 * Forzar briefing (para testing o comando manual).
 */
async function forceBriefing() {
  await runMorningBriefing();
  const { date } = await getOwnerLocalTime();
  _lastBriefingDate = date;
}

/**
 * Health check del morning briefing.
 */
function healthCheck() {
  return {
    initialized: !!_deps,
    briefingsDone: _briefingsDone,
    lastBriefingDate: _lastBriefingDate,
    scheduledEvents: _activeEventTimers.map(t => t.event?.name || 'unknown'),
    activeLivePollers: _activeLivePollers.map(p => ({
      event: p.event?.name,
      runningFor: `${Math.round((Date.now() - p.startedAt) / 60000)} min`
    })),
    briefingHours: BRIEFING_HOURS
  };
}

/**
 * Detiene el engine.
 */
function stop() {
  if (_checkInterval) clearInterval(_checkInterval);
  clearActiveTimers();
  console.log('[MORNING-BRIEFING] 🛑 Engine detenido');
}

module.exports = {
  init,
  forceBriefing,
  healthCheck,
  stop
};
