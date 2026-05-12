'use strict';

/**
 * CAT.2 — Catalog search + prompt injection
 * searchCatalog(uid, message, limit=5) -> [{name, description, price}]
 * buildCatalogContext(items) -> string para inyectar en system prompt
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

/**
 * Score de relevancia por keyword match
 */
function _scoreItem(item, messageLower) {
  var score = 0;
  var keywords = item.keywords || [];
  for (var i = 0; i < keywords.length; i++) {
    if (messageLower.includes(keywords[i].toLowerCase())) score += 2;
  }
  if (messageLower.includes(item.name.toLowerCase())) score += 3;
  if (item.category && messageLower.includes(item.category.toLowerCase())) score += 1;
  return score;
}

/**
 * Busca items del catalogo relevantes para el mensaje.
 * @param {string} uid
 * @param {string} message
 * @param {number} [limit=5]
 * @returns {Promise<Array>}
 */
async function searchCatalog(uid, message, limit) {
  if (!uid || !message) return [];
  if (limit === undefined) limit = 5;

  try {
    const snap = await db().collection('owners').doc(uid).collection('catalog')
      .where('active', '==', true)
      .get();

    if (snap.empty) return [];

    const msgLower = message.toLowerCase();
    const scored = snap.docs.map(function(doc) {
      const d = doc.data();
      return { item: d, score: _scoreItem(d, msgLower) };
    });

    scored.sort(function(a, b) { return b.score - a.score; });

    return scored.slice(0, limit).map(function(s) { return s.item; });
  } catch (e) {
    console.warn('[CATALOG-SEARCH] Error: ' + e.message);
    return [];
  }
}

/**
 * Construye el string de contexto de catalogo para inyectar en prompt.
 * @param {Array} items
 * @returns {string|null}
 */
function buildCatalogContext(items) {
  if (!items || items.length === 0) return null;
  var parts = items.map(function(item) {
    var text = item.name + ': ' + item.description;
    if (item.price != null) text += ' (' + item.currency + ' ' + item.price + ')';
    return text;
  });
  return 'Tienes disponible: ' + parts.join('. ') + '.';
}

module.exports = { searchCatalog, buildCatalogContext, _scoreItem, __setFirestoreForTests };
