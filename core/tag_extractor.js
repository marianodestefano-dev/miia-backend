'use strict';

/**
 * MIIA — Tag Extractor (T135)
 * Extrae tags de accion de respuestas del LLM.
 * Soporta: AGENDAR_EVENTO, SOLICITAR_TURNO, CANCELAR_EVENTO, MOVER_EVENTO,
 *          GENERAR_COTIZACION, RECORDATORIO, APRENDER.
 */

const TAG_PATTERNS = Object.freeze({
  AGENDAR_EVENTO: /\[AGENDAR_EVENTO:([^\]]+)\]/g,
  SOLICITAR_TURNO: /\[SOLICITAR_TURNO:([^\]]+)\]/g,
  CANCELAR_EVENTO: /\[CANCELAR_EVENTO:([^\]]+)\]/g,
  MOVER_EVENTO: /\[MOVER_EVENTO:([^\]]+)\]/g,
  GENERAR_COTIZACION: /\[GENERAR_COTIZACION:\{([^}]+)\}\]/g,
  RECORDATORIO: /\[RECORDATORIO:([^\]]+)\]/g,
  APRENDER: /\[APRENDER:([^\]]*)\]/g,
});

const VALID_TAGS = Object.freeze(Object.keys(TAG_PATTERNS));

/**
 * Extrae todos los tags de un texto.
 * @param {string} text
 * @returns {{ tags: Array<{ type, payload, raw }>, clean: string }}
 */
function extractTags(text) {
  if (!text || typeof text !== 'string') {
    return { tags: [], clean: text || '' };
  }

  const tags = [];
  let clean = text;

  for (const [tagType, pattern] of Object.entries(TAG_PATTERNS)) {
    pattern.lastIndex = 0; // reset regex state
    let match;
    while ((match = pattern.exec(text)) !== null) {
      tags.push({
        type: tagType,
        payload: match[1].trim(),
        raw: match[0],
      });
    }
    // Limpiar del texto
    pattern.lastIndex = 0;
    clean = clean.replace(new RegExp(pattern.source, 'g'), '').trim();
  }

  return { tags, clean };
}

/**
 * Extrae tags de un tipo especifico.
 */
function extractTagsOfType(text, tagType) {
  if (!VALID_TAGS.includes(tagType)) throw new Error(`tagType invalido: ${tagType}`);
  const { tags } = extractTags(text);
  return tags.filter(t => t.type === tagType);
}

/**
 * Verifica si un texto contiene algun tag.
 */
function hasTags(text) {
  if (!text) return false;
  return VALID_TAGS.some(tag => TAG_PATTERNS[tag].test((TAG_PATTERNS[tag].lastIndex = 0, text)));
}

/**
 * Limpia todos los tags de un texto.
 */
function stripTags(text) {
  return extractTags(text).clean;
}

module.exports = { extractTags, extractTagsOfType, hasTags, stripTags, TAG_PATTERNS, VALID_TAGS };
