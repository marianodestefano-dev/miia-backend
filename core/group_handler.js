'use strict';

/**
 * MIIA — Group Handler (T145)
 * Detecta si un mensaje viene de un grupo y aplica logica condicional.
 * MIIA solo responde en grupos si es mencionada o si el owner la invoca.
 */

const GROUP_JID_SUFFIX = '@g.us';
const MIIA_TRIGGER_WORDS = Object.freeze(['miia', 'hola miia', 'chau miia']);
const MIN_MENTION_LENGTH = 4;

/**
 * Determina si un JID es de grupo.
 */
function isGroupJid(jid) {
  if (!jid || typeof jid !== 'string') return false;
  return jid.endsWith(GROUP_JID_SUFFIX);
}

/**
 * Determina si el mensaje menciona a MIIA.
 * @param {string} text
 * @param {string[]} [mentionedJids] - JIDs de los mencionados en el mensaje
 * @param {string} [miiaJid] - JID de MIIA en este contexto
 * @returns {boolean}
 */
function isMentioned(text, mentionedJids = [], miiaJid = null) {
  if (!text && (!mentionedJids || mentionedJids.length === 0)) return false;

  // Chequear mención por JID
  if (miiaJid && mentionedJids.includes(miiaJid)) return true;

  // Chequear mención por trigger word
  if (text) {
    const lower = text.toLowerCase().trim();
    return MIIA_TRIGGER_WORDS.some(trigger => lower.includes(trigger));
  }

  return false;
}

/**
 * Determina si MIIA debe responder a un mensaje de grupo.
 * @param {{ isGroup, text, mentionedJids, miiaJid, isFromOwner }} ctx
 * @returns {{ shouldRespond: boolean, reason: string }}
 */
function shouldRespondToGroup(ctx = {}) {
  const { isGroup, text, mentionedJids, miiaJid, isFromOwner } = ctx || {};

  if (!isGroup) {
    return { shouldRespond: true, reason: 'not_a_group' };
  }

  // Owner puede invocar MIIA explícitamente en grupo
  if (isFromOwner && text) {
    const lower = text.toLowerCase().trim();
    if (MIIA_TRIGGER_WORDS.some(t => lower.startsWith(t))) {
      return { shouldRespond: true, reason: 'owner_trigger' };
    }
  }

  // MIIA responde si es mencionada
  if (isMentioned(text, mentionedJids, miiaJid)) {
    return { shouldRespond: true, reason: 'mentioned' };
  }

  return { shouldRespond: false, reason: 'group_no_mention' };
}

/**
 * Extrae el nombre del grupo del JID o metadata.
 * @param {object} groupMeta
 * @returns {string}
 */
function getGroupName(groupMeta) {
  if (!groupMeta) return 'Grupo desconocido';
  return groupMeta.subject || groupMeta.name || 'Grupo sin nombre';
}

/**
 * Obtiene la lista de participantes de un grupo.
 */
function getGroupParticipants(groupMeta) {
  if (!groupMeta || !Array.isArray(groupMeta.participants)) return [];
  return groupMeta.participants.map(p => ({
    jid: p.id || p.jid,
    admin: p.admin === 'admin' || p.admin === 'superadmin',
  }));
}

module.exports = {
  isGroupJid,
  isMentioned,
  shouldRespondToGroup,
  getGroupName,
  getGroupParticipants,
  GROUP_JID_SUFFIX,
  MIIA_TRIGGER_WORDS,
};
