'use strict';

/**
 * MIIA — Conversation Export (T107)
 * Exporta las conversaciones del owner como JSON.
 * En el futuro se cifrará (Fortaleza). Hoy: JSON plano con metadata.
 * POST /api/tenant/:uid/export-conversations
 */

const admin = require('firebase-admin');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || admin.firestore(); }

/**
 * Genera un export JSON de las conversaciones del owner.
 * @param {string} uid
 * @param {{ includeContactTypes?: boolean, phone?: string }} opts
 * @returns {Promise<{ uid, exportedAt, totalConversations, totalMessages, data }>}
 */
async function exportConversations(uid, opts = {}) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');

  const snap = await db().collection('users').doc(uid)
    .collection('miia_persistent').doc('tenant_conversations').get();

  if (!snap.exists) {
    return {
      uid, exportedAt: new Date().toISOString(),
      totalConversations: 0, totalMessages: 0, data: {}
    };
  }

  const data = snap.data();
  const conversations = (data && data.conversations) || {};
  const contactTypes = (data && data.contactTypes) || {};

  // Filtrar por phone si se pasa
  let filteredConvs = conversations;
  if (opts.phone) {
    filteredConvs = opts.phone in conversations
      ? { [opts.phone]: conversations[opts.phone] }
      : {};
  }

  let totalMessages = 0;
  const exportData = {};
  for (const [phone, msgs] of Object.entries(filteredConvs)) {
    const msgArray = Array.isArray(msgs) ? msgs : [];
    totalMessages += msgArray.length;
    exportData[phone] = {
      messages: msgArray,
      ...(opts.includeContactTypes && { contactType: contactTypes[phone] || 'unknown' })
    };
  }

  const result = {
    uid,
    exportedAt: new Date().toISOString(),
    totalConversations: Object.keys(exportData).length,
    totalMessages,
    data: exportData,
  };

  console.log(`[EXPORT] uid=${uid.substring(0,8)} convs=${result.totalConversations} msgs=${result.totalMessages}`);
  return result;
}

/**
 * Serializa el export a JSON string (para descarga).
 */
function serializeExport(exportObj) {
  if (!exportObj || typeof exportObj !== 'object') throw new Error('exportObj requerido');
  return JSON.stringify(exportObj, null, 2);
}

module.exports = { exportConversations, serializeExport, __setFirestoreForTests };
