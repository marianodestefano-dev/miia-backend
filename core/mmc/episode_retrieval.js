'use strict';

/**
 * MMC Capa 4 — Retrieval de episodios destilados para construir contexto
 * de prompt MIIA. T77 Vi 2026-04-30.
 *
 * Origen: Piso 1 Edificio MIIA. Complemento de:
 *   - episodes.js (C-437): schema + CRUD
 *   - episode_detector.js (C-438): autoAssign open/close/rotate
 *   - episode_distiller.js (C-439): destilación nocturna semántica
 *
 * Este modulo es Capa 4: lee episodios distilled y los formatea para
 * inyectar como contexto en el system prompt de Gemini cuando MIIA
 * habla con un lead/cliente que ya tuvo conversaciones previas.
 *
 * IMPACTO USUARIO POST-WIRE-IN:
 *   - Lead vuelve después de 2 semanas. MIIA dice "hola Juan, la última
 *     vez hablamos de tu interés en el plan Pro para 5 médicos. ¿Pudiste
 *     revisarlo con tu equipo?"
 *   - En vez de "hola, ¿en qué te puedo ayudar?" como si fuera primera vez.
 *   - Lead siente que MIIA RECUERDA. Eso es Piso 1 user-visible.
 *
 * Wire-in en prompt_builder.buildOwnerLeadPrompt() requiere firma Mariano
 * (modificacion del prompt afecta voice DNA — toca §2-bis doctrina V2).
 * Modulo standalone hasta firma.
 *
 * Standard: Google + Amazon + NASA — async safe, fail-loud, zero PII leak.
 * Solo lee episodes con status='distilled' (topic + summary ya generados
 * por episode_distiller con safety filter aplicado).
 */

const episodes = require('./episodes');

const DEFAULT_MAX_EPISODES = 5;          // máximo retornar 5 episodios previos
const DEFAULT_MAX_AGE_DAYS = 90;         // ignorar episodios >90 días (ruido)
const DEFAULT_SUMMARY_TRUNCATE = 500;    // cap chars por summary en prompt

/**
 * Obtener resumen de episodios destilados para un contacto, ordenados
 * por recency (más reciente primero).
 *
 * @param {string} ownerUid
 * @param {string} contactPhone
 * @param {object} [options]
 * @param {number} [options.maxEpisodes=5]
 * @param {number} [options.maxAgeDays=90]
 * @returns {Promise<Array<{topic, summary, startedAt, endedAt, ageDays}>>}
 *   Array vacío si no hay episodios distilled (o todos viejos).
 *   Throws si Firestore falla.
 */
async function getRecentEpisodesSummary(ownerUid, contactPhone, options) {
  if (!ownerUid || typeof ownerUid !== 'string') {
    throw new Error('ownerUid required (string)');
  }
  if (!contactPhone || typeof contactPhone !== 'string') {
    throw new Error('contactPhone required (string)');
  }
  const opts = options || {};
  const maxEpisodes = typeof opts.maxEpisodes === 'number' && opts.maxEpisodes > 0
    ? opts.maxEpisodes : DEFAULT_MAX_EPISODES;
  const maxAgeDays = typeof opts.maxAgeDays === 'number' && opts.maxAgeDays > 0
    ? opts.maxAgeDays : DEFAULT_MAX_AGE_DAYS;

  const all = await episodes.listEpisodes(ownerUid, contactPhone, {
    status: 'distilled',
    limit: maxEpisodes * 2, // pedimos extra para filtrar por edad
  });

  const now = Date.now();
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;

  const fresh = [];
  for (const ep of all) {
    if (typeof ep.startedAt !== 'number') continue;
    if (ep.startedAt < cutoff) continue;
    if (!ep.topic && !ep.summary) continue; // sin contenido útil
    fresh.push({
      topic: ep.topic || '(sin topic)',
      summary: ep.summary || '(sin summary)',
      startedAt: ep.startedAt,
      endedAt: ep.endedAt || null,
      ageDays: Math.round((now - ep.startedAt) / (24 * 60 * 60 * 1000)),
    });
    if (fresh.length >= maxEpisodes) break;
  }
  return fresh;
}

/**
 * Formatea array de episodios para inyectar en el system prompt de Gemini.
 *
 * @param {Array} episodesArray - retorno de getRecentEpisodesSummary()
 * @param {object} [options]
 * @param {number} [options.summaryTruncate=500]
 * @param {string} [options.contactName] - nombre del contacto si conocido
 * @returns {string} bloque de texto listo para prompt, o '' si array vacio
 */
function formatForPrompt(episodesArray, options) {
  if (!Array.isArray(episodesArray) || episodesArray.length === 0) {
    return '';
  }
  const opts = options || {};
  const truncate = typeof opts.summaryTruncate === 'number' && opts.summaryTruncate > 0
    ? opts.summaryTruncate : DEFAULT_SUMMARY_TRUNCATE;
  const contactName = opts.contactName || 'el contacto';

  let out = `\n## 📚 MEMORIA EPISÓDICA — Conversaciones previas con ${contactName}\n`;
  out += `Lo siguiente es contexto de charlas anteriores. USALO para que el contacto sienta que lo recordás. NO menciones "ayer dijiste" textual — usá la info para personalizar tu respuesta natural.\n\n`;

  for (let i = 0; i < episodesArray.length; i++) {
    const ep = episodesArray[i];
    const ageStr = ep.ageDays === 0 ? 'hoy'
      : ep.ageDays === 1 ? 'ayer'
      : ep.ageDays < 7 ? `hace ${ep.ageDays} días`
      : ep.ageDays < 30 ? `hace ${Math.round(ep.ageDays / 7)} semana(s)`
      : `hace ${Math.round(ep.ageDays / 30)} mes(es)`;

    const summaryShort = ep.summary.length > truncate
      ? ep.summary.slice(0, truncate) + '...'
      : ep.summary;

    out += `**Episodio ${i + 1}** (${ageStr}) — Tema: ${ep.topic}\n`;
    out += `${summaryShort}\n\n`;
  }

  return out;
}

/**
 * Helper combinado: retrieve + format en una llamada.
 * Útil para wire-in en prompt_builder con menos boilerplate.
 *
 * @param {string} ownerUid
 * @param {string} contactPhone
 * @param {object} [options]
 * @returns {Promise<string>} bloque listo para prompt, o '' si sin episodios
 */
async function buildEpisodicContextBlock(ownerUid, contactPhone, options) {
  const eps = await getRecentEpisodesSummary(ownerUid, contactPhone, options);
  return formatForPrompt(eps, options);
}

module.exports = {
  getRecentEpisodesSummary,
  formatForPrompt,
  buildEpisodicContextBlock,
  DEFAULT_MAX_EPISODES,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_SUMMARY_TRUNCATE,
};
