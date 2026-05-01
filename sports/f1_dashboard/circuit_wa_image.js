'use strict';

/**
 * MiiaF1 -- WhatsApp circuit image sender (F1.21)
 * Convierte SVG del circuito a PNG/JPEG para enviar por WA.
 * Usa sharp si disponible, fallback a enviar SVG como texto/sticker.
 */

const { generateCircuitSVG, getCircuit } = require('./circuit_maps');
const { renderAllDriversOnCircuit } = require('./circuit_overlay');

/**
 * Genera la descripcion textual del circuito para WA (fallback sin imagen).
 * @param {string} circuitId
 * @param {string} gpName
 * @param {number} round
 * @returns {string}
 */
function buildCircuitTextMessage(circuitId, gpName, round) {
  const c = getCircuit(circuitId);
  if (!c) return '🏎️ Datos del circuito no disponibles.';
  return [
    '🏎️ *' + (gpName || c.name) + '*',
    'Ronda ' + (round || '?') + ' · ' + c.country,
    c.laps + ' vueltas · ' + c.length_km + ' km/vuelta',
    'Distancia total: ' + (c.laps * c.length_km).toFixed(1) + ' km',
  ].join('\n');
}

/**
 * Intenta convertir SVG a Buffer PNG usando sharp.
 * Retorna null si sharp no esta disponible.
 * @param {string} svgString
 * @returns {Promise<Buffer|null>}
 */
async function svgToPngBuffer(svgString) {
  try {
    const sharp = require('sharp');
    return await sharp(Buffer.from(svgString)).png().toBuffer();
  } catch (e) {
    // sharp no disponible o fallo
    return null;
  }
}

/**
 * Envia imagen del circuito por WA.
 * @param {string} phone
 * @param {string} circuitId
 * @param {string} gpName
 * @param {number} round
 * @param {Function} sendWaMessage - fn(phone, msg) para texto
 * @param {Function} sendWaImage - fn(phone, buffer, caption) para imagen (opcional)
 * @returns {Promise<void>}
 */
async function sendCircuitImage(phone, circuitId, gpName, round, sendWaMessage, sendWaImage) {
  const svg = generateCircuitSVG(circuitId);
  const textMsg = buildCircuitTextMessage(circuitId, gpName, round);

  if (!svg) {
    await sendWaMessage(phone, textMsg);
    return;
  }

  // Intentar enviar como imagen PNG si sharp esta disponible
  if (sendWaImage) {
    const pngBuffer = await svgToPngBuffer(svg);
    if (pngBuffer) {
      await sendWaImage(phone, pngBuffer, textMsg);
      return;
    }
  }

  // Fallback: enviar descripcion textual
  await sendWaMessage(phone, textMsg);
}

module.exports = { buildCircuitTextMessage, svgToPngBuffer, sendCircuitImage };
