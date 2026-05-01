'use strict';

/**
 * MIIA - Quick Replies (T162/T163)
 * Owner define respuestas rapidas por categoria.
 * MIIA las sugiere automaticamente segun contexto.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

const MAX_REPLIES_PER_OWNER = 200;
const MAX_SHORTCUT_LENGTH = 30;
const MAX_TEXT_LENGTH = 1000;
const BUILT_IN_CATEGORIES = Object.freeze(['greeting', 'pricing', 'hours', 'location', 'closing', 'general']);

/**
 * Crea o actualiza una respuesta rapida.
 * @param {string} uid
 * @param {object} reply - { shortcut, text, category, tags }
 * @returns {Promise<{id, shortcut, text, category}>}
 */
async function saveQuickReply(uid, reply) {
  if (!uid) throw new Error('uid requerido');
  if (!reply || typeof reply !== 'object') throw new Error('reply requerido');
  if (!reply.shortcut || typeof reply.shortcut !== 'string') throw new Error('shortcut requerido');
  if (reply.shortcut.length > MAX_SHORTCUT_LENGTH) throw new Error('shortcut demasiado largo (max ' + MAX_SHORTCUT_LENGTH + ')');
  if (!reply.text || typeof reply.text !== 'string') throw new Error('text requerido');
  if (reply.text.length > MAX_TEXT_LENGTH) throw new Error('text demasiado largo (max ' + MAX_TEXT_LENGTH + ')');

  const category = reply.category || 'general';
  const tags = Array.isArray(reply.tags) ? reply.tags : [];
  const id = reply.id || _genId(uid, reply.shortcut);

  const payload = {
    id, uid, shortcut: reply.shortcut.toLowerCase().trim(),
    text: reply.text, category, tags,
    active: reply.active !== false,
    createdAt: reply.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    await db().collection('quick_replies').doc(uid).collection('replies').doc(id).set(payload);
    console.log('[QR] guardado uid=' + uid.substring(0, 8) + ' shortcut=' + payload.shortcut);
    return payload;
  } catch (e) {
    console.error('[QR] Error guardando uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  }
}

/**
 * Obtiene todas las respuestas rapidas activas de un owner.
 * @param {string} uid
 * @returns {Promise<Array<object>>}
 */
async function getQuickReplies(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('quick_replies').doc(uid)
      .collection('replies').where('active', '==', true).get();
    const items = [];
    snap.forEach(doc => items.push(doc.data()));
    return items;
  } catch (e) {
    console.error('[QR] Error leyendo uid=' + uid.substring(0, 8) + ': ' + e.message);
    return [];
  }
}

/**
 * Elimina (desactiva) una respuesta rapida.
 * @param {string} uid
 * @param {string} id
 */
async function deleteQuickReply(uid, id) {
  if (!uid) throw new Error('uid requerido');
  if (!id) throw new Error('id requerido');
  try {
    await db().collection('quick_replies').doc(uid).collection('replies').doc(id)
      .set({ active: false, updatedAt: new Date().toISOString() }, { merge: true });
    console.log('[QR] desactivado uid=' + uid.substring(0, 8) + ' id=' + id);
  } catch (e) {
    console.error('[QR] Error eliminando uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  }
}

/**
 * Sugiere respuestas rapidas relevantes para un mensaje de lead.
 * @param {Array<object>} replies - lista de respuestas rapidas activas
 * @param {string} message - mensaje del lead
 * @param {object} [opts] - { maxSuggestions }
 * @returns {Array<object>} sugerencias ordenadas por relevancia
 */
function suggestReplies(replies, message) {
  if (!Array.isArray(replies)) throw new Error('replies debe ser array');
  if (!message || typeof message !== 'string') return [];

  const lower = message.toLowerCase();
  const words = lower.split(/\s+/).filter(w => w.length >= 2);
  if (words.length === 0) return [];

  const scored = replies
    .filter(r => r.active !== false)
    .map(r => {
      const score = _scoreReply(r, lower, words);
      return { ...r, _score: score };
    })
    .filter(r => r._score > 0)
    .sort((a, b) => b._score - a._score);

  return scored.slice(0, 5).map(r => { const { _score, ...rest } = r; return rest; });
}

/**
 * Busca respuesta rapida por shortcut exacto.
 * @param {Array<object>} replies
 * @param {string} shortcut
 * @returns {object|null}
 */
function findByShortcut(replies, shortcut) {
  if (!Array.isArray(replies)) throw new Error('replies debe ser array');
  if (!shortcut) return null;
  const lower = shortcut.toLowerCase().trim();
  return replies.find(r => r.shortcut === lower && r.active !== false) || null;
}

function _scoreReply(reply, lowerMsg, words) {
  let score = 0;
  const shortcut = (reply.shortcut || '').toLowerCase();
  const text = (reply.text || '').toLowerCase();
  const tags = (reply.tags || []).map(t => t.toLowerCase());

  if (lowerMsg.includes(shortcut)) score += 3;
  for (const word of words) {
    if (shortcut.includes(word)) score += 1;
    if (text.includes(word)) score += 0.5;
    if (tags.some(t => t.includes(word))) score += 1.5;
  }

  return score;
}

function _genId(uid, shortcut) {
  return uid.substring(0, 8) + '_' + shortcut.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '_' + Date.now();
}

module.exports = {
  saveQuickReply, getQuickReplies, deleteQuickReply, suggestReplies, findByShortcut,
  BUILT_IN_CATEGORIES, MAX_REPLIES_PER_OWNER, MAX_SHORTCUT_LENGTH, MAX_TEXT_LENGTH,
  __setFirestoreForTests,
};
