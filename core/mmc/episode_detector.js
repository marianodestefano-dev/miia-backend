/**
 * MMC Capa 2 — Detección automática de episodios.
 *
 * Origen: CARTA_C-438 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27]
 *   Cita Mariano: "Si ambos estan de acuerdo, no requieres preguntarme!!! A"
 *
 * Segunda tanda Piso 1. Lógica detección + helpers SIN tocar TMH.
 * Wire-in real va C-440 (etapa 1 doctrina §2-bis: probar primero MIIA CENTER).
 *
 * Heurística:
 *  - Episodio "open" reciente (delta < threshold idle) → continuar (append).
 *  - Episodio "open" viejo (delta >= threshold idle) → cerrar + nuevo episodio.
 *  - Sin episodio "open" → nuevo episodio.
 *
 * Dependencias: core/mmc/episodes.js (C-437 commit 33aac39).
 */

'use strict';

const episodes = require('./episodes');

const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min

/**
 * Decide si un mensaje nuevo abre episodio nuevo o continúa el existente.
 *
 * @param {string} ownerUid
 * @param {string} contactPhone
 * @param {number} messageTimestamp millis
 * @param {object} [options] { idleThresholdMs?: number }
 * @returns {Promise<{action: 'new_episode'} | {action: 'continue', episodeId: string} | {action: 'rotate', closeEpisodeId: string}>}
 *   - 'new_episode': no hay episodio open, hay que crear uno.
 *   - 'continue' + episodeId: append al episodio existente.
 *   - 'rotate' + closeEpisodeId: cerrar el viejo, después crear nuevo.
 *
 * Esta función NO escribe a Firestore — solo decide. La acción real
 * la ejecuta autoAssignMessageToEpisode() o el caller.
 */
async function detectEpisodeStart(ownerUid, contactPhone, messageTimestamp, options) {
  if (typeof messageTimestamp !== 'number') {
    throw new Error('messageTimestamp debe ser number (millis)');
  }
  const opts = options || {};
  const threshold = typeof opts.idleThresholdMs === 'number'
    ? opts.idleThresholdMs
    : DEFAULT_IDLE_THRESHOLD_MS;

  const openList = await episodes.listEpisodes(ownerUid, contactPhone, {
    status: 'open',
    limit: 1,
  });

  if (openList.length === 0) {
    return { action: 'new_episode' };
  }

  const open = openList[0];
  const lastTs = _lastActivityTimestamp(open);
  const delta = messageTimestamp - lastTs;

  if (delta < threshold) {
    return { action: 'continue', episodeId: open.episodeId };
  }
  return { action: 'rotate', closeEpisodeId: open.episodeId };
}

/**
 * Determina si un episodio open debería cerrarse por idle.
 *
 * Útil para barridos periódicos (cron de cierre auto, post-C-438).
 *
 * @param {object} episodeData
 * @param {number} currentTimestamp millis
 * @param {object} [options] { idleThresholdMs?: number }
 * @returns {boolean}
 */
function shouldCloseEpisode(episodeData, currentTimestamp, options) {
  if (!episodeData || typeof episodeData !== 'object') {
    return false;
  }
  if (episodeData.status !== 'open') {
    return false;
  }
  if (!Array.isArray(episodeData.messageIds) || episodeData.messageIds.length === 0) {
    return false;
  }
  if (typeof currentTimestamp !== 'number') {
    return false;
  }
  const opts = options || {};
  const threshold = typeof opts.idleThresholdMs === 'number'
    ? opts.idleThresholdMs
    : DEFAULT_IDLE_THRESHOLD_MS;
  const lastTs = _lastActivityTimestamp(episodeData);
  return (currentTimestamp - lastTs) > threshold;
}

/**
 * Pipeline auto: detecta + ejecuta acción correspondiente en 1 llamada.
 *
 * Combina detectEpisodeStart + close/create/append. Para uso futuro
 * en wire-in TMH (C-440). Devuelve { episodeId, action } final.
 *
 * @param {string} ownerUid
 * @param {string} contactPhone
 * @param {string} messageId
 * @param {number} timestamp millis
 * @param {object} [options]
 * @returns {Promise<{episodeId: string, action: 'created' | 'appended' | 'rotated'}>}
 */
async function autoAssignMessageToEpisode(ownerUid, contactPhone, messageId, timestamp, options) {
  if (typeof messageId !== 'string' || messageId.length === 0) {
    throw new Error('messageId requerido');
  }
  const decision = await detectEpisodeStart(ownerUid, contactPhone, timestamp, options);

  if (decision.action === 'new_episode') {
    const newId = await episodes.createEpisode(ownerUid, contactPhone, messageId);
    return { episodeId: newId, action: 'created' };
  }

  if (decision.action === 'continue') {
    await episodes.addMessageToEpisode(ownerUid, decision.episodeId, messageId);
    return { episodeId: decision.episodeId, action: 'appended' };
  }

  // rotate: cerrar viejo + crear nuevo
  await episodes.closeEpisode(ownerUid, decision.closeEpisodeId, timestamp);
  const newId = await episodes.createEpisode(ownerUid, contactPhone, messageId);
  return { episodeId: newId, action: 'rotated' };
}

/**
 * Timestamp de la última actividad del episodio. Si messageIds tiene
 * entries pero no rastreamos timestamps por mensaje (schema C-437),
 * usamos startedAt como aproximación segura. Cuando C-440 wire-in TMH
 * agregue timestamp por messageId, refinar.
 *
 * @private
 */
function _lastActivityTimestamp(episodeData) {
  // schema C-437: startedAt + endedAt. No tracking timestamp por messageId.
  // Heurística conservadora: usar startedAt (el episodio queda "open" desde
  // ahí hasta que llegue otro mensaje o cierre).
  return episodeData.startedAt || 0;
}

module.exports = {
  detectEpisodeStart,
  shouldCloseEpisode,
  autoAssignMessageToEpisode,
  DEFAULT_IDLE_THRESHOLD_MS,
  // export _lastActivityTimestamp para tests
  _lastActivityTimestamp,
};
