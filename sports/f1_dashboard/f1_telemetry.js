'use strict';

/**
 * MiiaF1 — Telemetria F1 completa via OpenF1 API
 * Firma viva Mariano 2026-05-02 chat:
 *   "Quiero ver la carrera en vivo por TV y mirar la web de MIIAF1 y ver
 *    exactamente los tiempos de un piloto y seguirlo por el circuito"
 *
 * Cubre todos los eventos: FP1/FP2/FP3, Qualy, Sprint Qualy, Sprint, Carrera.
 *
 * Modulo PURO: usa fetchFn inyectable para tests. El caller hace el caching.
 *
 * Endpoints OpenF1 utilizados (gratis, sin API key):
 *   /v1/sessions   — info sesion (FP1/FP2/FP3/Q/SQ/S/R, country, year)
 *   /v1/intervals  — gap al lider + gap al de delante (segundos)
 *   /v1/laps       — lap times + sectores S1/S2/S3
 *   /v1/stints     — stints + neumatico (compound + tyre_age_at_start)
 *   /v1/pit        — pit stops
 *   /v1/location   — coords X,Y,Z reales del GPS del auto
 *   /v1/car_data   — telemetria (rpm, speed, gear, throttle, brake, drs)
 */

const OPENF1_BASE = 'https://api.openf1.org/v1';

// Tipos de sesion soportados (firma Mariano)
const SESSION_TYPES = Object.freeze({
  Practice_1: 'Práctica Libre 1',
  Practice_2: 'Práctica Libre 2',
  Practice_3: 'Práctica Libre 3',
  Sprint_Shootout: 'Qualy Sprint',
  Sprint: 'Carrera Sprint',
  Qualifying: 'Qualy',
  Race: 'Carrera',
});

const TYRE_COMPOUNDS = Object.freeze({
  SOFT: 'Blandos',
  MEDIUM: 'Medios',
  HARD: 'Duros',
  INTERMEDIATE: 'Intermedios',
  WET: 'Lluvia',
});

/**
 * Helper genérico para fetch + parse JSON con timeout.
 *
 * @param {Function} fetchFn — fetch-compatible (default global fetch)
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<any>} JSON parseado, o array vacio si error
 */
async function fetchJson(fetchFn, url, timeoutMs = 5000) {
  const fn = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fn) throw new Error('fetchFn requerido (no hay fetch global)');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fn(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timeout ${timeoutMs}ms en ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Obtiene la sesion actualmente activa (la mas reciente).
 *
 * @param {Function} fetchFn
 * @returns {Promise<{session_key, session_name, session_type_label, country_name, date_start, date_end, year}|null>}
 */
async function getCurrentSession(fetchFn) {
  const url = `${OPENF1_BASE}/sessions?session_key=latest`;
  const sessions = await fetchJson(fetchFn, url);
  if (!sessions.length) return null;
  const s = sessions[0];
  return {
    session_key: s.session_key,
    session_name: s.session_name,
    session_type_label: SESSION_TYPES[s.session_name] || s.session_name,
    country_name: s.country_name,
    circuit_short_name: s.circuit_short_name,
    date_start: s.date_start,
    date_end: s.date_end,
    year: s.year,
    meeting_key: s.meeting_key,
  };
}

/**
 * Verifica si una sesion esta en curso ahora.
 *
 * @param {object} session — output de getCurrentSession
 * @param {Date} [now]
 * @returns {boolean}
 */
function isSessionLive(session, now = new Date()) {
  if (!session?.date_start || !session?.date_end) return false;
  const start = new Date(session.date_start);
  const end = new Date(session.date_end);
  return now >= start && now <= end;
}

/**
 * Obtiene los intervals (gap al lider + gap al de delante) de un piloto.
 *
 * @param {Function} fetchFn
 * @param {number} sessionKey
 * @param {number} driverNumber
 * @returns {Promise<{gap_to_leader: number|null, interval: number|null, last_seen: string|null}>}
 */
async function getDriverIntervals(fetchFn, sessionKey, driverNumber) {
  if (!sessionKey || !driverNumber) {
    return { gap_to_leader: null, interval: null, last_seen: null };
  }
  const url = `${OPENF1_BASE}/intervals?session_key=${sessionKey}&driver_number=${driverNumber}`;
  const rows = await fetchJson(fetchFn, url);
  if (!rows.length) return { gap_to_leader: null, interval: null, last_seen: null };
  // El último row es el más reciente
  const last = rows[rows.length - 1];
  return {
    gap_to_leader: last.gap_to_leader ?? null,
    interval: last.interval ?? null,
    last_seen: last.date || null,
  };
}

/**
 * Obtiene los datos de las vueltas del piloto.
 *
 * @param {Function} fetchFn
 * @param {number} sessionKey
 * @param {number} driverNumber
 * @returns {Promise<{lap_number, lap_duration, sector_1, sector_2, sector_3, is_pit_out_lap}[]>}
 */
async function getDriverLapData(fetchFn, sessionKey, driverNumber) {
  if (!sessionKey || !driverNumber) return [];
  const url = `${OPENF1_BASE}/laps?session_key=${sessionKey}&driver_number=${driverNumber}`;
  const rows = await fetchJson(fetchFn, url);
  return rows.map((l) => ({
    lap_number: l.lap_number,
    lap_duration: l.lap_duration,
    sector_1: l.duration_sector_1,
    sector_2: l.duration_sector_2,
    sector_3: l.duration_sector_3,
    is_pit_out_lap: !!l.is_pit_out_lap,
    date_start: l.date_start,
  }));
}

/**
 * Obtiene la vuelta mas rapida del piloto en la sesion.
 *
 * @param {object[]} laps — output de getDriverLapData
 * @returns {object|null}
 */
function getFastestLap(laps) {
  if (!Array.isArray(laps) || laps.length === 0) return null;
  let fastest = null;
  for (const l of laps) {
    if (typeof l.lap_duration !== 'number') continue;
    if (l.is_pit_out_lap) continue;
    if (!fastest || l.lap_duration < fastest.lap_duration) fastest = l;
  }
  return fastest;
}

/**
 * Obtiene el stint actual del piloto (neumatico + vueltas).
 *
 * @param {Function} fetchFn
 * @param {number} sessionKey
 * @param {number} driverNumber
 * @returns {Promise<{compound, compound_label, tyre_age_at_start, lap_start, lap_end, stint_number}|null>}
 */
async function getCurrentStint(fetchFn, sessionKey, driverNumber) {
  if (!sessionKey || !driverNumber) return null;
  const url = `${OPENF1_BASE}/stints?session_key=${sessionKey}&driver_number=${driverNumber}`;
  const stints = await fetchJson(fetchFn, url);
  if (!stints.length) return null;
  const last = stints[stints.length - 1];
  return {
    compound: last.compound,
    compound_label: TYRE_COMPOUNDS[last.compound] || last.compound,
    tyre_age_at_start: last.tyre_age_at_start ?? 0,
    lap_start: last.lap_start,
    lap_end: last.lap_end,
    stint_number: last.stint_number,
  };
}

/**
 * Obtiene los pit stops del piloto.
 *
 * @param {Function} fetchFn
 * @param {number} sessionKey
 * @param {number} driverNumber
 * @returns {Promise<Array>}
 */
async function getDriverPits(fetchFn, sessionKey, driverNumber) {
  if (!sessionKey || !driverNumber) return [];
  const url = `${OPENF1_BASE}/pit?session_key=${sessionKey}&driver_number=${driverNumber}`;
  const rows = await fetchJson(fetchFn, url);
  return rows.map((p) => ({
    lap_number: p.lap_number,
    pit_duration: p.pit_duration,
    date: p.date,
  }));
}

/**
 * Obtiene la ubicacion (X,Y,Z) mas reciente del piloto.
 * Las coords son las reales del GPS del auto sobre el circuito.
 *
 * @param {Function} fetchFn
 * @param {number} sessionKey
 * @param {number} driverNumber
 * @param {Date} [sinceDate] — fecha desde la cual buscar (default: ultimo minuto)
 * @returns {Promise<{x, y, z, date}|null>}
 */
async function getDriverLocation(fetchFn, sessionKey, driverNumber, sinceDate) {
  if (!sessionKey || !driverNumber) return null;
  const since = sinceDate || new Date(Date.now() - 60 * 1000);
  const url = `${OPENF1_BASE}/location?session_key=${sessionKey}&driver_number=${driverNumber}&date>=${since.toISOString()}`;
  const rows = await fetchJson(fetchFn, url);
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  return { x: last.x, y: last.y, z: last.z, date: last.date };
}

/**
 * Obtiene la telemetria mas reciente del piloto.
 *
 * @param {Function} fetchFn
 * @param {number} sessionKey
 * @param {number} driverNumber
 * @param {Date} [sinceDate]
 * @returns {Promise<{rpm, speed, gear, throttle, brake, drs, date}|null>}
 */
async function getDriverTelemetry(fetchFn, sessionKey, driverNumber, sinceDate) {
  if (!sessionKey || !driverNumber) return null;
  const since = sinceDate || new Date(Date.now() - 30 * 1000);
  const url = `${OPENF1_BASE}/car_data?session_key=${sessionKey}&driver_number=${driverNumber}&date>=${since.toISOString()}`;
  const rows = await fetchJson(fetchFn, url);
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  return {
    rpm: last.rpm,
    speed: last.speed,
    gear: last.n_gear,
    throttle: last.throttle,
    brake: last.brake,
    drs: last.drs,
    date: last.date,
  };
}

/**
 * Obtiene la ubicacion de TODOS los pilotos en la sesion (para overlay circuito).
 *
 * @param {Function} fetchFn
 * @param {number} sessionKey
 * @param {Date} [sinceDate]
 * @returns {Promise<Array<{driver_number, x, y, z, date}>>}
 */
async function getAllDriversLocation(fetchFn, sessionKey, sinceDate) {
  if (!sessionKey) return [];
  const since = sinceDate || new Date(Date.now() - 5 * 1000);
  const url = `${OPENF1_BASE}/location?session_key=${sessionKey}&date>=${since.toISOString()}`;
  const rows = await fetchJson(fetchFn, url);

  // Agrupar por driver_number, tomar solo el más reciente de cada uno
  const latestByDriver = new Map();
  for (const row of rows) {
    const existing = latestByDriver.get(row.driver_number);
    if (!existing || new Date(row.date) > new Date(existing.date)) {
      latestByDriver.set(row.driver_number, row);
    }
  }

  return Array.from(latestByDriver.values()).map((r) => ({
    driver_number: r.driver_number,
    x: r.x,
    y: r.y,
    z: r.z,
    date: r.date,
  }));
}

/**
 * Construye un snapshot completo del piloto para mostrar en el dashboard.
 *
 * @param {object} parts — { intervals, laps, stint, pits, location, telemetry }
 * @returns {object} snapshot listo para frontend
 */
function buildDriverSnapshot(parts) {
  const { intervals, laps, stint, pits, location, telemetry } = parts || {};
  const fastestLap = getFastestLap(laps || []);
  const lastLap = (laps && laps.length > 0) ? laps[laps.length - 1] : null;

  return {
    gap_to_leader: intervals?.gap_to_leader ?? null,
    interval: intervals?.interval ?? null,
    current_lap: lastLap?.lap_number ?? null,
    last_lap_time: lastLap?.lap_duration ?? null,
    last_sectors: lastLap ? {
      s1: lastLap.sector_1,
      s2: lastLap.sector_2,
      s3: lastLap.sector_3,
    } : null,
    fastest_lap_time: fastestLap?.lap_duration ?? null,
    fastest_lap_number: fastestLap?.lap_number ?? null,
    tyre: stint ? {
      compound: stint.compound,
      compound_label: stint.compound_label,
      age: stint.tyre_age_at_start,
      stint_number: stint.stint_number,
    } : null,
    total_pits: (pits || []).length,
    last_pit_lap: pits && pits.length > 0 ? pits[pits.length - 1].lap_number : null,
    location: location ? { x: location.x, y: location.y, z: location.z } : null,
    telemetry: telemetry || null,
    snapshot_at: new Date().toISOString(),
  };
}

module.exports = {
  OPENF1_BASE,
  SESSION_TYPES,
  TYRE_COMPOUNDS,
  fetchJson,
  getCurrentSession,
  isSessionLive,
  getDriverIntervals,
  getDriverLapData,
  getFastestLap,
  getCurrentStint,
  getDriverPits,
  getDriverLocation,
  getDriverTelemetry,
  getAllDriversLocation,
  buildDriverSnapshot,
};
