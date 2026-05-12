'use strict';

/**
 * MMC.3 — Inyeccion de memoria episodica en prompt
 * buildMemoryContext(uid, phone) -> string | null
 * Max 3 hechos high-confidence recientes.
 */

const { getEpisodicMemory } = require('./episodic_memory');

const MAX_FACTS_INJECT = 3;

/**
 * Genera el string de contexto de memoria para inyectar en el system prompt.
 * @param {string} uid
 * @param {string} phone
 * @returns {Promise<string|null>} Context string, o null si no hay memoria relevante
 */
async function buildMemoryContext(uid, phone) {
  if (!uid || !phone) return null;
  var memory = null;
  try {
    memory = await getEpisodicMemory(uid, phone);
  } catch (e) {
    console.warn('[MMC3] Error leyendo memoria: ' + e.message);
    return null;
  }
  if (!memory || !Array.isArray(memory.key_facts) || memory.key_facts.length === 0) return null;

  var highFacts = memory.key_facts
    .filter(function(f) { return f && f.confidence === 'high' && f.fact; })
    .slice(-MAX_FACTS_INJECT);

  if (highFacts.length === 0) return null;

  return 'Sobre este contacto recuerdo: ' + highFacts.map(function(f) { return f.fact; }).join('. ') + '.';
}

module.exports = { buildMemoryContext, MAX_FACTS_INJECT };
