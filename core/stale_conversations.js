'use strict';

/**
 * PB.5 — Limpieza de conversaciones stale
 * cleanStaleConversations(conversations, olderThanDays=30)
 * Elimina entradas donde lastActivity < now - threshold.
 */

function _toTimestamp(val) {
  if (typeof val === 'number') return val;
  if (val instanceof Date) return val.getTime();
  if (val) return new Date(val).getTime();
  return 0;
}

/**
 * @param {Object} conversations  - Mapa { phone: { lastActivity, ... } } (mutado in-place)
 * @param {number} [olderThanDays=30]
 * @returns {number} Cantidad eliminada
 */
function cleanStaleConversations(conversations, olderThanDays) {
  if (olderThanDays === undefined) olderThanDays = 30;
  const cutoff = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
  let removed = 0;
  for (const phone of Object.keys(conversations)) {
    const data = conversations[phone] || {};
    const ts = _toTimestamp(data.lastActivity || data.updatedAt || 0);
    if (ts < cutoff) {
      delete conversations[phone];
      removed++;
    }
  }
  console.log('[CLEANUP] ' + removed + ' contactos stale eliminados (threshold: ' + olderThanDays + 'd)');
  return removed;
}

module.exports = { cleanStaleConversations };
