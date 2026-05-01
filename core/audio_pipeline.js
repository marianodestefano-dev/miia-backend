'use strict';

/**
 * MIIA — Audio Pipeline (T159)
 * Orquesta transcripcion + deteccion de idioma + sintesis de respuesta.
 * Garantiza que MIIA responde en el mismo idioma del audio recibido.
 */

let _transcriber = null;
let _synthesizer = null;
function __setTranscriberForTests(t) { _transcriber = t; }
function __setSynthesizerForTests(s) { _synthesizer = s; }

function getTranscriber() {
  if (_transcriber) return _transcriber;
  return require('./audio_processor');
}
function getSynthesizer() {
  if (_synthesizer) return _synthesizer;
  return require('./audio_synthesizer');
}

const SUPPORTED_LANGUAGES = Object.freeze(['es', 'en', 'pt']);
const DEFAULT_LANGUAGE = 'es';

/**
 * Transcribe un audio y detecta el idioma del hablante.
 * @param {Buffer} buffer
 * @param {object} [opts] - { apiKey, format, timeout }
 * @returns {Promise<{language, transcript, confidence}>}
 */
async function detectAudioLanguage(buffer, opts) {
  if (!buffer || !Buffer.isBuffer(buffer)) throw new Error('buffer requerido (Buffer)');

  const transcriber = getTranscriber();
  const transcription = await transcriber.transcribeAudio(buffer, opts);
  const text = transcription.text || '';

  const detectedLang = transcriber.detectLanguageFromText(text);
  const confidence = _computeConfidence(text, detectedLang);

  const language = SUPPORTED_LANGUAGES.includes(detectedLang) ? detectedLang : DEFAULT_LANGUAGE;
  console.log('[AUDIO_PIPELINE] idioma detectado=' + language + ' confidence=' + confidence + ' chars=' + text.length);

  return { language, transcript: text, confidence };
}

/**
 * Construye respuesta de audio en el mismo idioma del audio original.
 * @param {string} textResponse - texto a sintetizar
 * @param {string} language - idioma detectado ('es'|'en'|'pt')
 * @param {object} [opts] - { voiceId, apiKey, timeout }
 * @returns {Promise<{buffer, language, voiceId, format}>}
 */
async function buildAudioResponse(textResponse, language, opts) {
  if (!textResponse || typeof textResponse !== 'string') throw new Error('textResponse requerido');
  if (!language || typeof language !== 'string') throw new Error('language requerido');

  const lang = SUPPORTED_LANGUAGES.includes(language) ? language : DEFAULT_LANGUAGE;
  const synthesizer = getSynthesizer();

  const result = await synthesizer.synthesizeAudio(textResponse, opts);
  console.log('[AUDIO_PIPELINE] respuesta sintetizada lang=' + lang + ' bytes=' + result.buffer.length);

  return { buffer: result.buffer, language: lang, voiceId: result.voiceId, format: result.format };
}

/**
 * Pipeline completo: recibe audio -> transcribe -> detecta idioma -> sintetiza respuesta.
 * @param {Buffer} inputBuffer - audio del usuario
 * @param {string} textResponse - texto generado por MIIA para responder
 * @param {object} [opts] - { apiKey, voiceId, format, timeout }
 * @returns {Promise<{transcript, language, confidence, responseBuffer, voiceId, format}>}
 */
async function processVoiceMessage(inputBuffer, textResponse, opts) {
  if (!inputBuffer || !Buffer.isBuffer(inputBuffer)) throw new Error('inputBuffer requerido (Buffer)');
  if (!textResponse || typeof textResponse !== 'string') throw new Error('textResponse requerido');

  const { language, transcript, confidence } = await detectAudioLanguage(inputBuffer, opts);
  const response = await buildAudioResponse(textResponse, language, opts);

  return {
    transcript,
    language,
    confidence,
    responseBuffer: response.buffer,
    voiceId: response.voiceId,
    format: response.format,
  };
}

function _computeConfidence(text, lang) {
  if (!text || lang === 'unknown') return 0;
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  if (words === 0) return 0;
  if (words >= 10) return 0.9;
  if (words >= 5) return 0.7;
  return 0.5;
}

module.exports = {
  detectAudioLanguage, buildAudioResponse, processVoiceMessage,
  SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE,
  __setTranscriberForTests, __setSynthesizerForTests,
};
