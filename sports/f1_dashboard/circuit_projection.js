'use strict';

/**
 * circuit_projection.js — Proyección lat/lon → SVG viewport (firma Mariano 2026-05-12).
 *
 * Convierte coordenadas geográficas reales (de bacinger/f1-circuits GeoJSON)
 * a coordenadas SVG dentro de un viewport rectangular con padding.
 *
 * Proyección: equirectangular simple normalizada al bbox del circuito.
 *   - Inversión Y porque SVG tiene Y descendente vs lat ascendente.
 *   - Padding configurable para que el trazado no toque los bordes.
 *
 * NO compensa la distorsión de Mercator (no necesario en escala de circuito
 * F1 — error < 0.1% en track de pocos km).
 */

const DEFAULT_VIEWPORT = { width: 800, height: 500, padding: 30 };

/**
 * Proyecta una coordenada lat/lon al sistema SVG dentro del viewport.
 *
 * @param {number} lon
 * @param {number} lat
 * @param {Array<number>} bbox — [minLon, minLat, maxLon, maxLat]
 * @param {Object} [viewport] — { width, height, padding }
 * @returns {{ x: number, y: number }}
 */
function projectPoint(lon, lat, bbox, viewport) {
  const vp = viewport || DEFAULT_VIEWPORT;
  const W = vp.width || DEFAULT_VIEWPORT.width;
  const H = vp.height || DEFAULT_VIEWPORT.height;
  const P = typeof vp.padding === 'number' ? vp.padding : DEFAULT_VIEWPORT.padding;

  const [minLon, minLat, maxLon, maxLat] = bbox;
  const dLon = maxLon - minLon || 1; // evitar div/0 si bbox degenerado
  const dLat = maxLat - minLat || 1;

  // Mantener aspect ratio del circuito real:
  // - Si dLat/dLon > viewport ratio → escalar por lat (fit vertical), bandas a los lados.
  // - Si dLat/dLon < viewport ratio → escalar por lon (fit horizontal), bandas arriba/abajo.
  const innerW = W - 2 * P;
  const innerH = H - 2 * P;
  const aspectCircuit = dLon / dLat;
  const aspectViewport = innerW / innerH;

  let scale;
  let offsetX = 0;
  let offsetY = 0;
  if (aspectCircuit > aspectViewport) {
    // circuito más ancho que el viewport → fit por ancho
    scale = innerW / dLon;
    const fitH = dLat * scale;
    offsetY = (innerH - fitH) / 2;
  } else {
    // circuito más alto que el viewport → fit por alto
    scale = innerH / dLat;
    const fitW = dLon * scale;
    offsetX = (innerW - fitW) / 2;
  }

  // Lon → X (creciente derecha).
  const x = P + offsetX + (lon - minLon) * scale;
  // Lat → Y (invertida: lat mayor = arriba; SVG Y mayor = abajo).
  const y = P + offsetY + (maxLat - lat) * scale;

  return { x, y };
}

/**
 * Proyecta un array de coordenadas [lon, lat] a array de {x, y} SVG.
 *
 * @param {Array<Array<number>>} coords — GeoJSON LineString coordinates
 * @param {Array<number>} bbox
 * @param {Object} [viewport]
 * @returns {Array<{x, y}>}
 */
function projectPath(coords, bbox, viewport) {
  if (!Array.isArray(coords)) return [];
  return coords.map(function (c) {
    return projectPoint(c[0], c[1], bbox, viewport);
  });
}

/**
 * Convierte un array de {x, y} en un atributo `d` de SVG path.
 *
 * @param {Array<{x, y}>} points
 * @param {boolean} [closePath=true] — true: agrega "Z" al final (circuito cerrado)
 * @returns {string} SVG path d attribute (ej. "M 100 200 L 110 205 Z")
 */
function pointsToSvgPath(points, closePath) {
  if (!Array.isArray(points) || points.length === 0) return '';
  const close = closePath !== false;
  const parts = points.map(function (p, i) {
    const cmd = i === 0 ? 'M' : 'L';
    return cmd + ' ' + p.x.toFixed(2) + ' ' + p.y.toFixed(2);
  });
  if (close) parts.push('Z');
  return parts.join(' ');
}

module.exports = {
  DEFAULT_VIEWPORT,
  projectPoint,
  projectPath,
  pointsToSvgPath,
};
