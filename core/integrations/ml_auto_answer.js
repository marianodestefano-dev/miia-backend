'use strict';

/**
 * R19-B — core/integrations/ml_auto_answer.js (Piso 4 P4.1 - IDEA #011)
 * Cron de auto-respuesta de preguntas ML por vendedor.
 * Para cada owner con ML conectado:
 *   1. getPendingQuestions()
 *   2. Por cada pregunta: getListing() para contexto del producto
 *   3. Gemini genera respuesta contextualizada
 *   4. answerQuestion() -> respuesta publicada en ML
 * Firestore scan: owners/{uid}/integrations/mercadolibre donde access_token != null
 */

const MAX_QUESTIONS_PER_RUN = 10;
const MAX_ANSWER_LENGTH = 2000;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

let _ml = require('./mercadolibre');
function __setMlForTests(mock) { _ml = mock; }

let _gemini = /* istanbul ignore next */ async function (uid, prompt) {
  const gc = require('../gemini_client');
  return gc.generateText(uid, prompt);
};
function __setGeminiForTests(fn) { _gemini = fn; }

// ── Construccion de respuesta ─────────────────────────────────────────────────
async function _buildAnswer(uid, question) {
  let listingContext = '';
  if (question.item_id) {
    try {
      const listing = await _ml.getListing(uid, question.item_id);
      listingContext = 'Producto: ' + listing.title + '. Precio: ' + listing.price + '. Stock: ' + listing.available_quantity + '.';
    } catch (_) {
      // listing no disponible, continuamos sin contexto
    }
  }
  const lines = [
    'Eres el asistente de ventas de este vendedor de Mercado Libre.',
  ];
  if (listingContext) lines.push(listingContext);
  lines.push('Pregunta del comprador: ' + (question.text || ''));
  lines.push('Responde de forma amable, concisa y en el mismo idioma de la pregunta. Maximo 500 caracteres.');
  const prompt = lines.join('\n');
  const raw = await _gemini(uid, prompt);
  if (!raw || typeof raw !== 'string') return null;
  return raw.trim().slice(0, MAX_ANSWER_LENGTH);
}

// ── Procesamiento por owner ───────────────────────────────────────────────────
/**
 * Procesa las preguntas pendientes de un owner con ML conectado.
 * @param {string} uid
 * @returns {{ uid, processed, answered, errors } | { uid, skipped, reason }}
 */
async function processOwnerQuestions(uid) {
  if (!uid) throw new Error('uid_requerido');
  const connected = await _ml.isConnected(uid);
  if (!connected) return { uid, skipped: true, reason: 'not_connected' };

  const questions = await _ml.getPendingQuestions(uid);
  if (!questions || questions.length === 0) {
    return { uid, processed: 0, answered: 0, errors: 0 };
  }

  const toProcess = questions.slice(0, MAX_QUESTIONS_PER_RUN);
  let answered = 0;
  let errors = 0;

  for (const q of toProcess) {
    try {
      const respuesta = await _buildAnswer(uid, q);
      if (!respuesta) {
        console.log('[ML-AUTO-ANSWER] uid=' + uid.slice(0, 8) + ' qId=' + q.id + ' SKIP: sin respuesta de Gemini');
        errors++;
        continue;
      }
      await _ml.answerQuestion(uid, q.id, respuesta);
      answered++;
    } catch (e) {
      console.log('[ML-AUTO-ANSWER] uid=' + uid.slice(0, 8) + ' qId=' + q.id + ' ERROR: ' + e.message);
      errors++;
    }
  }

  return { uid, processed: toProcess.length, answered, errors };
}

// ── Cron runner ───────────────────────────────────────────────────────────────
/**
 * Procesa preguntas pendientes para cada UID en la lista.
 * @param {string[]} uids
 * @returns {object[]} resultados por owner
 */
async function runAutoAnswerCron(uids) {
  if (!Array.isArray(uids) || uids.length === 0) {
    console.log('[ML-AUTO-ANSWER-CRON] Sin owners para procesar');
    return [];
  }
  const results = [];
  for (const uid of uids) {
    try {
      const result = await processOwnerQuestions(uid);
      results.push(result);
    } catch (e) {
      console.log('[ML-AUTO-ANSWER-CRON] uid=' + (uid || '').slice(0, 8) + ' ERROR: ' + e.message);
      results.push({ uid, error: e.message });
    }
  }
  const totalAnswered = results.reduce(function (s, r) { return s + (r.answered || 0); }, 0);
  console.log('[ML-AUTO-ANSWER-CRON] run complete: ' + results.length + ' owners, ' + totalAnswered + ' answered');
  return results;
}

// ── Scan Firestore owners con ML conectado ────────────────────────────────────
/**
 * Obtiene UIDs de owners con ML conectado escaneando Firestore.
 * @returns {string[]}
 */
async function getMlConnectedOwners() {
  const snap = await db().collectionGroup('integrations').get();
  const uids = [];
  snap.forEach(function (doc) {
    if (doc.id === 'mercadolibre') {
      const data = doc.data();
      if (data && data.access_token) {
        const parts = doc.ref.path.split('/');
        if (parts[1]) uids.push(parts[1]);
      }
    }
  });
  return uids;
}

module.exports = {
  runAutoAnswerCron,
  processOwnerQuestions,
  getMlConnectedOwners,
  MAX_QUESTIONS_PER_RUN,
  MAX_ANSWER_LENGTH,
  __setFirestoreForTests,
  __setMlForTests,
  __setGeminiForTests,
};
