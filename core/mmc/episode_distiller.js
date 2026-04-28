/**
 * MMC Capa 3 — Destilación nocturna semántica de episodios cerrados.
 *
 * Origen: CARTA_C-439 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27]
 *
 * Tercera tanda Piso 1. Lógica destilación + helpers SIN tocar TMH ni
 * cron OS. Wire-in real cron schedule va C-441.
 *
 * Toma episodios `status='closed'` con `summary=null`, llama Gemini con
 * prompt sintetizador, y actualiza el episodio a `status='distilled'`
 * con `topic` + `summary`.
 *
 * §6.18 AbortController obligatorio en fetch externo.
 */

'use strict';

const episodes = require('./episodes');

const DEFAULT_DISTILL_TIMEOUT_MS = 60_000; // 60s §6.18
const DEFAULT_BATCH_LIMIT = 50;

let _firestore = null;
function __setFirestoreForTests(fs) {
  _firestore = fs;
  // Compartir mock con episodes.js para coherencia E2E en tests.
  if (typeof episodes.__setFirestoreForTests === 'function') {
    episodes.__setFirestoreForTests(fs);
  }
}
function _getFirestore() {
  if (_firestore) return _firestore;
  return require('firebase-admin').firestore();
}

// ════════════════════════════════════════════════════════════════════
// Distill 1 episodio — llama Gemini, parsea, devuelve {topic, summary}
// ════════════════════════════════════════════════════════════════════

/**
 * Destila un episodio: llama al cliente Gemini con prompt sintetizador.
 *
 * El cliente Gemini debe exponer `generateContent({ prompt, signal })`
 * que retorna `{ text }` o `{ topic, summary }` directamente.
 *
 * @param {object} episodeData — doc del episodio (schema C-437).
 * @param {object} geminiClient — cliente con .generateContent({prompt, signal}).
 * @param {object} [options] { timeoutMs?: number }
 * @returns {Promise<{topic: string, summary: string}>}
 */
async function distillEpisode(episodeData, geminiClient, options) {
  if (!episodeData || typeof episodeData !== 'object') {
    throw new Error('episodeData requerido');
  }
  if (!geminiClient || typeof geminiClient.generateContent !== 'function') {
    throw new Error('geminiClient.generateContent requerido');
  }
  const opts = options || {};
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_DISTILL_TIMEOUT_MS;

  const messageRefs = Array.isArray(episodeData.messageIds) ? episodeData.messageIds : [];
  const promptText = _buildDistillPrompt(episodeData, messageRefs);

  // §6.18 AbortController
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let raw;
  try {
    raw = await geminiClient.generateContent({
      prompt: promptText,
      signal: controller.signal,
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) {
      throw new Error(`distillEpisode timeout (${timeoutMs}ms): ${e.message}`);
    }
    throw new Error(`distillEpisode gemini error: ${e.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  return _parseDistillResponse(raw);
}

function _buildDistillPrompt(episodeData, messageRefs) {
  const refsLine = messageRefs.length > 0
    ? `Mensajes incluidos (IDs): ${messageRefs.join(', ')}`
    : 'Sin mensajes registrados (episodio vacío).';
  return [
    'Sos un destilador semántico de episodios conversacionales.',
    `Episodio ${episodeData.episodeId} — owner ${episodeData.ownerUid} —`,
    `contacto ${episodeData.contactPhone}.`,
    refsLine,
    '',
    'Devolvé JSON estricto con campos:',
    '  { "topic": "<frase corta 4-8 palabras>", "summary": "<2-3 frases accionable>" }',
    '',
    'No incluyas markdown ni explicaciones.',
  ].join('\n');
}

function _parseDistillResponse(raw) {
  // Cliente puede devolver objeto directo (ya parseado) o {text}.
  if (raw && typeof raw === 'object' && typeof raw.topic === 'string' && typeof raw.summary === 'string') {
    return _validateAndTrim(raw.topic, raw.summary);
  }
  let text = '';
  if (raw && typeof raw === 'object' && typeof raw.text === 'string') {
    text = raw.text;
  } else if (typeof raw === 'string') {
    text = raw;
  } else {
    throw new Error('distill response shape inesperado');
  }
  // Buscar JSON dentro del texto.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('distill response sin JSON detectable');
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (e) {
    throw new Error(`distill JSON parse fail: ${e.message}`);
  }
  if (typeof parsed.topic !== 'string' || typeof parsed.summary !== 'string') {
    throw new Error('distill JSON missing topic/summary string');
  }
  return _validateAndTrim(parsed.topic, parsed.summary);
}

function _validateAndTrim(topic, summary) {
  const t = (topic || '').trim();
  const s = (summary || '').trim();
  if (t.length === 0) throw new Error('distill topic vacío');
  if (s.length === 0) throw new Error('distill summary vacío');
  return { topic: t, summary: s };
}

// ════════════════════════════════════════════════════════════════════
// Run nightly distillation — itera episodios closed pendientes
// ════════════════════════════════════════════════════════════════════

/**
 * Itera episodios `status='closed'` con `summary=null` del owner y los
 * destila. Reporta `{ processed, errors }`.
 *
 * Filtra el campo `summary=null` post-fetch porque Firestore no soporta
 * `where('summary', '==', null)` consistentemente cross-version.
 *
 * @param {string} ownerUid
 * @param {object} geminiClient
 * @param {object} [opts] { limit?: number, getEpisodesFn?: function }
 * @returns {Promise<{processed: number, errors: Array<{episodeId, error}>}>}
 */
async function runNightlyDistillation(ownerUid, geminiClient, opts) {
  const o = opts || {};
  const limit = typeof o.limit === 'number' && o.limit > 0 ? o.limit : DEFAULT_BATCH_LIMIT;

  const candidates = typeof o.getEpisodesFn === 'function'
    ? await o.getEpisodesFn(ownerUid)
    : await _defaultGetClosedPending(ownerUid, limit);

  const processedList = [];
  const errors = [];
  const skippedLocked = [];
  for (const ep of candidates) {
    if (processedList.length >= limit) break;
    if (ep.summary || ep.status !== 'closed') continue;
    // C-450-FIRESTORE-TX-AUDIT: lock atómico per-episodio antes de
    // llamar Gemini. Previene 2 cron runners paralelos consumiendo
    // costo Gemini duplicado sobre el mismo episode + double-write
    // race. Si otro runner ya tiene el lock, skipear silenciosamente.
    let lockAcquired = false;
    try {
      await _acquireDistillLock(ownerUid, ep.episodeId);
      lockAcquired = true;
    } catch (lockErr) {
      skippedLocked.push({ episodeId: ep.episodeId, reason: lockErr.message });
      continue;
    }
    try {
      const { topic, summary } = await distillEpisode(ep, geminiClient);
      await _markDistilled(ownerUid, ep.episodeId, topic, summary);
      processedList.push(ep.episodeId);
    } catch (e) {
      errors.push({ episodeId: ep.episodeId, error: e.message });
      // Liberar lock para retry sano del proximo cron tick.
      if (lockAcquired) {
        try {
          await _releaseDistillLock(ownerUid, ep.episodeId);
        } catch (_) { /* best effort */ }
      }
    }
  }

  if (processedList.length > 0) {
    console.log('[V2-ALERT][MMC-DISTILL]', {
      ownerUid,
      processed: processedList.length,
      errors: errors.length,
      skipped_locked: skippedLocked.length,
    });
  }
  return { processed: processedList.length, errors, skippedLocked };
}

async function _defaultGetClosedPending(ownerUid, limit) {
  // Reusa listEpisodes — pero filtra por contactPhone requerido.
  // Como no tenemos índice por owner+status sin contactPhone aún,
  // dejamos esta función expuesta para que el caller pase getEpisodesFn
  // custom. Default: throw para forzar uso explícito.
  throw new Error('runNightlyDistillation requires opts.getEpisodesFn for batch fetch (no global owner-scope query helper yet — provide custom)');
}

async function _markDistilled(ownerUid, episodeId, topic, summary) {
  // C-450-FIRESTORE-TX-AUDIT: limpia el flag distilling al completar.
  await _getFirestore()
    .collection('users')
    .doc(ownerUid)
    .collection('miia_memory')
    .doc(episodeId)
    .update({
      status: 'distilled',
      topic,
      summary,
      distilling: false,
    });
}

/**
 * C-450-FIRESTORE-TX-AUDIT — Adquiere lock atómico para distillar un
 * episodio. Si otro runner ya lo tiene (distilling=true) o ya esta
 * distilled (summary set), throws. El llamador debe skipear este
 * episode y continuar con el siguiente.
 */
async function _acquireDistillLock(ownerUid, episodeId) {
  const fs = _getFirestore();
  const ref = fs
    .collection('users')
    .doc(ownerUid)
    .collection('miia_memory')
    .doc(episodeId);
  await fs.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('episode missing');
    const data = snap.data() || {};
    if (data.summary) throw new Error('already distilled');
    if (data.status !== 'closed') throw new Error('not closed');
    if (data.distilling) throw new Error('locked by another runner');
    tx.update(ref, {
      distilling: true,
      distilling_started_at: Date.now(),
    });
  });
}

/**
 * C-450-FIRESTORE-TX-AUDIT — Libera el lock distilling (best effort) si
 * runNightlyDistillation falla a mitad. Sin esto el flag queda pegado y
 * el episode no se procesa nunca mas.
 */
async function _releaseDistillLock(ownerUid, episodeId) {
  await _getFirestore()
    .collection('users')
    .doc(ownerUid)
    .collection('miia_memory')
    .doc(episodeId)
    .update({ distilling: false });
}

// ════════════════════════════════════════════════════════════════════
// Helper para tests — mock Gemini predeterminado
// ════════════════════════════════════════════════════════════════════

function createMockGeminiForDistillation(opts) {
  const o = opts || {};
  const topic = o.topic || 'consulta inventario abril';
  const summary = o.summary || 'Owner pregunta stock + plazos. Revisar planilla viernes y actualizar.';
  const fail = !!o.fail;
  const timeoutForever = !!o.timeoutForever;
  const responseShape = o.responseShape || 'object'; // 'object' | 'text' | 'invalid_json'
  return {
    async generateContent({ signal }) {
      if (timeoutForever) {
        return new Promise((_, reject) => {
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      }
      if (fail) {
        throw new Error('mock gemini HTTP 500');
      }
      if (responseShape === 'invalid_json') {
        return { text: 'esto no es JSON parseable nada de nada' };
      }
      if (responseShape === 'text') {
        return { text: JSON.stringify({ topic, summary }) };
      }
      return { topic, summary };
    },
  };
}

module.exports = {
  distillEpisode,
  runNightlyDistillation,
  createMockGeminiForDistillation,
  DEFAULT_DISTILL_TIMEOUT_MS,
  DEFAULT_BATCH_LIMIT,
  __setFirestoreForTests,
};
