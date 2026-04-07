// ════════════════════════════════════════════════════════════════════════════
// MIIA — Morning Briefing Engine
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// REEMPLAZA el polling constante (30s sport, 5min integrations, 30min prices).
//
// DISEÑO INTELIGENTE:
//   1. 10:00 AM (hora owner) → consulta del día: deportes, precios, integraciones, vuelos
//   2. 3:00 PM → refuerzo para eventos de tarde/noche
//   3. Si hay evento HOY → agenda timer interno para arrancar polling EN VIVO a la hora exacta
//   4. Durante evento → polling real según deporte (ver tabla abajo)
//   5. Post-evento → detiene polling, resumen final, silencio
//   6. ON-DEMAND → si el usuario pregunta ("¿cómo va Boca?"), chequeo inmediato
//
// ═══ POLLING EN VIVO POR DEPORTE ═══
//   Fútbol:    60s  × ~2h    = ~120 polls/partido    (Gemini Search $0)
//   F1:        15s  × ~2h    = ~480 polls/carrera     (OpenF1 $0)
//   Tenis:     90s  × ~2.5h  = ~100 polls/partido     (Gemini Search $0)
//   NBA:       60s  × ~2.5h  = ~150 polls/partido     (Gemini Search $0)
//   MLB:       90s  × ~3h    = ~120 polls/partido     (MLB Stats $0)
//   UFC:       120s × ~4h    = ~120 polls/card         (Gemini Search $0)
//   Rugby:     60s  × ~1.5h  = ~90 polls/partido      (Gemini Search $0)
//   Boxeo:     120s × ~1h    = ~30 polls/pelea         (Gemini Search $0)
//   Golf:      300s × ~5h    = ~60 polls/ronda         (Gemini Search $0)
//   Ciclismo:  300s × ~5h    = ~60 polls/etapa         (Gemini Search $0)
//
// ANTES: ~3,200 polls/día (sport 30s + integrations 5min + prices 30min + travel 6h)
// AHORA: 2 briefings + polls SOLO durante eventos vivos + on-demand
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
 * Consulta ON-DEMAND — cuando el usuario pregunta algo ("¿cómo va Boca?", "¿bajó el precio?")
 * Ejecuta el chequeo AHORA sin esperar al briefing.
 * @param {string} type - 'sport' | 'price' | 'integration' | 'all'
 * @returns {Promise<Object>} Resultado de la consulta
 */
async function onDemandCheck(type = 'all') {
  console.log(`[MORNING-BRIEFING] 🔍 Consulta ON-DEMAND: ${type}`);
  const results = {};

  if (type === 'sport' || type === 'all') {
    try {
      if (_deps?.sportEngine?.runSportsEngine) {
        await _deps.sportEngine.runSportsEngine();
        results.sport = 'checked';
        console.log('[MORNING-BRIEFING] ⚽ Sport check on-demand completado');
      }
    } catch (e) {
      console.error(`[MORNING-BRIEFING] ❌ On-demand sport: ${e.message}`);
      results.sport = 'error';
    }
  }

  if (type === 'price' || type === 'all') {
    try {
      if (_deps?.priceTracker?.checkPrices) {
        await _deps.priceTracker.checkPrices(_ownerUid);
        results.price = 'checked';
        console.log('[MORNING-BRIEFING] 💰 Price check on-demand completado');
      }
    } catch (e) {
      console.error(`[MORNING-BRIEFING] ❌ On-demand price: ${e.message}`);
      results.price = 'error';
    }
  }

  if (type === 'integration' || type === 'all') {
    try {
      if (_deps?.integrationEngine?.runIntegrationEngine) {
        await _deps.integrationEngine.runIntegrationEngine();
        results.integration = 'checked';
        console.log('[MORNING-BRIEFING] 📱 Integration check on-demand completado');
      }
    } catch (e) {
      console.error(`[MORNING-BRIEFING] ❌ On-demand integration: ${e.message}`);
      results.integration = 'error';
    }
  }

  return results;
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
  onDemandCheck,
  forceBriefing,
  healthCheck,
  stop
};
