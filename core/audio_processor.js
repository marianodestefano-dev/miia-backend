'use strict';

/**
 * MIIA — Audio Processor (T157)
 * Transcripcion de mensajes de voz usando Whisper (OpenAI).
 * Soporta OGG, MP4, WEBM, WAV, MP3, M4A.
 */

let _httpClient = null;
function __setHttpClientForTests(client) { _httpClient = client; }
function getHttpClient() {
  if (_httpClient) return _httpClient;
  return { post: _defaultPost };
}

const SUPPORTED_FORMATS = Object.freeze(['ogg', 'mp4', 'webm', 'wav', 'mp3', 'm4a', 'mpeg', 'mpga']);
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const WHISPER_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_LANGUAGE = 'es';
const TIMEOUT_MS = 30000;

/**
 * Transcribe un audio buffer usando Whisper.
 * @param {Buffer} buffer - datos del audio
 * @param {object} [opts] - { format, language, apiKey, timeout }
 * @returns {Promise<{text, language, duration, format}>}
 */
async function transcribeAudio(buffer, opts) {
  if (!buffer || !Buffer.isBuffer(buffer)) throw new Error('buffer requerido (Buffer)');
  if (buffer.length === 0) throw new Error('buffer vacio');
  if (buffer.length > MAX_FILE_SIZE) throw new Error('audio demasiado grande (max 25MB)');

  const format = (opts && opts.format) || 'ogg';
  if (!SUPPORTED_FORMATS.includes(format)) throw new Error('formato no soportado: ' + format);

  const language = (opts && opts.language) || DEFAULT_LANGUAGE;
  const apiKey = (opts && opts.apiKey) || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY requerido');

  const timeout = (opts && opts.timeout !== undefined) ? opts.timeout : TIMEOUT_MS;

  const client = getHttpClient();
  try {
    const result = await client.post(WHISPER_API_URL, buffer, { format, language, apiKey, timeout });
    const text = (result && result.text) ? result.text.trim() : '';
    console.log('[AUDIO] transcripcion completada chars=' + text.length + ' lang=' + language + ' fmt=' + format);
    return {
      text,
      language,
      duration: (result && result.duration !== undefined) ? result.duration : null,
      format,
    };
  } catch (e) {
    console.error('[AUDIO] Error transcribiendo: ' + e.message);
    throw e;
  }
}

/**
 * Detecta idioma por heuristicas de palabras comunes.
 * @param {string} text
 * @returns {'es'|'en'|'pt'|'unknown'}
 */
function detectLanguageFromText(text) {
  if (!text || typeof text !== 'string') return 'unknown';
  const lower = text.toLowerCase();
  const esScore = (lower.match(/\b(el|la|los|las|es|de|en|que|un|una|por|para|con|del|al)\b/g) || []).length;
  const enScore = (lower.match(/\b(the|is|are|was|were|in|of|and|to|a|an|it|for|on|with)\b/g) || []).length;
  const ptScore = (lower.match(/\b(o|a|os|as|de|em|que|um|uma|para|com|do|da)\b/g) || []).length;
  if (esScore === 0 && enScore === 0 && ptScore === 0) return 'unknown';
  if (esScore >= enScore && esScore >= ptScore) return 'es';
  if (enScore > esScore && enScore >= ptScore) return 'en';
  return 'pt';
}

/**
 * Retorna lista mutable de formatos soportados.
 */
function getSupportedFormats() {
  return [...SUPPORTED_FORMATS];
}

async function _defaultPost(url, buffer, opts) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', buffer, { filename: 'audio.' + opts.format, contentType: 'audio/' + opts.format });
  form.append('model', 'whisper-1');
  form.append('language', opts.language);

  const controller = new AbortController();
  let timer;
  try {
    timer = setTimeout(() => controller.abort(), opts.timeout);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + opts.apiKey, ...form.getHeaders() },
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      const err = await response.text().catch(() => 'unknown');
      throw new Error('Whisper API error ' + response.status + ': ' + err.substring(0, 200));
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  transcribeAudio, detectLanguageFromText, getSupportedFormats,
  SUPPORTED_FORMATS, MAX_FILE_SIZE, DEFAULT_LANGUAGE,
  __setHttpClientForTests,
};
