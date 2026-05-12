'use strict';

/**
 * R13-B — Voice handler (Piso 3 audios)
 * transcribeAudio(audioBuffer, mimeType, uid) -> { text, durationMs }
 * buildVoiceResponse(transcription, context) -> string
 * Rate limit: 10 transcripciones/dia por uid
 */

const admin = require('firebase-admin');
let _db = null;
function db() { /* istanbul ignore next */ if (!_db) _db = admin.firestore(); return _db; }
function __setFirestoreForTests(fs) { _db = fs; }

const DAILY_LIMIT = 10;
const TRANSCRIBE_TIMEOUT_MS = 30000;

const SUPPORTED_MIME_TYPES = new Set([
  'audio/ogg',
  'audio/ogg; codecs=opus',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'audio/aac',
]);

function isSupportedMime(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') return false;
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return SUPPORTED_MIME_TYPES.has(mimeType.toLowerCase()) || SUPPORTED_MIME_TYPES.has(base);
}

/**
 * Retorna el contador diario de transcripciones para un uid.
 * Guarda en Firestore: owners/{uid}/voice_rate/daily_YYYY-MM-DD
 */
async function getDailyCount(uid) {
  const today = new Date().toISOString().slice(0, 10);
  const docRef = db().collection('owners').doc(uid)
    .collection('voice_rate').doc('daily_' + today);
  const snap = await docRef.get();
  return { count: snap.exists ? (snap.data().count || 0) : 0, docRef, today };
}

async function incrementDailyCount(docRef, currentCount) {
  await docRef.set({ count: currentCount + 1, updatedAt: Date.now() }, { merge: true });
}

/**
 * Transcribe un audio usando Gemini multimodal.
 * @param {Buffer} audioBuffer  — buffer del audio
 * @param {string} mimeType     — 'audio/ogg', 'audio/mpeg', etc.
 * @param {string} uid          — owner uid para rate limit
 * @returns {Promise<{text: string, durationMs: number}>}
 */
async function transcribeAudio(audioBuffer, mimeType, uid) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer)) throw new Error('audioBuffer debe ser Buffer');
  if (!isSupportedMime(mimeType)) throw new Error('mimeType no soportado: ' + mimeType);

  // Rate limit check
  const { count, docRef } = await getDailyCount(uid);
  if (count >= DAILY_LIMIT) {
    console.warn('[VOICE] Rate limit alcanzado uid=' + uid + ' count=' + count);
    throw new Error('rate_limit_exceeded: ' + DAILY_LIMIT + ' transcripciones/dia');
  }

  console.log('[VOICE] Transcribiendo uid=' + uid + ' mime=' + mimeType + ' bytes=' + audioBuffer.length + ' count=' + count);

  const startMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);

  try {
    const geminiApiKey = process.env.GEMINI_API_KEY || '';
    const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + geminiApiKey;

    const base64Audio = audioBuffer.toString('base64');
    const reqBody = {
      contents: [{
        parts: [
          { text: 'Transcribe exactamente lo que se dice en este audio. Devuelve solo el texto transcripto, sin explicaciones.' },
          { inlineData: { mimeType, data: base64Audio } },
        ],
      }],
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error('Gemini error ' + response.status + ': ' + errText.slice(0, 200));
    }

    const data = await response.json();
    const text = (data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) || '';

    const durationMs = Date.now() - startMs;
    await incrementDailyCount(docRef, count);

    console.log('[VOICE] OK uid=' + uid + ' chars=' + text.length + ' ms=' + durationMs);
    return { text: text.trim(), durationMs };

  } catch (e) {
    if (e.name === 'AbortError') {
      console.error('[VOICE] Timeout transcribiendo uid=' + uid);
      throw new Error('transcription_timeout');
    }
    console.error('[VOICE] Error transcribiendo uid=' + uid + ':', e.message);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Construye la respuesta de MIIA basada en la transcripcion.
 * @param {string} transcription — texto transcripto
 * @param {object} context       — { ownerName, chatType, language }
 * @returns {string}
 */
function buildVoiceResponse(transcription, context) {
  if (!transcription || typeof transcription !== 'string' || transcription.trim().length === 0) {
    return 'No pude entender el audio. ¿Podés repetirlo o escribirlo?';
  }

  const ctx = context || {};
  const lang = ctx.language || 'es';
  const name = ctx.ownerName ? ' ' + ctx.ownerName : '';

  if (lang !== 'es') {
    return 'Received: "' + transcription.trim() + '". Processing your request...';
  }

  return 'Escuché: "' + transcription.trim() + '". Procesando tu solicitud' + (name ? ',' + name : '') + '...';
}

module.exports = {
  transcribeAudio,
  buildVoiceResponse,
  isSupportedMime,
  getDailyCount,
  DAILY_LIMIT,
  SUPPORTED_MIME_TYPES,
  __setFirestoreForTests,
};
