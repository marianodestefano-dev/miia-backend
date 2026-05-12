'use strict';

/**
 * MMC — Embedding wrapper + cosineSimilarity + retrieval mod_memory()
 * (spec 13 v0.3 §Inyeccion mod_memory).
 *
 * - embed(text): wrapper Gemini text-embedding-004 (768 dims, default spec)
 * - cosineSimilarity(a, b): util pura
 * - retrieveTopLessons(uid, queryText, threshold): query con filtros +
 *   cooldown 72h + confidence>=medium + contradicted=false + deletedByOwnerAt=null
 *
 * Path canonico (A.1): users/{uid}/miia_memory/{episodeId}.lecciones[]
 *
 * §6.18 AbortController obligatorio (45s default).
 */

const COOLDOWN_MS = 72 * 60 * 60 * 1000;
const DEFAULT_TOP_K = 3;
const EMBEDDING_MODEL = 'text-embedding-004';
const EMBEDDING_TIMEOUT_MS = 45000;
const EMBEDDING_DIMS = 768;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

let _embedFn = /* istanbul ignore next */ async function (text) {
  // Default: usa Gemini API real. Tests inyectan mock via __setEmbedForTests.
  const apiKey = process.env.GEMINI_API_KEY || '';
  if (!apiKey) throw new Error('GEMINI_API_KEY_no_configurado');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    EMBEDDING_MODEL + ':embedContent?key=' + apiKey;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, EMBEDDING_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text: String(text) }] } }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('embed_api_error:' + res.status);
    const data = await res.json();
    return (data.embedding && data.embedding.values) || null;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('embed_timeout');
    throw e;
  } finally {
    clearTimeout(timer);
  }
};
function __setEmbedForTests(fn) { _embedFn = fn; }

// ── Firestore refs ────────────────────────────────────────────────────────────
function _memoryCol(uid) {
  return db().collection('users').doc(uid).collection('miia_memory');
}

// ── Util pura ─────────────────────────────────────────────────────────────────
/**
 * Cosine similarity entre dos vectores.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} entre -1 y 1, o 0 si invalido
 */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = typeof a[i] === 'number' ? a[i] : 0;
    const bv = typeof b[i] === 'number' ? b[i] : 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Wrapper de embedding. Retorna null si falla (no rompe el flow).
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
async function embed(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) return null;
  try {
    return await _embedFn(text);
  } catch (e) {
    console.warn('[EMBED] error: ' + e.message);
    return null;
  }
}

/**
 * Recupera las top K lessons mas relevantes para queryText, aplicando
 * threshold de similaridad + cooldown 72h + filtros del spec.
 *
 * @param {string} uid
 * @param {string} queryText - mensaje actual del owner
 * @param {{ threshold, topK }} opts
 * @returns {Promise<Array<{episodeId, lesson, similarity, fecha}>>}
 */
async function retrieveTopLessons(uid, queryText, opts) {
  if (!uid) throw new Error('uid_requerido');
  const o = opts || {};
  const threshold = typeof o.threshold === 'number' ? o.threshold : 0.82;
  const topK = typeof o.topK === 'number' ? o.topK : DEFAULT_TOP_K;

  const queryVector = await embed(queryText);
  if (!queryVector) return [];

  // Query: contradicted=false + deletedByOwnerAt=null
  const snap = await _memoryCol(uid)
    .where('contradicted', '==', false)
    .where('deletedByOwnerAt', '==', null)
    .get();

  const now = Date.now();
  const eligible = [];

  for (const doc of (snap.docs || [])) {
    const ep = doc.data();
    if (!Array.isArray(ep.vector) || ep.vector.length === 0) continue;
    const similarity = cosineSimilarity(queryVector, ep.vector);
    if (similarity < threshold) continue;
    if (!Array.isArray(ep.lecciones)) continue;
    for (const lesson of ep.lecciones) {
      if (lesson.contradicted) continue;
      if (lesson.deletedByOwnerAt) continue;
      if (lesson.confidence === 'low') continue;
      // Cooldown 72h
      const lastCited = lesson.lastCitedAt
        ? new Date(lesson.lastCitedAt).getTime()
        : 0;
      if (lastCited > 0 && (now - lastCited) < COOLDOWN_MS) continue;
      eligible.push({
        episodeId: ep.episodeId || doc.id,
        lesson,
        similarity,
        fecha: ep.startedAt ? new Date(ep.startedAt).toISOString() : null,
      });
    }
  }

  eligible.sort(function (a, b) { return b.similarity - a.similarity; });
  return eligible.slice(0, topK);
}

/**
 * Actualiza telemetria de la lesson tras inyectarla: lastCitedAt + citationCount.
 * @param {string} uid
 * @param {string} episodeId
 * @param {string} lessonId
 */
async function recordLessonCitation(uid, episodeId, lessonId) {
  if (!uid || !episodeId || !lessonId) throw new Error('parametros_requeridos');
  const ref = _memoryCol(uid).doc(episodeId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('episodio_no_encontrado');
  const data = snap.data();
  const lecciones = Array.isArray(data.lecciones) ? data.lecciones.slice() : [];
  let found = false;
  for (const l of lecciones) {
    if (l.id === lessonId) {
      l.lastCitedAt = new Date().toISOString();
      l.citationCount = (l.citationCount || 0) + 1;
      if (!Array.isArray(l.citationEpisodes)) l.citationEpisodes = [];
      if (!l.citationEpisodes.includes(episodeId)) {
        l.citationEpisodes.push(episodeId);
      }
      found = true;
    }
  }
  if (!found) throw new Error('lesson_no_encontrada');
  await ref.set({ lecciones }, { merge: true });
  return { ok: true };
}

module.exports = {
  cosineSimilarity,
  embed,
  retrieveTopLessons,
  recordLessonCitation,
  COOLDOWN_MS,
  DEFAULT_TOP_K,
  EMBEDDING_MODEL,
  EMBEDDING_DIMS,
  __setFirestoreForTests,
  __setEmbedForTests,
};
