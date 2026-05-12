'use strict';

/**
 * R17-B — contact_search.js (Piso 2 P2.3 - IDEA #014)
 * Buscador semántico de contactos: exact match → prefix → keyword en conversaciones.
 */

const MAX_RESULTS = 20;
const SCORE_EXACT_NAME = 100;
const SCORE_PREFIX_NAME = 60;
const SCORE_CONTAINS_NAME = 40;
const SCORE_EXACT_PHONE = 80;
const SCORE_CONTAINS_PHONE = 30;
const SCORE_KEYWORD = 20;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _ownerCol(uid, col) {
  return db().collection('owners').doc(uid).collection(col);
}

function _normalize(str) {
  return (str || /* istanbul ignore next */ '').toLowerCase().trim();
}

function _scoreContact(contact, query) {
  const q = _normalize(query);
  const name = _normalize(contact.name || '');
  const phone = (contact.phone || '').toLowerCase();
  const keywords = Array.isArray(contact.keywords) ? contact.keywords.map(_normalize) : [];
  let score = 0;

  if (name === q) {
    score += SCORE_EXACT_NAME;
  } else if (name.startsWith(q)) {
    score += SCORE_PREFIX_NAME;
  } else if (name.includes(q)) {
    score += SCORE_CONTAINS_NAME;
  }

  if (phone === q) {
    score += SCORE_EXACT_PHONE;
  } else if (phone.includes(q)) {
    score += SCORE_CONTAINS_PHONE;
  }

  for (const kw of keywords) {
    if (kw.includes(q)) { score += SCORE_KEYWORD; break; }
  }

  return score;
}

/**
 * Busca contactos por nombre, teléfono o keywords en conversaciones.
 * Estrategia: exact name → prefix name → contains name → exact phone → contains phone → keywords.
 * @param {string} uid
 * @param {string} query — texto de búsqueda
 * @returns {Array} contactos rankeados por relevancia + última actividad
 */
async function searchContacts(uid, query) {
  if (!uid || !query || !query.trim()) return [];
  const q = query.trim();
  let contacts = [];
  try {
    const snap = await _ownerCol(uid, 'contacts').get();
    snap.forEach(function (doc) {
      const d = doc.data();
      contacts.push({
        phone: doc.id,
        name: d.name || doc.id,
        contextType: d.contextType || 'lead',
        lastActivity: d.lastActivity || null,
        keywords: Array.isArray(d.keywords) ? d.keywords : [],
      });
    });
  } catch (e) {
    console.error('[CONTACT-SEARCH] error cargando contacts uid=' + uid.slice(0, 8) + ':', e.message);
    return [];
  }

  const scored = contacts
    .map(function (c) { return { contact: c, score: _scoreContact(c, q) }; })
    .filter(function (r) { return r.score > 0; })
    .sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      const aTs = a.contact.lastActivity || 0;
      const bTs = b.contact.lastActivity || 0;
      return bTs > aTs ? 1 : bTs < aTs ? -1 : 0;
    })
    .slice(0, MAX_RESULTS)
    .map(function (r) { return Object.assign({}, r.contact, { _score: r.score }); });

  console.log('[CONTACT-SEARCH] uid=' + uid.slice(0, 8) + ' q=' + JSON.stringify(q) + ' resultados=' + scored.length);
  return scored;
}

module.exports = {
  searchContacts,
  _scoreContact,
  MAX_RESULTS,
  SCORE_EXACT_NAME,
  SCORE_PREFIX_NAME,
  SCORE_CONTAINS_NAME,
  SCORE_EXACT_PHONE,
  SCORE_CONTAINS_PHONE,
  SCORE_KEYWORD,
  __setFirestoreForTests,
};
