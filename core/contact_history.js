'use strict';

/**
 * MIIA — Contact History API (T104)
 * Historial de conversaciones de un contacto especifico.
 * GET /api/tenant/:uid/contact-history?phone=&limit=50&before=<timestamp>
 * Paginacion por cursor (before=<timestamp>).
 */

const admin = require('firebase-admin');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || admin.firestore(); }

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Retorna el historial de mensajes de un contacto con paginacion.
 * @param {string} uid
 * @param {string} phone
 * @param {{ limit?: number, before?: number }} opts
 * @returns {Promise<{ uid, phone, messages, hasMore, nextCursor }>}
 */
async function getContactHistory(uid, phone, { limit = DEFAULT_LIMIT, before = null } = {}) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!phone || typeof phone !== 'string') throw new Error('phone requerido');

  const effectiveLimit = Math.min(Math.max(1, limit), MAX_LIMIT);

  try {
    const snap = await db().collection('users').doc(uid)
      .collection('miia_persistent').doc('tenant_conversations').get();
    if (!snap.exists) return { uid, phone, messages: [], hasMore: false, nextCursor: null };

    const data = snap.data();
    const conversations = (data && data.conversations) || {};
    const allMsgs = Array.isArray(conversations[phone]) ? conversations[phone] : [];

    // Filtrar por cursor (before = timestamp)
    let filtered = before !== null
      ? allMsgs.filter(m => typeof m.timestamp === 'number' && m.timestamp < before)
      : allMsgs;

    // Ordenar por timestamp desc (mas reciente primero)
    filtered = filtered
      .slice()
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const hasMore = filtered.length > effectiveLimit;
    const page = filtered.slice(0, effectiveLimit);
    const nextCursor = hasMore && page.length > 0
      ? (page[page.length - 1].timestamp || null)
      : null;

    console.log(`[CONTACT-HISTORY] uid=${uid.substring(0,8)} phone=${phone} total=${allMsgs.length} returned=${page.length} hasMore=${hasMore}`);
    return { uid, phone, messages: page, hasMore, nextCursor };
  } catch (e) {
    console.warn(`[CONTACT-HISTORY] Error uid=${uid.substring(0,8)} phone=${phone}: ${e.message}`);
    return { uid, phone, messages: [], hasMore: false, nextCursor: null, error: e.message };
  }
}

module.exports = { getContactHistory, __setFirestoreForTests, DEFAULT_LIMIT, MAX_LIMIT };
