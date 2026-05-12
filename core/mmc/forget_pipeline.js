'use strict';

/**
 * MMC — Derecho al olvido EJECUCION INMEDIATA (spec 13 v0.3 §Derecho al olvido).
 *
 * Hook pre-LLM: detector lexico FORGET_PATTERNS. Si matchea:
 *   1. Query semantica top 5 episodes + top 10 lessons similaridad >= 0.75
 *   2. Soft-delete INMEDIATO (deletedByOwnerAt + deletionReason='owner_explicit')
 *   3. Inyeccion en prompt del turno: "Owner pidio olvidar [X]. Ya borrado."
 *
 * Hard-delete fisico lo hace el batch nocturno (B.11+ cleanup).
 *
 * Path canonico (A.1): users/{uid}/miia_memory/{episodeId}
 */

const embeddingRetrieval = require('./embedding_retrieval');

// Patrones spec 13 v0.3 §Derecho al olvido (multi-dialecto ES)
const FORGET_PATTERNS = Object.freeze([
  /(miia,?\s+)?(ol?vid[aá]te|borr[aá]|elimin[aá])\s+(eso|lo\s+que|esa|ese|todo)/i,
  /no\s+quiero\s+que\s+(lo\s+)?(record[eé]s|recuerdes|sepas|guard[eé]s)/i,
  /borr[aá]\s+(la\s+)?(informaci[óo]n|conversaci[óo]n|lo\s+que\s+dije)\s+(de|sobre|acerca)/i,
  /m[eé]\s+arrepiento\s+de\s+(haber|habernos)\s+(dicho|hablado)/i,
]);

const FORGET_THRESHOLD = 0.75;
const FORGET_MAX_EPISODES = 5;
const FORGET_MAX_LESSONS = 10;

let _db = null;
function __setFirestoreForTests(fs) {
  _db = fs;
  embeddingRetrieval.__setFirestoreForTests(fs);
}
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _memoryCol(uid) {
  return db().collection('users').doc(uid).collection('miia_memory');
}

/**
 * Detecta si el mensaje del owner pide olvidar algo.
 * @param {string} ownerMessage
 * @returns {{ match: boolean, pattern: RegExp|null }}
 */
function detectForgetIntent(ownerMessage) {
  if (!ownerMessage || typeof ownerMessage !== 'string') {
    return { match: false, pattern: null };
  }
  for (const p of FORGET_PATTERNS) {
    if (p.test(ownerMessage)) return { match: true, pattern: p };
  }
  return { match: false, pattern: null };
}

/**
 * Aplica soft-delete a episodios y lessons relevantes al pedido de olvido.
 * Usa embedding del mensaje del owner para encontrar semanticamente cercanos.
 * @param {string} uid
 * @param {string} ownerMessage
 * @returns {Promise<{episodiosBorrados, lessonsBorradas, episodios, lessons}>}
 */
async function executeForget(uid, ownerMessage) {
  if (!uid) throw new Error('uid_requerido');
  if (!ownerMessage) throw new Error('ownerMessage_requerido');

  // 1. Embedding del mensaje
  const queryVector = await embeddingRetrieval.embed(ownerMessage);
  if (!queryVector) {
    // Sin embedding no podemos hacer query semantica; el caller decide fallback
    return { episodiosBorrados: 0, lessonsBorradas: 0, episodios: [], lessons: [], noEmbedding: true };
  }

  // 2. Query todos los episodios no borrados, filtrar por similaridad >= 0.75
  const snap = await _memoryCol(uid)
    .where('contradicted', '==', false)
    .where('deletedByOwnerAt', '==', null)
    .get();

  const matchedEpisodios = [];
  const matchedLessons = []; // { episodeId, lesson }

  for (const doc of (snap.docs || [])) {
    const ep = doc.data();
    if (!Array.isArray(ep.vector) || ep.vector.length === 0) continue;
    const similarity = embeddingRetrieval.cosineSimilarity(queryVector, ep.vector);
    if (similarity < FORGET_THRESHOLD) continue;
    matchedEpisodios.push({ ref: doc.ref || _memoryCol(uid).doc(ep.episodeId || doc.id), ep, similarity });
    if (Array.isArray(ep.lecciones)) {
      for (const lesson of ep.lecciones) {
        if (lesson.deletedByOwnerAt) continue;
        matchedLessons.push({ episodeId: ep.episodeId || doc.id, lesson, similarity });
      }
    }
  }

  // 3. Top N por similaridad
  matchedEpisodios.sort(function (a, b) { return b.similarity - a.similarity; });
  matchedLessons.sort(function (a, b) { return b.similarity - a.similarity; });
  const topEpisodios = matchedEpisodios.slice(0, FORGET_MAX_EPISODES);
  const topLessons = matchedLessons.slice(0, FORGET_MAX_LESSONS);

  // 4. Soft-delete inmediato
  const now = new Date().toISOString();
  let episodiosBorrados = 0;
  let lessonsBorradas = 0;

  for (const item of topEpisodios) {
    await item.ref.set({
      deletedByOwnerAt: now,
      deletionReason: 'owner_explicit',
    }, { merge: true });
    episodiosBorrados++;
  }

  // Para lessons: marcar la Lesson{} en el array
  // Agrupamos por episodeId para no escribir el mismo doc varias veces
  const byEpisode = {};
  for (const item of topLessons) {
    if (!byEpisode[item.episodeId]) byEpisode[item.episodeId] = [];
    byEpisode[item.episodeId].push(item.lesson.id);
  }
  for (const [episodeId, lessonIds] of Object.entries(byEpisode)) {
    const ref = _memoryCol(uid).doc(episodeId);
    const epSnap = await ref.get();
    if (!epSnap.exists) continue;
    const data = epSnap.data();
    const lecciones = Array.isArray(data.lecciones) ? data.lecciones.slice() : [];
    let modified = false;
    for (const l of lecciones) {
      if (lessonIds.includes(l.id) && !l.deletedByOwnerAt) {
        l.deletedByOwnerAt = now;
        modified = true;
        lessonsBorradas++;
      }
    }
    if (modified) {
      await ref.set({ lecciones }, { merge: true });
    }
  }

  console.log('[FORGET] uid=' + uid.slice(0, 8) + ' eps=' + episodiosBorrados + ' lessons=' + lessonsBorradas);

  return {
    episodiosBorrados,
    lessonsBorradas,
    episodios: topEpisodios.map(function (x) { return x.ep.episodeId || ''; }),
    lessons: topLessons.map(function (x) { return x.lesson.id; }),
  };
}

/**
 * Genera el bloque de inyeccion para el prompt del turno actual.
 * "Owner pidio olvidar [X]. Ya borrado."
 * @param {{episodiosBorrados, lessonsBorradas}} result
 * @returns {string}
 */
function buildForgetInjection(result) {
  if (!result) return '';
  const total = (result.episodiosBorrados || 0) + (result.lessonsBorradas || 0);
  if (total === 0) {
    return '\n[FORGET-NOOP] Owner pidio olvidar algo pero no encontre coincidencias suficientes. Responder honesto: "no estoy segura de a que te referis, pero no voy a guardar mas esta conversacion".\n';
  }
  return '\n[FORGET-DONE] Owner pidio olvidar X. ' +
    result.episodiosBorrados + ' episodios + ' + result.lessonsBorradas + ' lessons soft-borrados. ' +
    'Responder: "Listo, ya me olvide 🤷‍♀️".\n';
}

module.exports = {
  detectForgetIntent,
  executeForget,
  buildForgetInjection,
  FORGET_PATTERNS,
  FORGET_THRESHOLD,
  FORGET_MAX_EPISODES,
  FORGET_MAX_LESSONS,
  __setFirestoreForTests,
};
