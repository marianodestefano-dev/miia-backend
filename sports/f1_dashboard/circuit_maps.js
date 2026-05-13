'use strict';

/**
 * MIIAF1 — Circuit maps con TRAZADOS REALES.
 *
 * VERSIÓN POST 2026-05-12 (firma Mariano "decido tu recomendacion!!!" + furia
 * "JAMAS yo firme... yo solo quiero poner la carrera en la TV, y abrir MIIAF1
 * y ver el circuito, los puntos de colores corriendo alrededor").
 *
 * REEMPLAZO COMPLETO de los SVGs garabateados a mano (sesión Wi 2026-05-01)
 * que Mariano descalificó al ver "Monaco" como un círculo con una S adentro.
 *
 * Ahora los trazados son COORDS REALES de github.com/bacinger/f1-circuits
 * (MIT license) en GeoJSON con bbox + LineString lat/lon. Se proyectan
 * dinámicamente al viewport SVG con `circuit_projection.js` manteniendo
 * el aspect ratio real del circuito.
 *
 * API pública mantiene retrocompatibilidad con los consumers existentes
 * (routes/f1.js, circuit_overlay.js, tests F1.17/F1.21/F1.22 + fase3/4):
 *   - CIRCUITS                  (object: id-legacy → metadata)
 *   - generateCircuitSVG(id, opts)
 *   - getCircuitIds()
 *   - getCircuit(id)
 *
 * IDs legacy ("monaco", "bahrain", ...) se mapean a fileIds reales
 * ("mc-1929", "bh-2002", ...) vía LEGACY_ID_TO_FILE.
 */

const { loadCircuit, getCircuitBBox, getCircuitCoordinates, listCircuits, getCircuitMeta } = require('./circuit_data');
const { projectPath, pointsToSvgPath, DEFAULT_VIEWPORT } = require('./circuit_projection');

// Mapping ID legacy (lo que los consumers existentes pasan) → fileId real GeoJSON.
const LEGACY_ID_TO_FILE = Object.freeze({
  australia: 'au-1953',
  bahrain: 'bh-2002',
  saudi: 'sa-2021',
  saudi_arabia: 'sa-2021',
  miami: 'us-2022',
  imola: 'it-1953',
  monaco: 'mc-1929',
  spain: 'es-1991',
  barcelona: 'es-1991',
  madrid: 'es-2026',
  canada: 'ca-1978',
  austria: 'at-1969',
  silverstone: 'gb-1948',
  britain: 'gb-1948',
  uk: 'gb-1948',
  hungary: 'hu-1986',
  belgium: 'be-1925',
  spa: 'be-1925',
  netherlands: 'nl-1948',
  zandvoort: 'nl-1948',
  monza: 'it-1922',
  italy: 'it-1922',
  azerbaijan: 'az-2016',
  baku: 'az-2016',
  singapore: 'sg-2008',
  japan: 'jp-1962',
  suzuka: 'jp-1962',
  qatar: 'qa-2004',
  usa: 'us-2012',
  austin: 'us-2012',
  cota: 'us-2012',
  mexico: 'mx-1962',
  brazil: 'br-1940',
  interlagos: 'br-1940',
  saopaulo: 'br-1940',
  lasvegas: 'us-2023',
  las_vegas: 'us-2023',
  abudhabi: 'ae-2009',
  abu_dhabi: 'ae-2009',
  yas: 'ae-2009',
  china: 'cn-2004',
  shanghai: 'cn-2004',
});

// Acceptable color por defecto (fallback) para circuitos no listados explícito.
const DEFAULT_TRACK_COLOR = '#00E5FF';

// Color por país (mantiene branding consistente; era hard-coded en versión legacy).
const COUNTRY_COLOR = Object.freeze({
  MC: '#E10600', // rojo F1 + clásico Mónaco
  BH: '#E10600',
  SA: '#00A86B',
  AU: '#00843D',
  CN: '#EE1C25',
  JP: '#BC002D',
  AZ: '#00A1DE',
  ES: '#FFC400',
  MX: '#006847',
  US: '#3C3B6E',
  IT: '#008C45',
  GB: '#012169',
  BE: '#FAE042',
  AT: '#ED2939',
  HU: '#436F4D',
  CA: '#FF0000',
  NL: '#21468B',
  SG: '#EF3340',
  QA: '#8D1B3D',
  BR: '#009C3B',
  AE: '#FF0000',
});

/**
 * Resuelve un input (legacy id, fileId, location, country) → fileId real.
 */
function resolveCircuitId(input) {
  if (!input || typeof input !== 'string') return null;
  const key = input.trim().toLowerCase();
  // Si es fileId directo (formato xx-YYYY)
  if (getCircuitMeta(input)) return input;
  if (LEGACY_ID_TO_FILE[key]) return LEGACY_ID_TO_FILE[key];
  // Underscore-normalized lookup
  const normalized = key.replace(/[\s-]+/g, '_');
  if (LEGACY_ID_TO_FILE[normalized]) return LEGACY_ID_TO_FILE[normalized];
  return null;
}

/**
 * Construye objeto compat con la API legacy CIRCUITS para un id dado.
 * Se calcula lazy (no se pre-carga toda la tabla) — solo cuando un consumer
 * accede a CIRCUITS[id] o llama getCircuit(id).
 *
 * @param {string} input — id legacy ("monaco") o fileId real ("mc-1929")
 * @returns {Object|null} { name, country, color, length_km, ... } o null
 */
function getCircuit(input) {
  const fileId = resolveCircuitId(input);
  if (!fileId) return null;
  const meta = getCircuitMeta(fileId);
  /* istanbul ignore next — defensive: resolveCircuitId solo retorna ids con meta */
  if (!meta) return null;
  const geo = loadCircuit(fileId);
  /* istanbul ignore next — defensive: manifest aligned con filesystem */
  if (!geo) return null;
  /* istanbul ignore next — defensive: GeoJSON bacinger siempre features[0] con properties */
  const feature = (geo.features || [])[0] || {};
  /* istanbul ignore next */
  const props = feature.properties || {};
  // Defensive: bacinger GeoJSON siempre tiene length/altitude/opened/firstgp.
  // Ramas falsy nunca se ejercen en runtime real → istanbul ignore else.
  let length_m = null;
  let length_km = null;
  /* istanbul ignore else — bacinger siempre length numérico */
  if (typeof props.length === 'number') {
    length_m = props.length;
    length_km = +(props.length / 1000).toFixed(3);
  }
  let altitude_m = null;
  /* istanbul ignore else */
  if (typeof props.altitude === 'number') altitude_m = props.altitude;
  let opened = null;
  /* istanbul ignore else */
  if (props.opened) opened = props.opened;
  let firstgp = null;
  /* istanbul ignore else */
  if (props.firstgp) firstgp = props.firstgp;
  return {
    id: fileId,
    name: meta.name,
    location: meta.location,
    country: meta.country,
    gp: meta.gp,
    color: COUNTRY_COLOR[meta.country] || DEFAULT_TRACK_COLOR,
    length_m,
    length_km,
    altitude_m,
    opened,
    firstgp,
  };
}

/**
 * Lista todos los IDs disponibles (incluyendo legacy aliases).
 *
 * @returns {Array<string>}
 */
function getCircuitIds() {
  // Legacy IDs primero (para no romper consumers que iteran), después fileIds.
  const legacy = Object.keys(LEGACY_ID_TO_FILE);
  const fileIds = listCircuits({ includeHistorical: false }).map((c) => c.id);
  return Array.from(new Set([...legacy, ...fileIds]));
}

/**
 * Genera SVG del circuito con trazado REAL proyectado al viewport.
 * Mantiene la API del legacy generateCircuitSVG(id, opts) donde:
 *   opts.driverPos: {x, y}  — posición de un driver para overlay (legacy single-driver)
 *   opts.driverName: string — nombre del driver (label en overlay)
 *   opts.teamColor: string  — color del dot
 *   opts.showLabel: bool    — mostrar label (default true)
 *   opts.viewport: { width, height, padding }  — viewport SVG (default 800x500)
 *
 * @param {string} circuitInput — legacy id o fileId
 * @param {Object} [opts]
 * @returns {string|null} SVG string o null si circuito no existe
 */
function generateCircuitSVG(circuitInput, opts) {
  opts = opts || {};
  const fileId = resolveCircuitId(circuitInput);
  if (!fileId) return null;

  const meta = getCircuitMeta(fileId);
  const bbox = getCircuitBBox(fileId);
  const coords = getCircuitCoordinates(fileId);
  /* istanbul ignore next — defensive: archivo presente pero corrupto */
  if (!meta || !bbox || !coords) return null;

  const viewport = opts.viewport || DEFAULT_VIEWPORT;
  const W = viewport.width || DEFAULT_VIEWPORT.width;
  const H = viewport.height || DEFAULT_VIEWPORT.height;

  const projected = projectPath(coords, bbox, viewport);
  const pathD = pointsToSvgPath(projected, true);

  const trackColor = COUNTRY_COLOR[meta.country] || DEFAULT_TRACK_COLOR;

  // Driver overlay (legacy single-driver compat)
  const teamColor = opts.teamColor || trackColor;
  const driverPos = opts.driverPos;
  const driverLabel = opts.showLabel !== false && opts.driverName ? opts.driverName : null;
  let driverOverlay = '';
  if (driverPos) {
    driverOverlay = '<circle cx="' + driverPos.x + '" cy="' + driverPos.y + '" r="8" fill="' + teamColor + '" opacity="0.9"/>';
    if (driverLabel) {
      driverOverlay += '<text x="' + (driverPos.x + 12) + '" y="' + (driverPos.y + 4) + '" fill="white" font-size="11" font-family="Inter,sans-serif" font-weight="600">' + driverLabel + '</text>';
    }
  }

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' +
    '<rect width="' + W + '" height="' + H + '" fill="#0A0A12"/>' +
    '<defs>' +
    '<linearGradient id="tg_' + fileId + '" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#00E5FF"/>' +
    '<stop offset="100%" stop-color="' + trackColor + '"/>' +
    '</linearGradient>' +
    '</defs>' +
    '<path d="' + pathD + '" fill="none" stroke="url(#tg_' + fileId + ')" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
    driverOverlay +
    '<text x="12" y="' + (H - 12) + '" fill="#ffffff66" font-size="11" font-family="Inter,sans-serif" font-weight="500">' + meta.name + ' — ' + meta.location + '</text>' +
    '</svg>'
  );
}

/**
 * CIRCUITS legacy compat: Proxy lazy que delega a getCircuit() al accederse.
 * Esto evita pre-cargar 40 GeoJSON en require-time + mantiene la API
 * CIRCUITS.monaco / CIRCUITS['mc-1929'] funcional.
 */
const CIRCUITS = new Proxy({}, {
  get(_target, prop) {
    if (typeof prop !== 'string') return undefined;
    return getCircuit(prop);
  },
  has(_target, prop) {
    return typeof prop === 'string' && getCircuit(prop) !== null;
  },
  ownKeys() {
    return getCircuitIds();
  },
  getOwnPropertyDescriptor(_target, prop) {
    const value = getCircuit(prop);
    if (!value) return undefined;
    return { enumerable: true, configurable: true, value };
  },
});

module.exports = {
  CIRCUITS,
  LEGACY_ID_TO_FILE,
  COUNTRY_COLOR,
  DEFAULT_TRACK_COLOR,
  generateCircuitSVG,
  getCircuitIds,
  getCircuit,
  resolveCircuitId,
};
