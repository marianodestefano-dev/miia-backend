'use strict';

/**
 * MiiaF1 -- Circuit position overlay (F1.18)
 * Interpola posicion del piloto sobre el SVG del circuito.
 * La posicion real del feed F1 viene en coordenadas X,Y normalizadas.
 */

const { generateCircuitSVG, getCircuit, CIRCUITS } = require('./circuit_maps');

/**
 * Convierte coordenadas X,Y del feed F1 (0-1 rango) a coordenadas SVG (400x300).
 * @param {number} normX - coordenada X normalizada (0..1)
 * @param {number} normY - coordenada Y normalizada (0..1)
 * @returns {{x: number, y: number}}
 */
function normToSVG(normX, normY) {
  return {
    x: Math.round(normX * 380 + 10),
    y: Math.round(normY * 280 + 10),
  };
}

/**
 * Genera SVG del circuito con el piloto en la posicion actual.
 * @param {string} circuitId
 * @param {object} driverData - { name, team_color, x, y } (x,y del live feed 0..1)
 * @returns {string|null}
 */
function renderDriverOnCircuit(circuitId, driverData) {
  if (!driverData) return generateCircuitSVG(circuitId);
  const svgPos = normToSVG(driverData.x || 0.5, driverData.y || 0.5);
  return generateCircuitSVG(circuitId, {
    driverPos: svgPos,
    driverName: driverData.name,
    teamColor: driverData.team_color || '#00E5FF',
    showLabel: true,
  });
}

/**
 * Genera SVG con todos los pilotos en sus posiciones actuales (top 5).
 * @param {string} circuitId
 * @param {object[]} driversData - array de { name, team_color, x, y, position }
 * @param {string} highlightDriverId - ID del piloto adoptado (resaltado)
 * @returns {string}
 */
function renderAllDriversOnCircuit(circuitId, driversData, highlightDriverId) {
  const c = getCircuit(circuitId);
  if (!c) return null;

  let overlays = '';
  const top5 = (driversData || []).slice(0, 5);

  for (const d of top5) {
    const svgPos = normToSVG(d.x || 0.5, d.y || 0.5);
    const isHighlight = d.driver_id === highlightDriverId;
    const r = isHighlight ? 10 : 6;
    const color = d.team_color || '#888';
    const opacity = isHighlight ? '1' : '0.7';
    overlays += '<circle cx="' + svgPos.x + '" cy="' + svgPos.y + '" r="' + r + '" fill="' + color + '" opacity="' + opacity + '"/>';
    if (isHighlight) {
      overlays += '<text x="' + (svgPos.x + 12) + '" y="' + (svgPos.y + 4) + '" fill="white" font-size="11" font-family="Inter,sans-serif" font-weight="700">' + d.name + '</text>';
    }
  }

  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">' +
    '<rect width="400" height="300" fill="#0A0A12"/>' +
    '<defs>' +
    '<linearGradient id="tg2" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#00E5FF"/>' +
    '<stop offset="100%" stop-color="' + c.color + '"/>' +
    '</linearGradient>' +
    '</defs>' +
    '<path d="' + c.path + '" fill="none" stroke="url(#tg2)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>' +
    overlays +
    '<text x="8" y="292" fill="#ffffff44" font-size="10" font-family="Inter,sans-serif">' + c.name + '</text>' +
    '</svg>';
}


/**
 * Calcula limites min/max de las coordenadas reales OpenF1.
 * @param {object[]} locationData - array de { x, y, driver_number, ... }
 * @returns {{ xMin, xMax, yMin, yMax }}
 */
function calcLocationBounds(locationData) {
  if (!locationData || locationData.length === 0) {
    return { xMin: -1000, xMax: 1000, yMin: -1000, yMax: 1000 };
  }
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const p of locationData) {
    if (p.x < xMin) xMin = p.x;
    if (p.x > xMax) xMax = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }
  return { xMin, xMax, yMin, yMax };
}

/**
 * Convierte coordenadas GPS reales de OpenF1 a coordenadas SVG (400x300).
 * @param {number} x - coordenada X real OpenF1
 * @param {number} y - coordenada Y real OpenF1
 * @param {{ xMin, xMax, yMin, yMax }} bounds
 * @returns {{ x: number, y: number }}
 */
function openF1ToSVG(x, y, bounds) {
  const rangeX = bounds.xMax - bounds.xMin || 1;
  const rangeY = bounds.yMax - bounds.yMin || 1;
  return {
    x: Math.round(((x - bounds.xMin) / rangeX) * 380 + 10),
    y: Math.round(((y - bounds.yMin) / rangeY) * 280 + 10),
  };
}

/**
 * Renderiza los pilotos sobre el circuito usando coords GPS reales de OpenF1.
 * Reemplaza la simulacion normToSVG del scraper original (MiiaF1.41).
 * @param {string} circuitId
 * @param {object[]} locationData - ultimas posiciones OpenF1 por piloto
 * @param {number|null} adoptedDriverNumber - driver_number del piloto adoptado
 * @returns {string|null}
 */
function renderDriversFromOpenF1(circuitId, locationData, adoptedDriverNumber) {
  const c = getCircuit(circuitId);
  if (!c) return null;

  const data = locationData || [];
  const bounds = calcLocationBounds(data);

  let overlays = '';
  const seen = new Set();
  for (const p of data) {
    if (seen.has(p.driver_number)) continue;
    seen.add(p.driver_number);
    const svgPos = openF1ToSVG(p.x, p.y, bounds);
    const isAdopted = p.driver_number === adoptedDriverNumber;
    const r = isAdopted ? 10 : 6;
    const color = p.team_colour || p.team_color || '#888';
    const opacity = isAdopted ? '1' : '0.7';
    overlays += '<circle cx="' + svgPos.x + '" cy="' + svgPos.y + '" r="' + r + '" fill="' + color + '" opacity="' + opacity + '"/>';
    if (isAdopted) {
      overlays += '<circle cx="' + svgPos.x + '" cy="' + svgPos.y + '" r="14" fill="none" stroke="#FFD700" stroke-width="2"/>';
      overlays += '<text x="' + (svgPos.x + 16) + '" y="' + (svgPos.y + 4) + '" fill="white" font-size="11" font-family="Inter,sans-serif" font-weight="700">' + (p.driver_acronym || p.driver_number) + '</text>';
    }
  }

  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">' +
    '<rect width="400" height="300" fill="#0A0A12"/>' +
    '<defs>' +
    '<linearGradient id="tg2" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#00E5FF"/>' +
    '<stop offset="100%" stop-color="' + c.color + '"/>' +
    '</linearGradient>' +
    '</defs>' +
    '<path d="' + c.path + '" fill="none" stroke="url(#tg2)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>' +
    overlays +
    '<text x="8" y="292" fill="#ffffff44" font-size="10" font-family="Inter,sans-serif">' + c.name + '</text>' +
    '</svg>';
}

module.exports = { normToSVG, renderDriverOnCircuit, renderAllDriversOnCircuit, calcLocationBounds, openF1ToSVG, renderDriversFromOpenF1 };
