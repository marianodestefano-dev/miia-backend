'use strict';

/**
 * circuit_data.js — MIIAF1 trazados REALES de circuitos (firma Mariano 2026-05-12 ~22:30 COT).
 *
 * Reemplazo de los SVG dibujados a mano de circuit_maps.js que Mariano vio en
 * pantalla y descalificó como basura ("garabato circular" en lugar de Mónaco).
 *
 * Fuente: github.com/bacinger/f1-circuits (MIT license, Tomislav Bacinger).
 * 40 circuitos en GeoJSON con coordenadas lat/lon REALES verificadas.
 * Cada GeoJSON tiene un Feature LineString con bbox + metadata
 * (Location, Name, opened, firstgp, length, altitude).
 *
 * Mapping completo Location → fileId (sin .geojson) + GP name desde el README
 * del repo upstream. Solo se exponen circuitos activos en el calendario F1
 * actual + algunos históricos relevantes.
 *
 * Lectura: lazy + cache en memoria (los GeoJSON no cambian, cargar 1 vez).
 */

const fs = require('fs');
const path = require('path');

const CIRCUITS_DIR = path.join(__dirname, 'circuits');

// Mapping fileId → metadata humana (location, GP name).
// fileId es el nombre del archivo sin .geojson (ej. "mc-1929").
const CIRCUITS_MANIFEST = Object.freeze({
  // Calendario F1 vigente 2024-2026
  'ae-2009': { location: 'Yas Marina', name: 'Yas Marina Circuit', gp: 'Abu Dhabi Grand Prix', country: 'AE' },
  'at-1969': { location: 'Spielberg', name: 'Red Bull Ring', gp: 'Austrian Grand Prix', country: 'AT' },
  'au-1953': { location: 'Melbourne', name: 'Albert Park Circuit', gp: 'Australian Grand Prix', country: 'AU' },
  'az-2016': { location: 'Baku', name: 'Baku City Circuit', gp: 'Azerbaijan Grand Prix', country: 'AZ' },
  'be-1925': { location: 'Spa Francorchamps', name: 'Circuit de Spa-Francorchamps', gp: 'Belgian Grand Prix', country: 'BE' },
  'bh-2002': { location: 'Sakhir', name: 'Bahrain International Circuit', gp: 'Bahrain Grand Prix', country: 'BH' },
  'br-1940': { location: 'Sao Paulo', name: 'Autódromo José Carlos Pace - Interlagos', gp: 'Brazilian Grand Prix', country: 'BR' },
  'ca-1978': { location: 'Montreal', name: 'Circuit Gilles-Villeneuve', gp: 'Canadian Grand Prix', country: 'CA' },
  'cn-2004': { location: 'Shanghai', name: 'Shanghai International Circuit', gp: 'Chinese Grand Prix', country: 'CN' },
  'es-1991': { location: 'Barcelona', name: 'Circuit de Barcelona-Catalunya', gp: 'Spanish Grand Prix', country: 'ES' },
  'es-2026': { location: 'Madrid', name: 'Circuito de Madring', gp: 'Madrid Grand Prix', country: 'ES' },
  'gb-1948': { location: 'Silverstone', name: 'Silverstone Circuit', gp: 'British Grand Prix', country: 'GB' },
  'hu-1986': { location: 'Budapest', name: 'Hungaroring', gp: 'Hungarian Grand Prix', country: 'HU' },
  'it-1922': { location: 'Monza', name: 'Autodromo Nazionale Monza', gp: 'Italian Grand Prix', country: 'IT' },
  'it-1953': { location: 'Imola', name: 'Autodromo Enzo e Dino Ferrari', gp: 'Emilia Romagna Grand Prix', country: 'IT' },
  'jp-1962': { location: 'Suzuka', name: 'Suzuka International Racing Course', gp: 'Japanese Grand Prix', country: 'JP' },
  'mc-1929': { location: 'Monaco', name: 'Circuit de Monaco', gp: 'Monaco Grand Prix', country: 'MC' },
  'mx-1962': { location: 'Mexico City', name: 'Autódromo Hermanos Rodríguez', gp: 'Mexican Grand Prix', country: 'MX' },
  'nl-1948': { location: 'Zandvoort', name: 'Circuit Zandvoort', gp: 'Dutch Grand Prix', country: 'NL' },
  'qa-2004': { location: 'Lusail', name: 'Losail International Circuit', gp: 'Qatar Grand Prix', country: 'QA' },
  'sa-2021': { location: 'Jeddah', name: 'Jeddah Corniche Circuit', gp: 'Saudi Arabian Grand Prix', country: 'SA' },
  'sg-2008': { location: 'Singapore', name: 'Marina Bay Street Circuit', gp: 'Singapore Grand Prix', country: 'SG' },
  'us-2012': { location: 'Austin', name: 'Circuit of the Americas', gp: 'United States Grand Prix', country: 'US' },
  'us-2022': { location: 'Miami', name: 'Miami International Autodrome', gp: 'Miami Grand Prix', country: 'US' },
  'us-2023': { location: 'Las Vegas', name: 'Las Vegas Street Circuit', gp: 'Las Vegas Grand Prix', country: 'US' },
  // Históricos disponibles (no en calendario vigente pero soportados para historicales)
  'ar-1952': { location: 'Buenos Aires', name: 'Autódromo Oscar y Juan Gálvez', gp: 'Argentine Grand Prix', country: 'AR', historical: true },
  'br-1977': { location: 'Jacarepaguá', name: 'Autódromo Internacional Nelson Piquet', gp: 'Brazilian Grand Prix', country: 'BR', historical: true },
  'de-1927': { location: 'Nürburg', name: 'Nürburgring', gp: 'German Grand Prix', country: 'DE', historical: true },
  'de-1932': { location: 'Hockenheim', name: 'Hockenheimring', gp: 'German Grand Prix', country: 'DE', historical: true },
  'fr-1960': { location: 'Magny-Cours', name: 'Circuit de Nevers Magny-Cours', gp: 'French Grand Prix', country: 'FR', historical: true },
  'fr-1969': { location: 'Le Castellet', name: 'Circuit Paul Ricard', gp: 'French Grand Prix', country: 'FR', historical: true },
  'it-1914': { location: 'Scarperia e San Piero', name: 'Autodromo Internazionale del Mugello', gp: 'Tuscan Grand Prix', country: 'IT', historical: true },
  'my-1999': { location: 'Sepang', name: 'Sepang International Circuit', gp: 'Malaysian Grand Prix', country: 'MY', historical: true },
  'pt-1972': { location: 'Estoril', name: 'Autódromo do Estoril', gp: 'Portuguese Grand Prix', country: 'PT', historical: true },
  'pt-2008': { location: 'Portimão', name: 'Autódromo Internacional do Algarve', gp: 'Portuguese Grand Prix', country: 'PT', historical: true },
  'ru-2014': { location: 'Sochi', name: 'Sochi Autodrom', gp: 'Russian Grand Prix', country: 'RU', historical: true },
  'tr-2005': { location: 'Istanbul', name: 'Intercity Istanbul Park', gp: 'Turkish Grand Prix', country: 'TR', historical: true },
  'us-1909': { location: 'Indianapolis', name: 'Indianapolis Motor Speedway', gp: 'United States Grand Prix', country: 'US', historical: true },
  'us-1956': { location: 'Watkins Glen', name: 'Watkins Glen International', gp: 'United States Grand Prix', country: 'US', historical: true },
  'za-1961': { location: 'Johannesburg', name: 'Kyalami Grand Prix Circuit', gp: 'South African Grand Prix', country: 'ZA', historical: true },
});

const _cache = new Map();

/**
 * Lista de circuitos disponibles. Default: solo activos (no historical).
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.includeHistorical=false] — incluir circuitos historicos.
 * @returns {Array<{ id, location, name, gp, country, historical? }>}
 */
function listCircuits(opts) {
  const includeHistorical = !!(opts && opts.includeHistorical);
  return Object.entries(CIRCUITS_MANIFEST)
    .filter(([, meta]) => includeHistorical || !meta.historical)
    .map(([id, meta]) => ({ id, ...meta }));
}

/**
 * Devuelve metadata de un circuito sin cargar el GeoJSON.
 *
 * @param {string} circuitId — ej. "mc-1929"
 * @returns {Object|null}
 */
function getCircuitMeta(circuitId) {
  const meta = CIRCUITS_MANIFEST[circuitId];
  if (!meta) return null;
  return { id: circuitId, ...meta };
}

/**
 * Resuelve un circuito por location humana (case-insensitive).
 * Útil para mapear el GP "Monaco" → "mc-1929".
 *
 * @param {string} locationOrCountry — "Monaco", "Suzuka", "JP", etc.
 * @returns {string|null} circuitId o null si no se encuentra
 */
function findCircuitId(locationOrCountry) {
  if (!locationOrCountry || typeof locationOrCountry !== 'string') return null;
  const needle = locationOrCountry.trim().toLowerCase();
  for (const [id, meta] of Object.entries(CIRCUITS_MANIFEST)) {
    if (meta.location.toLowerCase() === needle) return id;
    if (meta.country.toLowerCase() === needle) return id;
    if (meta.name.toLowerCase() === needle) return id;
  }
  return null;
}

/**
 * Carga el GeoJSON completo de un circuito desde filesystem.
 * Cachea en memoria — los GeoJSON no cambian.
 *
 * @param {string} circuitId — ej. "mc-1929"
 * @returns {Object|null} GeoJSON FeatureCollection o null si no existe
 */
function loadCircuit(circuitId) {
  if (!circuitId || typeof circuitId !== 'string') return null;
  if (_cache.has(circuitId)) return _cache.get(circuitId);
  if (!CIRCUITS_MANIFEST[circuitId]) return null;

  const filePath = path.join(CIRCUITS_DIR, circuitId + '.geojson');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    _cache.set(circuitId, parsed);
    return parsed;
  } catch (err) {
    /* istanbul ignore next — defensive: archivo presente per manifest pero fs falla */
    return null;
  }
}

/**
 * Extrae el bbox del GeoJSON: [minLon, minLat, maxLon, maxLat]
 *
 * @param {string} circuitId
 * @returns {Array<number>|null} [minLon, minLat, maxLon, maxLat]
 */
function getCircuitBBox(circuitId) {
  const data = loadCircuit(circuitId);
  if (!data) return null;
  if (Array.isArray(data.bbox) && data.bbox.length === 4) return data.bbox;
  /* istanbul ignore else — todos los GeoJSON bacinger incluyen bbox top-level */
  if (Array.isArray(data.features) && data.features[0] && Array.isArray(data.features[0].bbox)) {
    return data.features[0].bbox;
  }
  /* istanbul ignore next — defensive: feature sin bbox no debería ocurrir */
  return null;
}

/**
 * Extrae la lista de coordenadas [lon, lat] del trazado del circuito.
 *
 * @param {string} circuitId
 * @returns {Array<Array<number>>|null} array de [lon, lat]
 */
function getCircuitCoordinates(circuitId) {
  const data = loadCircuit(circuitId);
  if (!data) return null;
  /* istanbul ignore next — defensive: GeoJSON bacinger siempre tiene features[0] con geometry+coordinates LineString */
  const feature = (data.features || [])[0];
  /* istanbul ignore next */
  if (!feature || !feature.geometry) return null;
  /* istanbul ignore next */
  const coords = feature.geometry.coordinates;
  /* istanbul ignore next */
  if (!Array.isArray(coords)) return null;
  return coords;
}

/**
 * Limpia el cache (útil para tests).
 */
function _clearCache() {
  _cache.clear();
}

module.exports = {
  CIRCUITS_MANIFEST,
  CIRCUITS_DIR,
  listCircuits,
  getCircuitMeta,
  findCircuitId,
  loadCircuit,
  getCircuitBBox,
  getCircuitCoordinates,
  _clearCache,
};
