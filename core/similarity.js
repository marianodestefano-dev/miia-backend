'use strict';

/**
 * MIIA — Similarity (T95 §6.21 fix)
 * similarityRatio(a, b): Jaccard por palabras — liviano para produccion.
 * Retorna 0.0-1.0. 1.0 = identicos, 0.0 = sin palabras en comun.
 */

/**
 * Normaliza texto: minusculas, strip puntuacion, split por espacios.
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return new Set();
  const words = text.toLowerCase().replace(/[^a-z0-9à-ÿ\s]/g, ' ').split(/\s+/).filter(Boolean);
  return new Set(words);
}

/**
 * Similaridad Jaccard entre dos textos por palabras.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0.0-1.0
 */
function similarityRatio(a, b) {
  if (!a && !b) return 1.0;
  if (!a || !b) return 0.0;
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

module.exports = { similarityRatio, tokenize };
