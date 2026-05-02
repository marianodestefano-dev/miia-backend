'use strict';

/**
 * session_detector.js — MiiaF1.45-47
 *
 * MiiaF1.45 — Detecta tipo de sesion desde OpenF1 session data:
 *             FP1 / FP2 / FP3 / Qualifying / Sprint Qualifying /
 *             Sprint / Race
 * MiiaF1.46 — Activa polling para TODOS los eventos del fin de semana
 *             (no solo la carrera principal).
 * MiiaF1.47 — Best lap tracker: mantiene record del momento, notifica
 *             cuando un piloto bate su propio mejor tiempo.
 */

// ─── MiiaF1.45 — Session type detection ─────────────────────────────────────

const SESSION_TYPE_MAP = {
  'Practice 1': 'FP1',
  'Practice 2': 'FP2',
  'Practice 3': 'FP3',
  'Qualifying': 'Qualifying',
  'Sprint Qualifying': 'Sprint Qualifying',
  'Sprint': 'Sprint',
  'Race': 'Race',
};

const SESSION_LABELS = {
  FP1: 'PRÁCTICA LIBRE 1',
  FP2: 'PRÁCTICA LIBRE 2',
  FP3: 'PRÁCTICA LIBRE 3',
  Qualifying: 'CLASIFICACIÓN',
  'Sprint Qualifying': 'SPRINT CLASSIF.',
  Sprint: 'SPRINT',
  Race: 'CARRERA',
};

/**
 * Normaliza el session_name de OpenF1 al tipo canónico.
 * @param {string|undefined} sessionName - ej: 'Race', 'Practice 1', 'Qualifying'
 * @returns {string} - tipo canónico o 'Unknown'
 */
function normalizeSessionType(sessionName) {
  if (!sessionName) return 'Unknown';
  return SESSION_TYPE_MAP[sessionName] || 'Unknown';
}

/**
 * Retorna el label de display para el banner EN VIVO.
 * @param {string} sessionType - tipo normalizado
 * @returns {string}
 */
function getSessionLabel(sessionType) {
  return SESSION_LABELS[sessionType] || 'EN VIVO';
}

/**
 * Determina si una sesion es activa basado en los datos de OpenF1.
 * Una sesion esta activa si date_start <= now <= date_end (+2h buffer).
 * @param {object} session - { date_start, date_end, session_key }
 * @param {Date} [now] - inyectable para tests
 * @returns {boolean}
 */
function isSessionActive(session, now) {
  if (!session || !session.date_start) return false;
  const _now = now || new Date();
  const start = new Date(session.date_start);
  const rawEnd = session.date_end ? new Date(session.date_end) : null;
  const end = rawEnd || new Date(start.getTime() + 3 * 60 * 60 * 1000);
  const buffer = 2 * 60 * 60 * 1000;
  return _now >= start && _now <= new Date(end.getTime() + buffer);
}

/**
 * Filtra del array de sessions de OpenF1 cuales estan activas ahora.
 * MiiaF1.46 — activa polling para cualquier tipo de sesion, no solo Race.
 * @param {object[]} sessions - array de sessions OpenF1
 * @param {Date} [now] - inyectable para tests
 * @returns {object[]}
 */
function getActiveSessions(sessions, now) {
  if (!sessions || sessions.length === 0) return [];
  return sessions.filter((s) => isSessionActive(s, now));
}

/**
 * Elige la sesion mas relevante del fin de semana para mostrar en el banner.
 * Prioridad: Race > Sprint > Sprint Qualifying > Qualifying > FP3 > FP2 > FP1
 * @param {object[]} sessions - array de sessions OpenF1 con date_start
 * @param {Date} [now] - inyectable para tests
 * @returns {object|null} - session de mayor prioridad activa, o null
 */
const SESSION_PRIORITY = ['Race', 'Sprint', 'Sprint Qualifying', 'Qualifying', 'Practice 3', 'Practice 2', 'Practice 1'];

function selectPrimarySession(sessions, now) {
  const active = getActiveSessions(sessions, now);
  if (active.length === 0) return null;
  for (const prio of SESSION_PRIORITY) {
    const found = active.find((s) => s.session_name === prio);
    if (found) return found;
  }
  return active[0];
}

// ─── MiiaF1.47 — Best lap tracker ───────────────────────────────────────────

/**
 * Mantiene el estado del mejor vuelta del momento (por piloto y global).
 * Notifica via callback cuando se bate un record.
 */
function createBestLapTracker(onBestLapSet) {
  const _onBestLapSet = (typeof onBestLapSet === 'function') ? onBestLapSet : () => {};
  const perDriver = {};
  let overallBest = null;

  /**
   * Procesa un lap de OpenF1 y actualiza records.
   * @param {object} lap - { driver_number, lap_duration, lap_number, ... }
   */
  function processLap(lap) {
    if (!lap || lap.lap_duration == null) return;
    const dn = lap.driver_number;
    const dur = lap.lap_duration;

    let improved = false;
    if (!perDriver[dn] || dur < perDriver[dn].lap_duration) {
      perDriver[dn] = { ...lap };
      improved = true;
    }

    if (overallBest === null || dur < overallBest.lap_duration) {
      overallBest = { ...lap };
      _onBestLapSet({ type: 'overall', lap: overallBest });
    } else if (improved) {
      _onBestLapSet({ type: 'personal', lap: perDriver[dn] });
    }
  }

  /**
   * Procesa un array de laps (al recibir datos frescos de OpenF1).
   * @param {object[]} laps
   */
  function processLaps(laps) {
    if (!laps || laps.length === 0) return;
    for (const lap of laps) {
      processLap(lap);
    }
  }

  function getOverallBest() { return overallBest; }
  function getDriverBest(driverNumber) { return perDriver[driverNumber] || null; }
  function reset() {
    Object.keys(perDriver).forEach((k) => delete perDriver[k]);
    overallBest = null;
  }

  return { processLap, processLaps, getOverallBest, getDriverBest, reset };
}

module.exports = {
  normalizeSessionType,
  getSessionLabel,
  isSessionActive,
  getActiveSessions,
  selectPrimarySession,
  createBestLapTracker,
  SESSION_TYPE_MAP,
  SESSION_LABELS,
  SESSION_PRIORITY,
};
