'use strict';

/**
 * circuit_live_renderer.js — Renderer SVG live con dots multi-driver.
 *
 * Firma Mariano 2026-05-12 ~22:30 COT:
 *   "yo solo quiero poner la carrera en la TV, y abrir MIIAF1 y ver el circuito,
 *    los puntos de colores corriendo alrededor, los tiempos de cada corredor"
 *
 * Genera el SVG del circuito (trazado REAL bacinger/f1-circuits) + un dot por
 * cada piloto en su posición actual (de OpenF1 /location endpoint). Cada dot
 * tiene:
 *   - color del equipo (data + visual)
 *   - radio configurable
 *   - data-driver-number (para tooltip click en frontend)
 *   - data-driver-name + data-team (para tooltip)
 *
 * El frontend escucha click en cada `<circle data-driver-number="...">` y
 * muestra tooltip con nombre + equipo + posición + tiempo última vuelta.
 *
 * Update strategy: backend devuelve nuevo SVG cada 1-2s durante carrera.
 * Frontend reemplaza inner del SVG container (no flicker porque dots
 * sólo cambian coordenadas).
 */

const { loadCircuit, getCircuitBBox, getCircuitCoordinates, getCircuitMeta } = require('./circuit_data');
const { projectPath, projectPoint, pointsToSvgPath, DEFAULT_VIEWPORT } = require('./circuit_projection');
const { resolveCircuitId, COUNTRY_COLOR, DEFAULT_TRACK_COLOR } = require('./circuit_maps');

const DEFAULT_DOT_RADIUS = 7;
const DEFAULT_LABEL_OFFSET = 14;

/**
 * Renderiza el SVG del circuito + dots de cada driver.
 *
 * @param {Object} args
 *   - circuitId: string  — legacy id ("monaco") o fileId real ("mc-1929")
 *   - drivers: Array<{
 *       driver_number: number|string,
 *       lat: number,
 *       lon: number,
 *       team_color?: string,
 *       driver_name?: string,
 *       team_name?: string,
 *       is_adopted?: boolean,
 *     }>
 *   - viewport?: { width, height, padding }
 *   - showLabels?: boolean (default false — labels saturan; tooltip click es preferible)
 *   - highlightAdopted?: boolean (default true — anillo extra al piloto adoptado)
 *
 * @returns {string|null} SVG string o null si circuito no resoluble
 */
function renderLiveCircuit(args) {
  const a = args || {};
  const fileId = resolveCircuitId(a.circuitId);
  if (!fileId) return null;

  const meta = getCircuitMeta(fileId);
  const bbox = getCircuitBBox(fileId);
  const coords = getCircuitCoordinates(fileId);
  /* istanbul ignore next — defensive */
  if (!meta || !bbox || !coords) return null;

  const viewport = a.viewport || DEFAULT_VIEWPORT;
  const W = viewport.width || DEFAULT_VIEWPORT.width;
  const H = viewport.height || DEFAULT_VIEWPORT.height;

  const projectedTrack = projectPath(coords, bbox, viewport);
  const trackPath = pointsToSvgPath(projectedTrack, true);
  const trackColor = COUNTRY_COLOR[meta.country] || DEFAULT_TRACK_COLOR;

  const drivers = Array.isArray(a.drivers) ? a.drivers : [];
  const showLabels = !!a.showLabels;
  const highlightAdopted = a.highlightAdopted !== false;

  const dotsSvg = drivers
    .map((d) => _renderDriverDot(d, bbox, viewport, showLabels, highlightAdopted))
    .filter((s) => !!s)
    .join('');

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" ' +
    'width="' + W + '" height="' + H + '" class="miiaf1-live-circuit" data-circuit-id="' + fileId + '">' +
    '<rect width="' + W + '" height="' + H + '" fill="#0A0A12"/>' +
    '<defs>' +
    '<linearGradient id="lg_' + fileId + '" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#00E5FF" stop-opacity="0.6"/>' +
    '<stop offset="100%" stop-color="' + trackColor + '" stop-opacity="0.7"/>' +
    '</linearGradient>' +
    '</defs>' +
    '<path d="' + trackPath + '" fill="none" stroke="url(#lg_' + fileId + ')" ' +
    'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>' +
    dotsSvg +
    '<text x="12" y="' + (H - 12) + '" fill="#ffffff77" font-size="11" ' +
    'font-family="Inter,sans-serif">' + meta.name + ' — ' + meta.location + '</text>' +
    '</svg>'
  );
}

/**
 * Renderiza un dot individual de driver. Helper interno.
 *
 * @param {Object} driver
 * @param {Array<number>} bbox
 * @param {Object} viewport
 * @param {boolean} showLabels
 * @param {boolean} highlightAdopted
 * @returns {string} SVG fragment para este driver (vacío si invalid)
 */
function _renderDriverDot(driver, bbox, viewport, showLabels, highlightAdopted) {
  if (!driver || typeof driver !== 'object') return '';
  if (typeof driver.lat !== 'number' || typeof driver.lon !== 'number') return '';

  const { x, y } = projectPoint(driver.lon, driver.lat, bbox, viewport);
  const color = driver.team_color || '#FFFFFF';
  const driverNum = driver.driver_number != null ? String(driver.driver_number) : '';
  const driverName = driver.driver_name || '';
  const teamName = driver.team_name || '';
  const radius = DEFAULT_DOT_RADIUS;

  // Atributos data-* para tooltip click en frontend (Mariano firma "que me
  // indique quien es" al clickear un punto de color).
  const dataAttrs =
    'data-driver-number="' + _escapeAttr(driverNum) + '" ' +
    'data-driver-name="' + _escapeAttr(driverName) + '" ' +
    'data-team-name="' + _escapeAttr(teamName) + '" ' +
    'data-team-color="' + _escapeAttr(color) + '"';

  // Halo del piloto adoptado (anillo brillante extra).
  let halo = '';
  if (highlightAdopted && driver.is_adopted === true) {
    halo =
      '<circle cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="' +
      (radius + 4) + '" fill="none" stroke="' + color + '" stroke-width="1.5" ' +
      'opacity="0.55"/>';
  }

  const dot =
    '<circle class="miiaf1-driver-dot" cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="' +
    radius + '" fill="' + color + '" stroke="white" stroke-width="1.2" ' +
    'opacity="0.95" ' + dataAttrs + ' style="cursor:pointer">' +
    '<title>' + _escapeText(driverName || driverNum || '?') +
    (teamName ? ' — ' + _escapeText(teamName) : '') + '</title>' +
    '</circle>';

  let label = '';
  if (showLabels && (driverNum || driverName)) {
    const text = driverNum || driverName;
    label =
      '<text x="' + (x + DEFAULT_LABEL_OFFSET).toFixed(2) + '" y="' +
      (y + 4).toFixed(2) + '" fill="white" font-size="10" ' +
      'font-family="Inter,sans-serif" font-weight="600" pointer-events="none">' +
      _escapeText(text) + '</text>';
  }

  return halo + dot + label;
}

function _escapeAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function _escapeText(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = {
  DEFAULT_DOT_RADIUS,
  DEFAULT_LABEL_OFFSET,
  renderLiveCircuit,
  _renderDriverDot,
  _escapeAttr,
  _escapeText,
};
