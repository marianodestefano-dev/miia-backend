// ════════════════════════════════════════════════════════════════════════════
// MIIA — Morning Briefing Engine v2.0
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// REEMPLAZA el polling constante (30s sport, 5min integrations, 30min prices).
//
// DISEÑO INTELIGENTE — 4 briefings diarios (horas configurables por owner):
//   1. 6:00 AM → CLIMA: pronóstico del día para la ciudad del owner
//   2. 8:00 AM → NOTICIAS: resumen de ayer, basado en intereses detectados
//   3. 10:00 AM → DEPORTES + PRECIOS + INTEGRACIONES:
//      - Deportes: SOLO los que el owner sigue (no los 10)
//      - Precios: cambios + disponibilidad de stock
//      - Integraciones: YouTube, etc.
//      - Si hay evento HOY → timer interno para polling EN VIVO
//   4. 3:00 PM → VUELOS: chequeo de alertas de vuelos (1 vez/día)
//
// CONFIG PERSISTENTE (Firestore PARA SIEMPRE):
//   users/{uid}/settings/briefing → { climaHour, noticiasHour, deportesHour, vuelosHour, city }
//   Owner puede cambiar via self-chat: "briefing clima a las 7" → se guarda FOREVER
//
// POLLING EN VIVO POR DEPORTE (solo durante eventos):
//   Fútbol:    60s  × ~2h    = ~120 polls/partido
//   F1:        15s  × ~2h    = ~480 polls/carrera
//   Tenis:     90s  × ~2.5h  = ~100 polls/partido
//   NBA:       60s  × ~2.5h  = ~150 polls/partido
//   MLB:       90s  × ~3h    = ~120 polls/partido
//   UFC:       120s × ~4h    = ~120 polls/card
//   Rugby:     60s  × ~1.5h  = ~90 polls/partido
//   Boxeo:     120s × ~1h    = ~30 polls/pelea
//   Golf:      300s × ~5h    = ~60 polls/ronda
//   Ciclismo:  300s × ~5h    = ~60 polls/etapa
//
// ANTES: ~3,200 polls/día
// AHORA: 4 briefings temáticos + polls SOLO durante eventos vivos + on-demand
// ════════════════════════════════════════════════════════════════════════════

'use strict';

// ═══ Horarios por defecto (owner puede cambiar via self-chat) ═══
const DEFAULT_BRIEFING_SCHEDULE = {
  climaHour: 6,        // 6:00 AM — Clima del día
  noticiasHour: 8,     // 8:00 AM — Noticias de ayer
  deportesHour: 10,    // 10:00 AM — Deportes + Precios + Integraciones
  vuelosHour: 15       // 3:00 PM — Vuelos
};

const CHECK_INTERVAL_MS = 60000; // Chequear cada 1 min si es hora de briefing

let _deps = null;
let _ownerUid = null;
let _briefingsDone = {};          // { '2026-04-07_clima': true, '2026-04-07_noticias': true, ... }
let _lastBriefingDate = null;
let _activeEventTimers = [];      // Timers de eventos programados para hoy
let _activeLivePollers = [];      // Intervalos de polling en vivo activos
let _checkInterval = null;
let _cachedSchedule = null;       // Cache del schedule de Firestore
let _lastScheduleFetch = 0;       // Timestamp del último fetch

const SCHEDULE_CACHE_TTL = 300000; // 5 min cache del schedule

/**
 * Inicializa el morning briefing engine.
 * @param {string} ownerUid
 * @param {Object} deps - { sportEngine, integrationEngine, priceTracker, travelTracker,
 *                          getScheduleConfig, isWithinSchedule, safeSendMessage, OWNER_PHONE,
 *                          firestore, aiGateway }
 */
function init(ownerUid, deps) {
  _ownerUid = ownerUid;
  _deps = deps;

  _checkInterval = setInterval(checkBriefingTime, CHECK_INTERVAL_MS);
  console.log(`[MORNING-BRIEFING] ✅ Inicializado — 4 briefings diarios (clima/noticias/deportes/vuelos)`);

  // Chequear inmediatamente
  checkBriefingTime();
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
 * Obtiene los horarios de briefing del owner desde Firestore (con cache).
 * Si el owner cambió los horarios via self-chat, se respeta PARA SIEMPRE.
 */
async function getBriefingSchedule() {
  // Cache para no leer Firestore cada minuto
  if (_cachedSchedule && (Date.now() - _lastScheduleFetch) < SCHEDULE_CACHE_TTL) {
    return _cachedSchedule;
  }

  try {
    if (_deps.firestore && _ownerUid) {
      const doc = await _deps.firestore.collection('users').doc(_ownerUid)
        .collection('settings').doc('briefing').get();

      if (doc.exists) {
        const data = doc.data();
        _cachedSchedule = {
          climaHour: data.climaHour ?? DEFAULT_BRIEFING_SCHEDULE.climaHour,
          noticiasHour: data.noticiasHour ?? DEFAULT_BRIEFING_SCHEDULE.noticiasHour,
          deportesHour: data.deportesHour ?? DEFAULT_BRIEFING_SCHEDULE.deportesHour,
          vuelosHour: data.vuelosHour ?? DEFAULT_BRIEFING_SCHEDULE.vuelosHour,
          city: data.city || null,
          ownerNationality: data.ownerNationality || null
        };
        _lastScheduleFetch = Date.now();
        return _cachedSchedule;
      }
    }
  } catch (e) {
    console.error(`[MORNING-BRIEFING] ❌ Error leyendo schedule de Firestore: ${e.message}`);
  }

  _cachedSchedule = { ...DEFAULT_BRIEFING_SCHEDULE, city: null, ownerNationality: null };
  _lastScheduleFetch = Date.now();
  return _cachedSchedule;
}

/**
 * Guarda un cambio de horario en Firestore (PARA SIEMPRE).
 * Llamado cuando el owner dice "briefing clima a las 7" en self-chat.
 * @param {string} briefingType - 'clima'|'noticias'|'deportes'|'vuelos'
 * @param {number} newHour - Nueva hora (0-23)
 */
async function updateBriefingHour(briefingType, newHour) {
  const fieldMap = {
    clima: 'climaHour',
    noticias: 'noticiasHour',
    deportes: 'deportesHour',
    vuelos: 'vuelosHour'
  };

  const field = fieldMap[briefingType];
  if (!field) {
    console.error(`[MORNING-BRIEFING] ❌ Tipo de briefing inválido: ${briefingType}`);
    return false;
  }

  if (newHour < 0 || newHour > 23) {
    console.error(`[MORNING-BRIEFING] ❌ Hora inválida: ${newHour}`);
    return false;
  }

  try {
    await _deps.firestore.collection('users').doc(_ownerUid)
      .collection('settings').doc('briefing')
      .set({ [field]: newHour, updatedAt: new Date().toISOString() }, { merge: true });

    // Invalidar cache
    _cachedSchedule = null;
    _lastScheduleFetch = 0;

    console.log(`[MORNING-BRIEFING] ✅ Horario ${briefingType} actualizado a ${newHour}:00 (guardado en Firestore FOREVER)`);
    return true;
  } catch (e) {
    console.error(`[MORNING-BRIEFING] ❌ Error guardando horario: ${e.message}`);
    return false;
  }
}

/**
 * Guarda la ciudad del owner en Firestore (PARA SIEMPRE).
 * Se detecta una vez y se persiste.
 * @param {string} city - Nombre de la ciudad
 */
async function updateOwnerCity(city) {
  try {
    await _deps.firestore.collection('users').doc(_ownerUid)
      .collection('settings').doc('briefing')
      .set({ city, updatedAt: new Date().toISOString() }, { merge: true });

    _cachedSchedule = null;
    _lastScheduleFetch = 0;

    console.log(`[MORNING-BRIEFING] ✅ Ciudad del owner guardada: ${city} (Firestore FOREVER)`);
    return true;
  } catch (e) {
    console.error(`[MORNING-BRIEFING] ❌ Error guardando ciudad: ${e.message}`);
    return false;
  }
}

/**
 * Chequea si es hora de algún briefing.
 */
async function checkBriefingTime() {
  if (!_deps || !_ownerUid) return;

  const { hour, minute, date } = await getOwnerLocalTime();
  const schedule = await getBriefingSchedule();

  // Reset al cambiar de día
  if (_lastBriefingDate !== date) {
    _briefingsDone = {};
    _lastBriefingDate = date;
    clearActiveTimers();
  }

  // Definir los 4 briefings del día
  const briefings = [
    { type: 'clima',     hour: schedule.climaHour,     label: '🌤️ Clima',                    fn: runClimaBriefing },
    { type: 'noticias',  hour: schedule.noticiasHour,  label: '📰 Noticias',                  fn: runNoticiasBriefing },
    { type: 'deportes',  hour: schedule.deportesHour,  label: '⚽💰📱 Deportes+Precios+Integ', fn: runDeportesPreciosInteg },
    { type: 'vuelos',    hour: schedule.vuelosHour,    label: '✈️ Vuelos',                    fn: runVuelosBriefing }
  ];

  for (const briefing of briefings) {
    const key = `${date}_${briefing.type}`;
    if (hour === briefing.hour && minute <= 5 && !_briefingsDone[key]) {
      _briefingsDone[key] = true;
      console.log(`[MORNING-BRIEFING] ${briefing.label} (${briefing.hour}:00)...`);
      try {
        await briefing.fn(schedule);
      } catch (e) {
        console.error(`[MORNING-BRIEFING] ❌ Error en ${briefing.type}: ${e.message}`);
      }
      break; // Solo 1 por ciclo
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// BRIEFING 1: CLIMA (6 AM default)
// ═══════════════════════════════════════════════════════════════════

async function runClimaBriefing(schedule) {
  const city = schedule?.city;
  if (!city) {
    console.log('[MORNING-BRIEFING] 🌤️ Sin ciudad configurada — saltando clima. Owner debe decir su ciudad en self-chat.');
    return;
  }

  try {
    if (_deps.integrationEngine?.checkWeather) {
      await _deps.integrationEngine.checkWeather(_ownerUid, city);
      console.log(`[MORNING-BRIEFING] 🌤️ Clima de ${city} chequeado`);
    } else {
      console.log('[MORNING-BRIEFING] 🌤️ integrationEngine.checkWeather no disponible');
    }
  } catch (e) {
    console.error(`[MORNING-BRIEFING] ❌ Error clima: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// BRIEFING 2: NOTICIAS (8 AM default)
// Resumen de ayer basado en intereses detectados del owner.
// ═══════════════════════════════════════════════════════════════════

async function runNoticiasBriefing(schedule) {
  try {
    if (_deps.integrationEngine?.checkNews) {
      await _deps.integrationEngine.checkNews(_ownerUid);
      console.log('[MORNING-BRIEFING] 📰 Noticias chequeadas (basadas en intereses del owner)');
    } else if (_deps.integrationEngine?.runIntegrationEngine) {
      // Fallback: usar engine general si no hay checkNews específico
      await _deps.integrationEngine.runIntegrationEngine();
      console.log('[MORNING-BRIEFING] 📰 Integraciones ejecutadas (incluye noticias)');
    }
  } catch (e) {
    console.error(`[MORNING-BRIEFING] ❌ Error noticias: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// BRIEFING 3: DEPORTES + PRECIOS + INTEGRACIONES (10 AM default)
// Deportes: SOLO los que al owner le gustan.
// Precios: cambios + disponibilidad stock.
// Integraciones: YouTube, etc.
// ═══════════════════════════════════════════════════════════════════

async function runDeportesPreciosInteg(schedule) {
  const results = { sports: [], prices: null, integrations: null };

  // ═══ DEPORTES: SOLO los que el owner sigue ═══
  try {
    if (_deps.sportEngine?.checkSchedules) {
      const todayEvents = await _deps.sportEngine.checkSchedules();
      if (todayEvents && todayEvents.length > 0) {
        results.sports = todayEvents;
        console.log(`[MORNING-BRIEFING] ⚽ ${todayEvents.length} evento(s) deportivo(s) hoy (solo deportes del owner)`);

        for (const event of todayEvents) {
          scheduleEventPolling(event);
        }
      } else {
        console.log('[MORNING-BRIEFING] ⚽ Sin eventos deportivos hoy para los gustos del owner');
      }
    }
  } catch (e) {
    console.error(`[MORNING-BRIEFING] ❌ Error chequeando deportes: ${e.message}`);
  }

  // ═══ PRECIOS: cambios + stock ═══
  try {
    if (_deps.priceTracker?.checkPrices) {
      await _deps.priceTracker.checkPrices(_ownerUid);
      console.log('[MORNING-BRIEFING] 💰 Chequeo de precios + stock completado');
    }
  } catch (e) {
    console.error(`[MORNING-BRIEFING] ❌ Error chequeando precios: ${e.message}`);
  }

  // ═══ INTEGRACIONES: YouTube, etc. (NO clima, NO noticias — esas tienen su hora) ═══
  try {
    if (_deps.integrationEngine?.checkYouTube) {
      await _deps.integrationEngine.checkYouTube(_ownerUid);
      console.log('[MORNING-BRIEFING] 📱 YouTube chequeado');
    } else if (_deps.integrationEngine?.runIntegrationEngine) {
      await _deps.integrationEngine.runIntegrationEngine();
      console.log('[MORNING-BRIEFING] 📱 Integraciones ejecutadas');
    }
  } catch (e) {
    console.error(`[MORNING-BRIEFING] ❌ Error en integraciones: ${e.message}`);
  }

  console.log(`[MORNING-BRIEFING] ✅ Briefing deportes+precios+integ completo — ${results.sports.length} eventos agendados`);
}

// ═══════════════════════════════════════════════════════════════════
// BRIEFING 4: VUELOS (3 PM default, 1 vez/día)
// ═══════════════════════════════════════════════════════════════════

async function runVuelosBriefing() {
  try {
    if (_deps.travelTracker?.checkFlightAlerts) {
      await _deps.travelTracker.checkFlightAlerts(_ownerUid);
      console.log('[MORNING-BRIEFING] ✈️ Chequeo de vuelos completado');
    }
  } catch (e) {
    console.error(`[MORNING-BRIEFING] ❌ Error chequeando vuelos: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// POLLING EN VIVO — Solo durante eventos deportivos
// ═══════════════════════════════════════════════════════════════════

/**
 * Agenda el polling en vivo para un evento deportivo.
 * Timer 5 min antes del inicio, luego polling al ritmo del deporte.
 */
function scheduleEventPolling(event) {
  try {
    const now = Date.now();
    const startTime = new Date(event.startTime).getTime();
    const delayMs = Math.max(0, startTime - now - 300000); // 5 min antes

    if (delayMs > 24 * 3600000) {
      console.log(`[MORNING-BRIEFING] ⏭️ Evento ${event.name} es mañana o después — ignorando`);
      return;
    }

    const pollInterval = event.pollIntervalMs || 60000;
    const eventDuration = event.maxDurationMs || 4 * 3600000;

    console.log(`[MORNING-BRIEFING] ⏰ ${event.name} — polling en ${Math.round(delayMs / 60000)} min (cada ${pollInterval / 1000}s)`);

    const timer = setTimeout(() => {
      console.log(`[MORNING-BRIEFING] 🔴 EN VIVO: ${event.name} — iniciando polling (cada ${pollInterval / 1000}s)`);

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

      // Auto-stop después de duración máxima
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

// ═══════════════════════════════════════════════════════════════════
// ON-DEMAND — Cuando el usuario pregunta algo
// ═══════════════════════════════════════════════════════════════════

/**
 * Consulta ON-DEMAND — "¿cómo va Boca?", "¿bajó el precio?", "¿qué clima hay?"
 * @param {string} type - 'sport'|'price'|'integration'|'weather'|'news'|'flight'|'all'
 */
async function onDemandCheck(type = 'all') {
  console.log(`[MORNING-BRIEFING] 🔍 Consulta ON-DEMAND: ${type}`);
  const results = {};

  if (type === 'sport' || type === 'all') {
    try {
      if (_deps?.sportEngine?.runSportsEngine) {
        await _deps.sportEngine.runSportsEngine();
        results.sport = 'checked';
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
      }
    } catch (e) {
      console.error(`[MORNING-BRIEFING] ❌ On-demand price: ${e.message}`);
      results.price = 'error';
    }
  }

  if (type === 'weather') {
    try {
      const schedule = await getBriefingSchedule();
      if (schedule.city && _deps?.integrationEngine?.checkWeather) {
        await _deps.integrationEngine.checkWeather(_ownerUid, schedule.city);
        results.weather = 'checked';
      }
    } catch (e) {
      console.error(`[MORNING-BRIEFING] ❌ On-demand weather: ${e.message}`);
      results.weather = 'error';
    }
  }

  if (type === 'news') {
    try {
      if (_deps?.integrationEngine?.checkNews) {
        await _deps.integrationEngine.checkNews(_ownerUid);
        results.news = 'checked';
      }
    } catch (e) {
      console.error(`[MORNING-BRIEFING] ❌ On-demand news: ${e.message}`);
      results.news = 'error';
    }
  }

  if (type === 'flight') {
    try {
      if (_deps?.travelTracker?.checkFlightAlerts) {
        await _deps.travelTracker.checkFlightAlerts(_ownerUid);
        results.flight = 'checked';
      }
    } catch (e) {
      console.error(`[MORNING-BRIEFING] ❌ On-demand flight: ${e.message}`);
      results.flight = 'error';
    }
  }

  if (type === 'integration' || type === 'all') {
    try {
      if (_deps?.integrationEngine?.runIntegrationEngine) {
        await _deps.integrationEngine.runIntegrationEngine();
        results.integration = 'checked';
      }
    } catch (e) {
      console.error(`[MORNING-BRIEFING] ❌ On-demand integration: ${e.message}`);
      results.integration = 'error';
    }
  }

  return results;
}

/**
 * Forzar un briefing específico o todos (para testing o comando manual).
 * @param {string} type - 'clima'|'noticias'|'deportes'|'vuelos'|'all'
 */
async function forceBriefing(type = 'all') {
  const schedule = await getBriefingSchedule();

  if (type === 'clima' || type === 'all') await runClimaBriefing(schedule);
  if (type === 'noticias' || type === 'all') await runNoticiasBriefing(schedule);
  if (type === 'deportes' || type === 'all') await runDeportesPreciosInteg(schedule);
  if (type === 'vuelos' || type === 'all') await runVuelosBriefing();

  const { date } = await getOwnerLocalTime();
  _lastBriefingDate = date;
}

/**
 * Health check del morning briefing.
 */
async function healthCheck() {
  const schedule = await getBriefingSchedule();
  return {
    initialized: !!_deps,
    briefingsDone: _briefingsDone,
    lastBriefingDate: _lastBriefingDate,
    schedule: {
      clima: `${schedule.climaHour}:00`,
      noticias: `${schedule.noticiasHour}:00`,
      deportes: `${schedule.deportesHour}:00`,
      vuelos: `${schedule.vuelosHour}:00`,
      city: schedule.city || '(no configurada)',
      ownerNationality: schedule.ownerNationality || '(no detectada)'
    },
    scheduledEvents: _activeEventTimers.map(t => t.event?.name || 'unknown'),
    activeLivePollers: _activeLivePollers.map(p => ({
      event: p.event?.name,
      runningFor: `${Math.round((Date.now() - p.startedAt) / 60000)} min`
    }))
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

/**
 * Invalida el cache del schedule (llamar cuando owner cambia config).
 */
function invalidateScheduleCache() {
  _cachedSchedule = null;
  _lastScheduleFetch = 0;
}

module.exports = {
  init,
  onDemandCheck,
  forceBriefing,
  healthCheck,
  stop,
  updateBriefingHour,
  updateOwnerCity,
  invalidateScheduleCache,
  getBriefingSchedule
};
