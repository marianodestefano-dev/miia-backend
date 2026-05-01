'use strict';

/**
 * MIIA — TTS Request Builder (T141)
 * Construye payloads para ElevenLabs TTS segun el tipo de contacto.
 * Voice IDs mapeados por persona/modo.
 */

// Voice IDs de ElevenLabs (9 voces configuradas)
const VOICE_MAP = Object.freeze({
  default: 'pNInz6obpgDQGcFmaJgB',      // Adam
  owner_selfchat: 'ErXwobaYiN019PkySvjV', // Antoni
  lead: 'VR6AewLTigWG4xSOukaG',          // Arnold
  client: 'pNInz6obpgDQGcFmaJgB',        // Adam
  miia_lead: 'yoZ06aMxZJJ28mfd3POQ',     // Sam
  miia_client: 'yoZ06aMxZJJ28mfd3POQ',   // Sam
  family: 'onwK4e9ZLuTAKqWW03F9',        // Daniel
  professional: 'GBv7mTt0atIp3Br8iCZE',  // Thomas
  energetic: 'oWAxZDx7w5VEj9dCyTzz',     // Grace
});

const TTS_DEFAULTS = Object.freeze({
  model_id: 'eleven_multilingual_v2',
  output_format: 'mp3_44100_128',
  voice_settings: {
    stability: 0.5,
    similarity_boost: 0.8,
    style: 0.0,
    use_speaker_boost: true,
  },
});

const MAX_TEXT_LENGTH = 5000;

/**
 * Obtiene el voice ID para un modo de persona.
 * @param {string} [mode] - 'lead', 'client', 'family', etc.
 * @returns {string} voice ID
 */
function getVoiceId(mode) {
  return VOICE_MAP[mode] || VOICE_MAP.default;
}

/**
 * Construye el payload para la API de ElevenLabs.
 * @param {string} text
 * @param {object} opts
 * @param {string} [opts.mode] - persona mode
 * @param {string} [opts.voiceId] - override voice ID
 * @param {object} [opts.voiceSettings] - override settings
 * @returns {{ voiceId: string, payload: object, textLength: number }}
 */
function buildTTSRequest(text, opts = {}) {
  if (!text || typeof text !== 'string') throw new Error('text requerido');
  if (text.trim().length === 0) throw new Error('text no puede ser vacio');

  const truncated = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
  const voiceId = opts.voiceId || getVoiceId(opts.mode);

  const voiceSettings = opts.voiceSettings
    ? { ...TTS_DEFAULTS.voice_settings, ...opts.voiceSettings }
    : { ...TTS_DEFAULTS.voice_settings };

  const payload = {
    text: truncated,
    model_id: opts.model_id || TTS_DEFAULTS.model_id,
    output_format: opts.output_format || TTS_DEFAULTS.output_format,
    voice_settings: voiceSettings,
  };

  return {
    voiceId,
    payload,
    textLength: truncated.length,
    wasTruncated: text.length > MAX_TEXT_LENGTH,
  };
}

/**
 * Construye la URL del endpoint de ElevenLabs.
 */
function buildTTSUrl(voiceId, baseUrl = 'https://api.elevenlabs.io/v1') {
  if (!voiceId) throw new Error('voiceId requerido');
  return `${baseUrl}/text-to-speech/${voiceId}`;
}

module.exports = {
  buildTTSRequest,
  buildTTSUrl,
  getVoiceId,
  VOICE_MAP,
  TTS_DEFAULTS,
  MAX_TEXT_LENGTH,
};
