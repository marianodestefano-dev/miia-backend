'use strict';

/**
 * circuit_live_service.js — orquestador SVG live con dots multi-driver.
 *
 * Firma Mariano 2026-05-12 ~22:30 COT: "decido tu recomendacion!!! y continua
 * con lo que venias haciendo por favor!" sobre opción A: trazados REALES
 * bacinger/f1-circuits + OpenF1 /location para coords tiempo real + dots
 * animados + tooltip click → driver info.
 *
 * Funciones:
 *   - mapLocationsToBacingerBbox(locations, bacingerBbox)
 *     Adapter coords OpenF1 (x,y metros local) → lat/lon en bbox bacinger.
 *     Es aproximación lineal — para Q2 MVP suficiente. Calibración precisa
 *     por circuito = scope post-MVP.
 *   - mergeDriversInfo(locations, driversInfo, adoptedDriverNum)
 *     Combina coords OpenF1 + nombres/colores OpenF1 /drivers en formato
 *     que consume circuit_live_renderer.
 *   - buildLiveCircuitSvg(args)
 *     Pipeline completo: session → location + drivers → adapter → SVG.
 *
 * Modulo PURO con inyección fetch para tests.
 */

const { getCircuitBBox } = require('./circuit_data');
const { renderLiveCircuit } = require('./circuit_live_renderer');
const { resolveCircuitId } = require('./circuit_maps');
const telemetry = require('./f1_telemetry');

/**
 * Adapter: mapea coords OpenF1 (x,y) al bbox bacinger (lat/lon).
 * Aproximación lineal — normaliza al rango observado de las locations.
 *
 * @param {Array<{driver_number, x, y, z, date}>} locations
 * @param {Array<number>} bacingerBbox — [minLon, minLat, maxLon, maxLat]
 * @returns {Array<{driver_number, lat, lon}>}
 */
function mapLocationsToBacingerBbox(locations, bacingerBbox) {
  if (!Array.isArray(locations) || locations.length === 0) return [];
  if (!Array.isArray(bacingerBbox) || bacingerBbox.length !== 4) return [];

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const loc of locations) {
    if (typeof loc.x !== 'number' || typeof loc.y !== 'number') continue;
    if (loc.x < minX) minX = loc.x;
    if (loc.x > maxX) maxX = loc.x;
    if (loc.y < minY) minY = loc.y;
    if (loc.y > maxY) maxY = loc.y;
  }
  // Sin coords válidas
  if (!Number.isFinite(minX)) return [];

  const dX = maxX - minX || 1;
  const dY = maxY - minY || 1;
  const [bMinLon, bMinLat, bMaxLon, bMaxLat] = bacingerBbox;
  const dLon = bMaxLon - bMinLon;
  const dLat = bMaxLat - bMinLat;

  return locations
    .filter((l) => typeof l.x === 'number' && typeof l.y === 'number')
    .map((l) => ({
      driver_number: l.driver_number,
      lon: bMinLon + ((l.x - minX) / dX) * dLon,
      lat: bMinLat + ((l.y - minY) / dY) * dLat,
    }));
}

/**
 * Combina coords + drivers info (de OpenF1 /drivers).
 *
 * @param {Array<{driver_number, lat, lon}>} mappedLocations
 * @param {Array<{driver_number, full_name, broadcast_name, team_name, team_colour, name_acronym}>} driversInfo
 * @param {number|string|null} adoptedDriverNum — driver_number del piloto adoptado
 * @returns {Array<{driver_number, lat, lon, team_color, driver_name, team_name, is_adopted}>}
 */
function mergeDriversInfo(mappedLocations, driversInfo, adoptedDriverNum) {
  if (!Array.isArray(mappedLocations)) return [];
  const infoByNum = new Map();
  if (Array.isArray(driversInfo)) {
    for (const d of driversInfo) {
      if (d && d.driver_number != null) infoByNum.set(d.driver_number, d);
    }
  }
  const adoptedKey = adoptedDriverNum != null ? Number(adoptedDriverNum) : null;
  return mappedLocations.map((l) => {
    const info = infoByNum.get(l.driver_number) || {};
    const team_colour = info.team_colour ? '#' + String(info.team_colour).replace(/^#/, '') : '#FFFFFF';
    const driver_name = info.full_name || info.broadcast_name || info.name_acronym || ('#' + l.driver_number);
    return {
      driver_number: l.driver_number,
      lat: l.lat,
      lon: l.lon,
      team_color: team_colour,
      driver_name,
      team_name: info.team_name || '',
      is_adopted: adoptedKey !== null && Number(l.driver_number) === adoptedKey,
    };
  });
}

/**
 * Pipeline completo. Devuelve { svg, isLive, sessionKey, driverCount }.
 *
 * @param {Object} args
 *   - circuitId: string — legacy id ("monaco") o fileId ("mc-1929")
 *   - fetchFn: function — inyectable para tests; default usa global fetch
 *   - adoptedDriverNum?: number|string — piloto adoptado para highlight
 *   - viewport?: { width, height, padding }
 *   - showLabels?: boolean
 * @returns {Promise<{ svg: string|null, isLive: boolean, sessionKey: number|null, driverCount: number }>}
 */
async function buildLiveCircuitSvg(args) {
  const a = args || {};
  const circuitId = a.circuitId;
  /* istanbul ignore next — defensive: prod usa global fetch */
  const fetchFn = a.fetchFn || ((...x) => fetch(...x));

  const fileId = resolveCircuitId(circuitId);
  if (!fileId) return { svg: null, isLive: false, sessionKey: null, driverCount: 0 };

  // 1) Session activa
  let session = null;
  try {
    session = await telemetry.getCurrentSession(fetchFn);
  } catch (_e) {
    /* sin session → render trazado vacío */
    session = null;
  }

  // 2) Si no hay sesión live, devolver SVG estático (sin dots).
  if (!session || !session.session_key) {
    const svg = renderLiveCircuit({ circuitId, drivers: [], viewport: a.viewport });
    return { svg, isLive: false, sessionKey: null, driverCount: 0 };
  }

  // 3) Sesión live: fetch location + drivers info en paralelo
  let locations = [];
  let driversInfo = [];
  try {
    const [locs, drivers] = await Promise.all([
      telemetry.getAllDriversLocation(fetchFn, session.session_key),
      _fetchDriversInfo(fetchFn, session.session_key),
    ]);
    locations = Array.isArray(locs) ? locs : [];
    /* istanbul ignore next — defensive: _fetchDriversInfo ya garantiza array */
    driversInfo = Array.isArray(drivers) ? drivers : [];
  } catch (_e) {
    /* fallo OpenF1 → render trazado solo */
    locations = [];
    driversInfo = [];
  }

  // 4) Adapter coords + merge
  const bbox = getCircuitBBox(fileId);
  const mapped = mapLocationsToBacingerBbox(locations, bbox);
  const drivers = mergeDriversInfo(mapped, driversInfo, a.adoptedDriverNum);

  // 5) Render
  const svg = renderLiveCircuit({
    circuitId,
    drivers,
    viewport: a.viewport,
    showLabels: a.showLabels,
  });

  return {
    svg,
    isLive: true,
    sessionKey: session.session_key,
    driverCount: drivers.length,
  };
}

/**
 * Helper interno: fetch OpenF1 /drivers para una sesión.
 *
 * @param {Function} fetchFn
 * @param {number} sessionKey
 * @returns {Promise<Array<Object>>}
 */
async function _fetchDriversInfo(fetchFn, sessionKey) {
  const url = 'https://api.openf1.org/v1/drivers?session_key=' + sessionKey;
  const resp = await fetchFn(url);
  /* istanbul ignore next — defensive: tests mock con resp OK */
  if (!resp || !resp.ok) return [];
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

module.exports = {
  mapLocationsToBacingerBbox,
  mergeDriversInfo,
  buildLiveCircuitSvg,
  _fetchDriversInfo,
};
