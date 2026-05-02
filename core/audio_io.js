'use strict';

/**
 * audio_io.js -- T-P3-3 + T-P3-4
 * Audio IN (transcribir incoming voice notes via Whisper/Gemini multimodal)
 * Audio OUT (sintetizar outgoing via ElevenLabs si owner lo configura)
 *
 * API:
 *   transcribeIncomingAudio(audioBuffer, opts) -> { text, language, confidence }
 *   shouldUseAudioOutput(uid, contactPhone, opts) -> boolean (config check)
 *   synthesizeAudioOutput(text, opts) -> Buffer
 */

const SUPPORTED_INPUT_FORMATS = Object.freeze(['ogg', 'opus', 'mp3', 'wav', 'm4a']);
const DEFAULT_VOICE_ID = 'rachel';
const COL_AUDIO_PREFS = 'audio_prefs';

/* istanbul ignore next */
let _db = null;
/* istanbul ignore next */
function __setFirestoreForTests(fs) { _db = fs; }
/* istanbul ignore next */
function db() { return _db || require('firebase-admin').firestore(); }

/**
 * Transcribe audio incoming. Inyectable para tests.
 *
 * @param {Buffer|Uint8Array|string} audio - bytes o ruta
 * @param {object} opts
 * @param {function} opts.transcriber - async (audio, format, lang?) => string
 * @param {string} opts.format - 'ogg' (default whatsapp)
 * @param {string} opts.languageHint - 'es', 'en', 'pt'
 * @returns {Promise<{text, language, confidence}>}
 */
async function transcribeIncomingAudio(audio, opts) {
  if (!audio) throw new Error('audio requerido');
  /* istanbul ignore next */
  const o = opts || {};
  const format = o.format || 'ogg';
  if (!SUPPORTED_INPUT_FORMATS.includes(format)) throw new Error('format no soportado: ' + format);
  if (!o.transcriber || typeof o.transcriber !== 'function') {
    throw new Error('transcriber requerido (Whisper/Gemini multimodal)');
  }
  try {
    const result = await o.transcriber(audio, format, o.languageHint);
    if (typeof result === 'string') {
      return { text: result.trim(), language: o.languageHint || 'unknown', confidence: 0.8 };
    }
    return {
      text: (result.text || '').trim(),
      language: result.language || o.languageHint || 'unknown',
      confidence: typeof result.confidence === 'number' ? result.confidence : 0.8,
    };
  } catch (e) {
    return { text: '', language: 'unknown', confidence: 0, error: e.message };
  }
}

/**
 * Verifica si el owner tiene configurado responder con audio (via ElevenLabs).
 *
 * @param {string} uid
 * @param {string} contactPhone - opcional, granular per-contact override
 * @param {object} opts
 * @returns {Promise<boolean>}
 */
async function shouldUseAudioOutput(uid, contactPhone, opts) {
  if (!uid) throw new Error('uid requerido');
  const o = opts || {};
  const ref = db().collection('owners').doc(uid).collection(COL_AUDIO_PREFS).doc('settings');
  const doc = await ref.get();
  if (!doc || !doc.exists) return false;
  const data = doc.data ? doc.data() : null;
  if (!data) return false;
  if (data.audioOutputEnabled !== true) return false;
  // Per-contact override
  if (contactPhone && data.perContact && data.perContact[contactPhone] === false) return false;
  return true;
}

/**
 * Sintetiza audio outgoing. Inyectable para tests.
 *
 * @param {string} text
 * @param {object} opts
 * @param {function} opts.synthesizer - async (text, voiceId, opts) => Buffer
 * @param {string} opts.voiceId
 * @returns {Promise<Buffer>}
 */
async function synthesizeAudioOutput(text, opts) {
  if (!text || typeof text !== 'string') throw new Error('text requerido');
  if (text.length > 1000) throw new Error('text demasiado largo (max 1000 chars)');
  /* istanbul ignore next */
  const o = opts || {};
  if (!o.synthesizer || typeof o.synthesizer !== 'function') {
    throw new Error('synthesizer requerido (ElevenLabs)');
  }
  const voiceId = o.voiceId || DEFAULT_VOICE_ID;
  const audio = await o.synthesizer(text, voiceId, o);
  if (!audio) throw new Error('synthesizer devolvio vacio');
  return audio;
}

/**
 * Configura preferencias de audio para un owner.
 */
async function setAudioPreferences(uid, prefs) {
  if (!uid) throw new Error('uid requerido');
  if (!prefs || typeof prefs !== 'object') throw new Error('prefs requerido');
  const allowed = {
    audioOutputEnabled: prefs.audioOutputEnabled === true,
    voiceId: prefs.voiceId || DEFAULT_VOICE_ID,
    transcribeIncoming: prefs.transcribeIncoming !== false,
    perContact: prefs.perContact && typeof prefs.perContact === 'object' ? prefs.perContact : {},
    updatedAt: new Date().toISOString(),
  };
  await db().collection('owners').doc(uid).collection(COL_AUDIO_PREFS).doc('settings').set(allowed, { merge: true });
  return allowed;
}

module.exports = {
  transcribeIncomingAudio,
  shouldUseAudioOutput,
  synthesizeAudioOutput,
  setAudioPreferences,
  SUPPORTED_INPUT_FORMATS,
  DEFAULT_VOICE_ID,
  __setFirestoreForTests,
};
