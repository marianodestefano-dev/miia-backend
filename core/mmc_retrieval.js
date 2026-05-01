'use strict';

/**
 * MIIA — MMC Retrieval Optimizer (T99)
 * importanceScore por tipo: owner=0.8, lead=0.5, eventos=0.3.
 * Filtra memorias con score < 0.2. Max 5 memorias por consulta.
 * Ordena por importanceScore desc, luego por timestamp desc.
 */

const admin = require('firebase-admin');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || admin.firestore(); }

const IMPORTANCE_SCORES = Object.freeze({
  owner: 0.8,
  lead: 0.5,
  client: 0.5,
  evento: 0.3,
  reminder: 0.3,
  default: 0.4,
});

const MIN_SCORE = 0.2;
const MAX_MEMORIES = 5;

/**
 * Asigna importanceScore a una memoria según su tipo.
 * @param {{ type?: string, importanceScore?: number }} memory
 * @returns {number} score entre 0 y 1
 */
function assignImportanceScore(memory) {
  if (!memory || typeof memory !== 'object') return IMPORTANCE_SCORES.default;
  // Si ya tiene score explícito y válido, respetarlo
  if (typeof memory.importanceScore === 'number' &&
      memory.importanceScore >= 0 && memory.importanceScore <= 1) {
    return memory.importanceScore;
  }
  const type = (memory.type || '').toLowerCase();
  return IMPORTANCE_SCORES[type] !== undefined ? IMPORTANCE_SCORES[type] : IMPORTANCE_SCORES.default;
}

/**
 * Filtra y ordena una lista de memorias por importanceScore.
 * @param {Array<object>} memories
 * @param {{ minScore?: number, maxResults?: number }} opts
 * @returns {Array<object>} memorias filtradas y ordenadas
 */
function rankMemories(memories, { minScore = MIN_SCORE, maxResults = MAX_MEMORIES } = {}) {
  if (!Array.isArray(memories)) return [];

  return memories
    .map(m => ({ ...m, _score: assignImportanceScore(m) }))
    .filter(m => m._score >= minScore)
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      const tsA = a.timestamp || 0;
      const tsB = b.timestamp || 0;
      return tsB - tsA;
    })
    .slice(0, maxResults)
    .map(m => { const { _score, ...rest } = m; return { ...rest, importanceScore: _score }; });
}

/**
 * Obtiene memorias rankeadas desde Firestore para un owner + phone.
 * Lee users/{uid}/mmc/{phone}/entries.
 * @param {string} uid
 * @param {string} phone
 * @param {{ minScore?: number, maxResults?: number }} opts
 * @returns {Promise<Array<object>>}
 */
async function getTopMemories(uid, phone, opts = {}) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!phone || typeof phone !== 'string') throw new Error('phone requerido');

  try {
    const snap = await db().collection('users').doc(uid)
      .collection('mmc').doc(phone).get();
    if (!snap.exists) return [];
    const data = snap.data();
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const ranked = rankMemories(entries, opts);
    console.log(`[MMC-RANK] uid=${uid.substring(0,8)} phone=${phone} entries=${entries.length} ranked=${ranked.length}`);
    return ranked;
  } catch (e) {
    console.warn(`[MMC-RANK] Error leyendo memorias uid=${uid.substring(0,8)} phone=${phone}: ${e.message}`);
    return [];
  }
}

module.exports = {
  assignImportanceScore, rankMemories, getTopMemories,
  IMPORTANCE_SCORES, MIN_SCORE, MAX_MEMORIES,
  __setFirestoreForTests,
};
