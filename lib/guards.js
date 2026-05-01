'use strict';

/**
 * LIB/GUARDS.JS — Utilidades de guard centralizadas
 *
 * STANDARD: Google + Amazon + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * Funciones puras para detección de tipos de JID, normalización de phones,
 * guards de tenant readiness, y constantes compartidas.
 *
 * Historial de duplicaciones que este módulo resuelve (T83):
 *   - getBasePhone: ~25 usos inline en TMH + server.js
 *   - isGroup: ~13 usos de .endsWith('@g.us') sin centralizar
 *   - isGroupOrStatus: 2 lugares con patrón casi idéntico
 *   - MIIA_CENTER_UID: definida en TMH, no exportada ni usada en server.js
 *   - isSelfJid: lógica reimplementada 3 veces con variaciones
 *
 * Uso:
 *   const { getBasePhone, isGroup, MIIA_CENTER_UID } = require('../lib/guards');
 */

// ─── Constantes compartidas ───────────────────────────────────────────────────

/** UID del tenant MIIA CENTER (auto-venta del producto MIIA). §2 CLAUDE.md */
const MIIA_CENTER_UID = 'A5pMeSWlfmPWCoCPRbwy85EzUzy2';

// ─── Normalización de JID / phone ─────────────────────────────────────────────

/**
 * Extrae el número base de un JID o phone string.
 * Maneja sufijo `:device` (ej: "57316....:94@s.whatsapp.net" → "57316....").
 * @param {string} p
 * @returns {string}
 */
function getBasePhone(p) {
  if (!p || typeof p !== 'string') return '';
  return p.split('@')[0].split(':')[0];
}

/**
 * Normaliza un phone a JID completo con sufijo @s.whatsapp.net.
 * Si ya tiene '@', lo devuelve tal cual.
 * @param {string} phone
 * @returns {string}
 */
function toJid(phone) {
  if (!phone || typeof phone !== 'string') return '';
  return phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
}

/**
 * Extrae basePhone de un sock.user.id (que puede tener sufijo `:94`).
 * @param {string} sockUserId - ej: "573163937365:94@s.whatsapp.net"
 * @returns {string} - ej: "573163937365"
 */
function getSockBasePhone(sockUserId) {
  if (!sockUserId || typeof sockUserId !== 'string') return '';
  return sockUserId.split(':')[0].split('@')[0];
}

// ─── Detección de tipo de JID ─────────────────────────────────────────────────

/**
 * ¿Es un grupo (JID termina en @g.us)?
 * @param {string} phone
 * @returns {boolean}
 */
function isGroup(phone) {
  return typeof phone === 'string' && phone.endsWith('@g.us');
}

/**
 * ¿Es un mensaje de estado de WhatsApp (status@broadcast)?
 * @param {string} phone
 * @returns {boolean}
 */
function isStatus(phone) {
  return typeof phone === 'string' && phone.includes('status@');
}

/**
 * ¿Es un LID (identificador interno de WhatsApp, no número real)?
 * LIDs: contienen '@lid', empiezan con 8829, o tienen >13 dígitos.
 * @param {string} phone
 * @returns {boolean}
 */
function isLid(phone) {
  if (!phone || typeof phone !== 'string') return false;
  if (phone.includes('@lid')) return true;
  const digits = phone.replace(/[^0-9]/g, '');
  if (/^8829\d{8,}$/.test(digits)) return true;
  if (digits.length > 13) return true;
  return false;
}

/**
 * ¿Es grupo O status? (guard de bloqueo combinado frecuente).
 * @param {string} phone
 * @returns {boolean}
 */
function isGroupOrStatus(phone) {
  return isGroup(phone) || isStatus(phone);
}

// ─── Self-chat detection ─────────────────────────────────────────────────────

/**
 * ¿Son el mismo teléfono base? (para detectar self-chat / isSelfTarget).
 * Normaliza ambos antes de comparar (extrae basePhone).
 * @param {string} phoneA
 * @param {string} phoneB
 * @returns {boolean}
 */
function isSamePhone(phoneA, phoneB) {
  if (!phoneA || !phoneB) return false;
  return getBasePhone(phoneA) === getBasePhone(phoneB);
}

// ─── Tenant readiness ─────────────────────────────────────────────────────────

/**
 * ¿Está el tenant listo para enviar mensajes?
 * @param {object} tenantState - { sock, isReady }
 * @returns {boolean}
 */
function isTenantReady(tenantState) {
  return !!(tenantState?.sock && tenantState?.isReady);
}

/**
 * ¿Es el UID de MIIA CENTER?
 * @param {string} uid
 * @returns {boolean}
 */
function isMiiaCenterUid(uid) {
  return uid === MIIA_CENTER_UID;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Constantes
  MIIA_CENTER_UID,

  // Normalización
  getBasePhone,
  toJid,
  getSockBasePhone,

  // Tipo de JID
  isGroup,
  isStatus,
  isLid,
  isGroupOrStatus,

  // Self-chat
  isSamePhone,

  // Tenant
  isTenantReady,
  isMiiaCenterUid,
};
