'use strict';

/**
 * MIIA — Audio Synthesizer (T158)
 * Sintesis de voz usando ElevenLabs TTS.
 * Soporta 9 voces configurables por owner.
 */

let _httpClient = null;
function __setHttpClientForTests(client) { _httpClient = client; }
function getHttpClient() {
  if (_httpClient) return _httpClient;
  return { post: _defaultPost };
}

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_VOICE_ID = '2VUqK4PEdMj16L6xTN4J';
const AVAILABLE_VOICE_IDS = Object.freeze([
  '2VUqK4PEdMj16L6xTN4J',
  'oJIuRMopN0sojGjwD6rQ',
  'uQw4jpKzMLrZuo0RLPS9',
  'qHkrJuifPpn95wK3rm2A',
  'sTssBd4UwWFtfaTFfdfQ',
  'kjHz50TasdqbpbfK4uaN',
  'CaJslL1xziwefCeTNzHv',
  'gE0owC0H9C8SzfDyIUtB',
  'r8xv1pPjvU4tE8sT1cLP',
]);
const MAX_TEXT_LENGTH = 5000;
const TIMEOUT_MS = 30000;
const DEFAULT_MODEL = 'eleven_multilingual_v2';

/**
 * Sintetiza texto a audio usando ElevenLabs.
 * @param {string} text
 * @param {object} [opts] - { voiceId, apiKey, modelId, stability, similarityBoost, timeout }
 * @returns {Promise<{buffer, voiceId, modelId, format}>}
 */
async function synthesizeAudio(text, opts) {
  if (!text || typeof text !== 'string') throw new Error('text requerido (string)');
  if (text.trim().length === 0) throw new Error('text vacio');
  if (text.length > MAX_TEXT_LENGTH) throw new Error('text demasiado largo (max ' + MAX_TEXT_LENGTH + ' chars)');

  const voiceId = (opts && opts.voiceId) || DEFAULT_VOICE_ID;
  if (!AVAILABLE_VOICE_IDS.includes(voiceId)) throw new Error('voiceId invalido: ' + voiceId);

  const apiKey = (opts && opts.apiKey) || process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY requerido');

  const modelId = (opts && opts.modelId) || DEFAULT_MODEL;
  const stability = (opts && opts.stability !== undefined) ? opts.stability : 0.5;
  const similarityBoost = (opts && opts.similarityBoost !== undefined) ? opts.similarityBoost : 0.75;
  const timeout = (opts && opts.timeout !== undefined) ? opts.timeout : TIMEOUT_MS;

  const client = getHttpClient();
  try {
    const url = ELEVENLABS_API_BASE + '/' + voiceId;
    const body = {
      text,
      model_id: modelId,
      voice_settings: { stability, similarity_boost: similarityBoost },
    };
    const buffer = await client.post(url, body, { apiKey, timeout });
    if (!Buffer.isBuffer(buffer)) throw new Error('respuesta invalida de ElevenLabs (no es Buffer)');
    console.log('[AUDIO_SYNTH] sintetizado text.len=' + text.length + ' voice=' + voiceId.substring(0, 8) + ' bytes=' + buffer.length);
    return { buffer, voiceId, modelId, format: 'mp3' };
  } catch (e) {
    console.error('[AUDIO_SYNTH] Error sintetizando: ' + e.message);
    throw e;
  }
}

/**
 * Obtiene el voiceId configurado para un owner desde Firestore.
 * Retorna DEFAULT_VOICE_ID si no esta configurado.
 */
async function getOwnerVoiceId(uid, db) {
  if (!uid) throw new Error('uid requerido');
  if (!db) throw new Error('db requerido');
  try {
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return DEFAULT_VOICE_ID;
    const data = snap.data();
    const stored = data && data.miiaVoiceId;
    if (stored && AVAILABLE_VOICE_IDS.includes(stored)) return stored;
    return DEFAULT_VOICE_ID;
  } catch (e) {
    console.error('[AUDIO_SYNTH] Error leyendo voiceId uid=' + uid.substring(0, 8) + ': ' + e.message);
    return DEFAULT_VOICE_ID;
  }
}

/**
 * Guarda el voiceId preferido del owner en Firestore.
 */
async function setOwnerVoiceId(uid, voiceId, db) {
  if (!uid) throw new Error('uid requerido');
  if (!voiceId || !AVAILABLE_VOICE_IDS.includes(voiceId)) throw new Error('voiceId invalido');
  if (!db) throw new Error('db requerido');
  try {
    await db.collection('users').doc(uid).set({ miiaVoiceId: voiceId }, { merge: true });
    console.log('[AUDIO_SYNTH] voiceId actualizado uid=' + uid.substring(0, 8) + ' voice=' + voiceId.substring(0, 8));
  } catch (e) {
    console.error('[AUDIO_SYNTH] Error guardando voiceId uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  }
}

async function _defaultPost(url, body, opts) {
  const controller = new AbortController();
  let timer;
  try {
    timer = setTimeout(() => controller.abort(), opts.timeout);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': opts.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const err = await response.text().catch(() => 'unknown');
      throw new Error('ElevenLabs API error ' + response.status + ': ' + err.substring(0, 200));
    }
    const arrayBuf = await response.arrayBuffer();
    return Buffer.from(arrayBuf);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  synthesizeAudio, getOwnerVoiceId, setOwnerVoiceId,
  AVAILABLE_VOICE_IDS, DEFAULT_VOICE_ID, MAX_TEXT_LENGTH, DEFAULT_MODEL,
  __setHttpClientForTests,
};
