'use strict';

/**
 * MMC — mod_tonada() (spec 13 v0.3 §Inyeccion mod_tonada).
 *
 * Genera la directiva de tonada para inyectar en el prompt cuando el owner
 * tiene una tonada regional detectada con confidence>=medium.
 *
 * NO toca prompt_builder.js todavia. Wire-in requiere firma Mariano
 * (afecta voice DNA, doctrina §2-bis). Modulo standalone hasta firma.
 *
 * Reglas:
 *   - chatType in [lead, miia_lead, client] -> '' (no aplica)
 *   - baseline.bootstrapComplete=false -> ''
 *   - baseline.adaptacionActiva=false -> ''
 *   - baseline.tonadaRegional='neutro' -> ''
 *   - Sino: emite directiva por tonada
 */

const baselineLib = require('./baseline');

const NON_OWNER_CHAT_TYPES = new Set(['lead', 'miia_lead', 'client']);

const DIRECTIVAS = Object.freeze({
  argentina: 'Hablá con vos (voseo). Usá "che", "dale", "bondi", "laburo" con naturalidad. Nada forzado.',
  colombia:  'Usá "parcero", "chévere", "bacano", "listo". Tono cálido y cercano.',
  mexico:    'Usá "órale", "chido", "ahorita", "neta". Tuteo. Tono relajado.',
});

/**
 * Genera la directiva de tonada para inyectar.
 * @param {object} opts - { uid, chatType }
 * @returns {Promise<string>} string para inyectar, '' si no aplica
 */
async function buildTonadaDirective(opts) {
  const o = opts || {};
  if (!o.uid) return '';
  if (NON_OWNER_CHAT_TYPES.has(o.chatType)) return '';
  const baseline = await baselineLib.getBaseline(o.uid);
  if (!baseline) return '';
  if (!baseline.bootstrapComplete) return '';
  if (!baseline.adaptacionActiva) return '';
  if (baseline.tonadaRegional === 'neutro') return '';
  const directiva = DIRECTIVAS[baseline.tonadaRegional];
  if (!directiva) return '';
  return '\n## TONADA\n' + directiva + '\n';
}

/**
 * Genera el bloque CADENCIAS PREVIAS (spec 13 §Inyeccion mod_memory) a partir
 * de un array de items {fecha, lessonText}. Devuelve '' si vacio.
 *
 * Helper de formato puro (no consulta Firestore). El retrieval real con
 * embedding va en B.6.
 *
 * @param {Array<{fecha?: string, lessonText: string}>} items - top 3
 * @returns {string}
 */
function formatCadenciasBlock(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lines = items.map(function (x) {
    const fecha = typeof x.fecha === 'string' && x.fecha.length > 0
      ? ' (' + x.fecha.slice(0, 10) + ')'
      : '';
    return '📝 Recordás: ' + String(x.lessonText || '').slice(0, 200) + fecha;
  });
  return '\n## CADENCIAS PREVIAS\n' + lines.join('\n') + '\n';
}

module.exports = {
  buildTonadaDirective,
  formatCadenciasBlock,
  DIRECTIVAS,
  NON_OWNER_CHAT_TYPES,
};
