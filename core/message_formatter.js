'use strict';

/**
 * MIIA — Message Formatter (T132)
 * Formatea mensajes: reemplaza variables, limita longitud, split inteligente.
 */

const MAX_SINGLE_MESSAGE = 4000;
const SPLIT_THRESHOLD = 1600;    // si supera esto, se parte
const SPLIT_TARGET = 1500;       // tamaño objetivo por parte
const ELLIPSIS = '...';

/**
 * Reemplaza variables {{nombre}} en un template con valores del contexto.
 * Variables no encontradas se dejan como string vacio.
 * @param {string} template
 * @param {object} context
 * @returns {string}
 */
function applyVariables(template, context = {}) {
  if (!template || typeof template !== 'string') return '';
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = context[key];
    return val !== undefined && val !== null ? String(val) : '';
  });
}

/**
 * Trunca un mensaje al maximo permitido con indicador de truncado.
 */
function truncate(text, maxLength = MAX_SINGLE_MESSAGE) {
  if (!text || typeof text !== 'string') return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - ELLIPSIS.length) + ELLIPSIS;
}

/**
 * Divide un mensaje largo en partes respetando saltos de linea y oraciones.
 * @param {string} text
 * @param {number} [targetSize]
 * @returns {string[]}
 */
function splitMessage(text, targetSize = SPLIT_TARGET) {
  if (!text || typeof text !== 'string') return [];
  if (text.length <= SPLIT_THRESHOLD) return [text];

  const parts = [];
  let remaining = text;

  while (remaining.length > targetSize) {
    let splitAt = targetSize;

    // Buscar ultimo salto de parrafo antes del target
    const paraBreak = remaining.lastIndexOf('\n\n', splitAt);
    if (paraBreak > targetSize * 0.5) {
      splitAt = paraBreak + 2;
    } else {
      // Buscar ultimo salto de linea
      const lineBreak = remaining.lastIndexOf('\n', splitAt);
      if (lineBreak > targetSize * 0.5) {
        splitAt = lineBreak + 1;
      } else {
        // Buscar ultimo espacio
        const spaceBreak = remaining.lastIndexOf(' ', splitAt);
        if (spaceBreak > targetSize * 0.5) {
          splitAt = spaceBreak + 1;
        }
      }
    }

    parts.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

/**
 * Formatea un mensaje completo: aplica variables, trunca, y divide si es necesario.
 * @param {string} template
 * @param {object} context
 * @param {{ maxLength?, splitThreshold? }} opts
 * @returns {{ parts: string[], wasTruncated: boolean, wasSplit: boolean }}
 */
function formatMessage(template, context = {}, opts = {}) {
  if (!template || typeof template !== 'string') {
    return { parts: [], wasTruncated: false, wasSplit: false };
  }

  const maxLength = opts.maxLength || MAX_SINGLE_MESSAGE;
  const text = applyVariables(template, context);
  const truncated = text.length > maxLength;
  const finalText = truncated ? truncate(text, maxLength) : text;
  const parts = splitMessage(finalText, opts.splitTarget || SPLIT_TARGET);

  return {
    parts,
    wasTruncated: truncated,
    wasSplit: parts.length > 1,
  };
}

module.exports = {
  applyVariables,
  truncate,
  splitMessage,
  formatMessage,
  MAX_SINGLE_MESSAGE,
  SPLIT_THRESHOLD,
  SPLIT_TARGET,
};
