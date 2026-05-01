'use strict';

/**
 * MiiaF1 — Live timing scraper
 * Scraper PROPIO apuntando a fuentes publicas de F1.
 * OpenF1 API estudiada como referencia arquitectonica SOLAMENTE.
 *
 * Polling: 2s durante carrera, 30s fuera de carrera.
 * Circuit breaker: 3 fallos consecutivos -> pausa 60s.
 * 10 fallos -> CRITICAL + notif.
 */

'use strict';

const axios = require('axios');
const { getLiveCache } = require('./live_cache');

// ─── Constantes ───────────────────────────────────────
const POLL_RACE_MS = 2000;
const POLL_IDLE_MS = 30000;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_PAUSE_MS = 60000;
const CRITICAL_THRESHOLD = 10;

// ─── Estado del scraper ───────────────────────────────
const state = {
  isPolling: false,
  pollTimer: null,
  consecutiveFailures: 0,
  totalFailures: 0,
  circuitOpen: false,
  circuitOpenAt: null,
  lastSuccessAt: null,
  raceStatus: { isLive: false, session: null, lap: 0, totalLaps: 0 },
  onCritical: null, // callback para notificacion critica
};

/**
 * Detecta si hay un GP activo actualmente (race weekend).
 * @returns {Promise<boolean>}
 */
async function isRaceWeekend() {
  try {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Dom, 5=Vie, 6=Sab
    const hour = now.getUTCHours();

    // Heuristica: race weekends son Vie-Dom. Si es Lun-Jue, no hay carrera.
    if (dayOfWeek >= 1 && dayOfWeek <= 4) return false;

    // Intentar HEAD request a fuente live para ver si hay datos frescos
    const resp = await axios.head(
      'https://www.formula1.com/en/live-timing.html',
      { timeout: 5000, validateStatus: () => true }
    );
    return resp.status < 400;
  } catch {
    // Si no podemos verificar, asumir que podria haber carrera en Vie-Dom
    const day = new Date().getDay();
    return day === 0 || day === 5 || day === 6;
  }
}

/**
 * Hace poll del estado live desde formula1.com
 * Parsea el endpoint publico de timing data.
 * @returns {Promise<object|null>}
 */
async function fetchLiveState() {
  try {
    // Endpoint publico de F1 live timing (datos fragmentados en tiempo real)
    const resp = await axios.get(
      'https://livetiming.formula1.com/static/feeds/position.json',
      {
        timeout: 8000,
        headers: {
          'Accept': 'application/json',
          'Referer': 'https://www.formula1.com/',
          'User-Agent': 'Mozilla/5.0 (compatible; MiiaF1/1.0)',
        },
        signal: AbortSignal.timeout(8000),
      }
    );

    if (!resp.data) return null;

    // Parsear posiciones del feed
    const raw = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
    return parsePositionFeed(raw);
  } catch (err) {
    throw new Error(`fetchLiveState: ${err.message}`);
  }
}

/**
 * Parsea el feed de posiciones de F1 live timing.
 * @param {object} raw
 * @returns {object}
 */
function parsePositionFeed(raw) {
  if (!raw) return null;

  // El feed de F1 tiene estructura: { Position: { Timestamp, Entries: { "1": { Status, X, Y } } } }
  const entries = raw?.Position?.Entries || raw?.Entries || {};
  const positions = [];

  for (const [driverNum, data] of Object.entries(entries)) {
    if (data && data.Status !== undefined) {
      positions.push({
        driver_number: parseInt(driverNum, 10),
        position: data.Position || 0,
        status: data.Status || 'OnTrack',
        lap: data.NumberOfLaps || 0,
        gap: data.GapToLeader || '',
        interval: data.IntervalToPositionAhead?.Value || '',
        tyre: data.TyreAge || '',
        pit_count: data.NumberOfPitStops || 0,
      });
    }
  }

  positions.sort((a, b) => (a.position || 99) - (b.position || 99));

  return {
    isLive: positions.length > 0,
    session: raw?.SessionInfo?.Name || 'Race',
    lap: raw?.LapCount?.CurrentLap || 0,
    totalLaps: raw?.LapCount?.TotalLaps || 0,
    positions,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Loop de polling principal.
 */
async function _pollLoop() {
  if (!state.isPolling) return;

  try {
    // Circuit breaker: si esta abierto, verificar si paso la pausa
    if (state.circuitOpen) {
      const elapsed = Date.now() - state.circuitOpenAt;
      if (elapsed < CIRCUIT_BREAKER_PAUSE_MS) {
        console.warn(`[F1-LIVE] Circuit breaker abierto. Reintentando en ${Math.round((CIRCUIT_BREAKER_PAUSE_MS - elapsed) / 1000)}s`);
        state.pollTimer = setTimeout(_pollLoop, CIRCUIT_BREAKER_PAUSE_MS - elapsed);
        return;
      }
      state.circuitOpen = false;
      state.consecutiveFailures = 0;
      console.log('[F1-LIVE] Circuit breaker cerrado, reanudando polling');
    }

    const isWeekend = await isRaceWeekend();
    if (!isWeekend) {
      state.raceStatus.isLive = false;
      await getLiveCache().setRaceStatus({ isLive: false });
      state.pollTimer = setTimeout(_pollLoop, POLL_IDLE_MS);
      return;
    }

    const liveData = await fetchLiveState();
    if (liveData) {
      state.consecutiveFailures = 0;
      state.lastSuccessAt = Date.now();
      state.raceStatus = { isLive: liveData.isLive, session: liveData.session, lap: liveData.lap, totalLaps: liveData.totalLaps };

      const cache = getLiveCache();
      await cache.setRaceStatus(state.raceStatus);
      for (const pos of liveData.positions) {
        await cache.setDriverPosition(pos.driver_number, pos);
      }
    }

    const interval = liveData?.isLive ? POLL_RACE_MS : POLL_IDLE_MS;
    state.pollTimer = setTimeout(_pollLoop, interval);

  } catch (err) {
    state.consecutiveFailures++;
    state.totalFailures++;
    console.error(`[F1-LIVE] Poll error #${state.consecutiveFailures}: ${err.message}`);

    if (state.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      state.circuitOpen = true;
      state.circuitOpenAt = Date.now();
      console.warn(`[F1-LIVE] Circuit breaker ABIERTO tras ${state.consecutiveFailures} fallos`);
    }

    if (state.totalFailures >= CRITICAL_THRESHOLD && state.onCritical) {
      state.onCritical(`[F1-LIVE] CRITICAL: ${state.totalFailures} fallos totales. Ultimo: ${err.message}`);
    }

    const retryMs = state.circuitOpen ? CIRCUIT_BREAKER_PAUSE_MS : POLL_IDLE_MS;
    state.pollTimer = setTimeout(_pollLoop, retryMs);
  }
}

function start(opts = {}) {
  if (state.isPolling) return;
  state.isPolling = true;
  state.onCritical = opts.onCritical || null;
  console.log('[F1-LIVE] Scraper iniciado');
  _pollLoop();
}

function stop() {
  state.isPolling = false;
  if (state.pollTimer) clearTimeout(state.pollTimer);
  console.log('[F1-LIVE] Scraper detenido');
}

function getState() { return { ...state.raceStatus, circuitOpen: state.circuitOpen, lastSuccessAt: state.lastSuccessAt }; }

// Para tests
function _resetState() {
  state.isPolling = false;
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.consecutiveFailures = 0;
  state.totalFailures = 0;
  state.circuitOpen = false;
  state.circuitOpenAt = null;
  state.lastSuccessAt = null;
  state.raceStatus = { isLive: false, session: null, lap: 0, totalLaps: 0 };
}

module.exports = { start, stop, getState, isRaceWeekend, fetchLiveState, parsePositionFeed, _resetState, _constants: { CIRCUIT_BREAKER_THRESHOLD, CIRCUIT_BREAKER_PAUSE_MS, CRITICAL_THRESHOLD } };
