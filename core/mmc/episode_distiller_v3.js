'use strict';

/**
 * MMC — Episode Distiller v0.3 enriquecido (spec 13 FASE 2 NIGHTLY-BRAIN).
 *
 * Extiende el flujo de core/mmc/episode_distiller.js (decision A.2 runner
 * oficial) sin tocarlo. Toma el output {topic, summary} del distiller base
 * y lo enriquece con los campos v0.3:
 *   - tono (heuristico simple desde mensajes)
 *   - idiomaDetectado + tonadaDetectada (dialect_detector)
 *   - lecciones[] (Lesson{} schema, generadas desde summary + tags Gemini opcional)
 *   - vector (embedding de resumen + lecciones[].text)
 *   - cadencia (solo si bootstrapComplete + cadenceConfidence>=medium)
 *
 * Path canonico: users/{uid}/miia_memory/{episodeId}
 */

const dialectDetector = require('./dialect_detector');
const embeddingRetrieval = require('./embedding_retrieval');
const episodeSchema = require('./episode_schema');
const baselineLib = require('./baseline');

let _db = null;
function __setFirestoreForTests(fs) {
  _db = fs;
  /* istanbul ignore next */
  if (typeof baselineLib.__setFirestoreForTests === 'function') {
    baselineLib.__setFirestoreForTests(fs);
  }
  /* istanbul ignore next */
  if (typeof embeddingRetrieval.__setFirestoreForTests === 'function') {
    embeddingRetrieval.__setFirestoreForTests(fs);
  }
}
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _episodeDoc(uid, episodeId) {
  return db().collection('users').doc(uid).collection('miia_memory').doc(episodeId);
}

// ── Heuristicas locales ───────────────────────────────────────────────────────

function _detectTono(text) {
  if (!text || typeof text !== 'string') return 'neutro';
  const t = text.toLowerCase();
  if (/(urgente|ahora|problema|error|falla|no\s+anda)/.test(t)) return 'urgente';
  if (/(gracias|genial|perfecto|excelente|buenisim|bravo|amo)/.test(t)) return 'positivo';
  if (/(triste|mal|dif[ií]cil|preocup|no\s+puedo|no\s+sale)/.test(t)) return 'negativo';
  if (/(frio|distante|seco)/.test(t)) return 'frio';
  if (/(cariñ|calid|querid|abrazo|beso)/.test(t)) return 'calido';
  return 'neutro';
}

function _extractTags(text) {
  if (!text || typeof text !== 'string') return [];
  const lower = text.toLowerCase();
  const STOPWORDS = new Set(['este', 'esta', 'estos', 'estas', 'pero', 'para', 'porque', 'cuando', 'donde', 'como', 'tambien', 'tambi', 'sobre', 'desde', 'hacia', 'sin', 'que', 'con', 'los', 'las', 'una', 'uno', 'son', 'fue', 'ser', 'estar']);
  const words = lower.replace(/[^a-záéíóúüñ\s]/gi, ' ').split(/\s+/);
  const counts = {};
  for (const w of words) {
    if (w.length < 5 || STOPWORDS.has(w)) continue;
    counts[w] = (counts[w] || 0) + 1;
  }
  return Object.entries(counts)
    .sort(function (a, b) { return b[1] - a[1]; })
    .slice(0, 5)
    .map(function (x) { return x[0]; });
}

/**
 * Genera lecciones[] simples desde el summary. Heuristica conservadora:
 * si el summary contiene patrones de preferencia / regla / aprendizaje,
 * crea 1-3 Lesson{}. Si no, retorna [] (spec GAP-2: episodio con []
 * se crea igual, alimenta baseline).
 */
function _generateLessonsFromSummary(summary) {
  if (!summary || typeof summary !== 'string') return [];
  const lessons = [];
  const sentences = summary.split(/[.!?]\s+/).filter(function (s) { return s.length > 10; });
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (/(prefier|le gusta|le molesta|no quiere|siempre|nunca|odia|ama|valora)/.test(lower)) {
      lessons.push(episodeSchema.buildLesson({ text: sentence.trim(), confidence: 'low', source: 'nightly_distill' }));
    }
    if (lessons.length >= 3) break;
  }
  return lessons;
}

/**
 * Detecta cadencia simple desde la secuencia de tonos por mensaje.
 * Retorna null si no hay info suficiente (cadenceConfidence < medium).
 */
function _detectCadencia(messages, bootstrapComplete) {
  if (!bootstrapComplete) return null;
  if (!Array.isArray(messages) || messages.length < 3) return null;
  const tonos = messages.map(function (m) { return _detectTono((m && (m.text || m.body)) || ''); });
  const before = tonos[0];
  const after = tonos[tonos.length - 1];
  let tipo = null;
  if (before === 'urgente' && after === 'positivo') tipo = 'reparacion';
  else if (before === 'negativo' && after === 'positivo') tipo = 'reparacion';
  else if (before === 'positivo' && after === 'positivo') tipo = 'convergencia';
  else if (before === 'positivo' && after === 'negativo') tipo = 'divergencia';
  else if (before === 'negativo' && after === 'urgente') tipo = 'escalada';
  else if (before !== 'neutro' && after === 'neutro') tipo = 'aplanamiento';
  return {
    expectativa: null,
    desvioTension: null,
    resolucion: null,
    sensacion: { before, after, delta: before === after ? null : 'cambio_' + before + '_a_' + after },
    tipo,
    cadenceConfidence: tipo ? 'medium' : 'low',
  };
}

/**
 * Enriquece un episodio con los campos v0.3. NO escribe a Firestore por si
 * solo; retorna el objeto enriquecido. El caller decide si persistir.
 *
 * @param {object} input - { uid, episodeId, mensajes, baseSummary, baseTopic }
 * @returns {Promise<object>} delta de campos para hacer .set({...}, {merge:true})
 */
async function enrichEpisodeV3(input) {
  if (!input || !input.uid) throw new Error('uid_requerido');
  if (!input.episodeId) throw new Error('episodeId_requerido');
  const o = input; // ya validado truthy en line 125
  const mensajes = Array.isArray(o.mensajes) ? o.mensajes : [];
  const fullText = mensajes
    .map(function (m) {
      if (!m) return '';
      return m.text || m.body || '';
    })
    .join(' ');

  const baseline = await baselineLib.getBaseline(o.uid);
  const bootstrapComplete = !!(baseline && baseline.bootstrapComplete);

  const { idioma, tonada } = dialectDetector.detectFromEpisode(mensajes);
  const tono = _detectTono(fullText);
  const tags = _extractTags(fullText);

  const summary = o.baseSummary || '';
  const lecciones = _generateLessonsFromSummary(summary);

  // Embedding de (resumen + lecciones[].text)
  const embeddingInput = [summary].concat(lecciones.map(function (l) { return l.text; })).join(' | ');
  const vector = await embeddingRetrieval.embed(embeddingInput);

  const cadencia = _detectCadencia(mensajes, bootstrapComplete);

  return {
    tono,
    idiomaDetectado: idioma,
    tonadaDetectada: tonada,
    tags,
    lecciones,
    resumen: summary,
    topic: o.baseTopic || null,
    vector,
    embeddingModel: vector ? embeddingRetrieval.EMBEDDING_MODEL : null,
    expectativa: cadencia ? cadencia.expectativa : null,
    desvioTension: cadencia ? cadencia.desvioTension : null,
    resolucion: cadencia ? cadencia.resolucion : null,
    sensacion: cadencia ? cadencia.sensacion : null,
    tipo: cadencia ? cadencia.tipo : null,
    cadenceConfidence: cadencia ? cadencia.cadenceConfidence : null,
    distillation_v3_at: new Date().toISOString(),
  };
}

/**
 * Aplica el enrich y persiste al doc Firestore.
 */
async function applyEnrichToFirestore(uid, episodeId, mensajes, baseSummary, baseTopic) {
  const delta = await enrichEpisodeV3({ uid, episodeId, mensajes, baseSummary, baseTopic });
  await _episodeDoc(uid, episodeId).set(delta, { merge: true });
  console.log('[DISTILL-V3] uid=' + uid.slice(0, 8) + ' ep=' + episodeId +
    ' tono=' + delta.tono + ' idioma=' + delta.idiomaDetectado +
    ' tonada=' + delta.tonadaDetectada + ' lessons=' + delta.lecciones.length);
  return { ok: true, ...delta };
}

module.exports = {
  enrichEpisodeV3,
  applyEnrichToFirestore,
  _detectTono,
  _extractTags,
  _generateLessonsFromSummary,
  _detectCadencia,
  __setFirestoreForTests,
};
