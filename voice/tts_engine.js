/**
 * TTS Engine — Text-to-Speech para MIIA
 *
 * Proveedores soportados:
 * - Google Cloud TTS (default, ~$4/1M chars, 0.5-1s latencia)
 * - OpenAI TTS (voices: alloy, echo, fable, onyx, nova, shimmer)
 * - ElevenLabs (voice cloning, $5-22/mes)
 *
 * Standard: Google + Amazon + APPLE + NASA (fail loudly, exhaustive logging)
 *
 * Voces recomendadas para MIIA:
 * - Google: es-US-Studio-O (femenina, cálida) o es-US-Wavenet-A
 * - OpenAI: "nova" (femenina, natural)
 * - ElevenLabs: custom clone del owner para leads
 *
 * Formato de salida: OGG/OPUS (requerido por WhatsApp/Baileys para ptt=true)
 */

'use strict';

const GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
const ELEVENLABS_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

// Cache de configuración de voz por owner
const voiceConfigCache = {};

/**
 * Generar audio TTS a partir de texto.
 * @param {string} text - Texto a convertir
 * @param {Object} config - Configuración de voz
 * @param {string} config.provider - 'google' | 'openai' | 'elevenlabs'
 * @param {string} config.apiKey - API key del proveedor
 * @param {string} config.voiceId - ID de voz (depende del proveedor)
 * @param {string} config.language - Código idioma (default: 'es-US')
 * @param {number} config.speed - Velocidad (0.5-2.0, default: 1.0)
 * @param {string} config.mode - 'ninera' | 'adult' | 'lead' (afecta pitch y velocidad)
 * @returns {Promise<{buffer: Buffer, mimetype: string, durationEstMs: number}>}
 */
async function generateTTS(text, config = {}) {
  const provider = config.provider || 'google';
  const startTime = Date.now();

  console.log(`[TTS] 🎤 Generando audio (${provider}) | ${text.length} chars | modo: ${config.mode || 'adult'}`);

  if (!text || text.length < 2) {
    throw new Error('[TTS] Texto vacío o demasiado corto');
  }

  // Límite de texto para TTS (evitar audios larguísimos)
  const MAX_TTS_CHARS = 500;
  if (text.length > MAX_TTS_CHARS) {
    console.warn(`[TTS] ⚠️ Texto truncado de ${text.length} a ${MAX_TTS_CHARS} chars`);
    text = text.substring(0, MAX_TTS_CHARS);
  }

  let result;
  switch (provider) {
    case 'google':
      result = await _googleTTS(text, config);
      break;
    case 'openai':
      result = await _openaiTTS(text, config);
      break;
    case 'elevenlabs':
      result = await _elevenlabsTTS(text, config);
      break;
    default:
      throw new Error(`[TTS] Proveedor desconocido: ${provider}`);
  }

  const elapsed = Date.now() - startTime;
  console.log(`[TTS] ✅ Audio generado en ${elapsed}ms | ${result.buffer.length} bytes | ~${result.durationEstMs}ms`);

  return result;
}

// ═══════════════════════════════════════════════════════════════════
// GOOGLE CLOUD TTS
// ═══════════════════════════════════════════════════════════════════
async function _googleTTS(text, config) {
  const apiKey = config.apiKey || process.env.GOOGLE_TTS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('[TTS-GOOGLE] API key no configurada (GOOGLE_TTS_API_KEY)');

  const language = config.language || 'es-US';
  let voiceName = config.voiceId || 'es-US-Studio-O'; // Femenina, cálida
  let pitch = 0;
  let speakingRate = config.speed || 1.0;

  // Ajustes por modo
  if (config.mode === 'ninera') {
    pitch = 2.0;          // Más agudo para niños
    speakingRate = 0.85;  // Más lento para que entiendan
    voiceName = config.voiceId || 'es-US-Studio-O';
  } else if (config.mode === 'cuento') {
    pitch = 1.0;
    speakingRate = 0.8;   // Lento y dramático para cuentos
  }

  const payload = {
    input: { text },
    voice: {
      languageCode: language,
      name: voiceName,
    },
    audioConfig: {
      audioEncoding: 'OGG_OPUS',
      pitch,
      speakingRate,
      effectsProfileId: ['handset-class-device'], // Optimizado para celular
    }
  };

  const url = `${GOOGLE_TTS_URL}?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`[TTS-GOOGLE] Error ${response.status}: ${err.substring(0, 300)}`);
  }

  const data = await response.json();
  if (!data.audioContent) {
    throw new Error('[TTS-GOOGLE] Respuesta sin audioContent');
  }

  const buffer = Buffer.from(data.audioContent, 'base64');
  // Estimación de duración: ~150 palabras/min hablando normal
  const words = text.split(/\s+/).length;
  const durationEstMs = Math.round((words / 150) * 60 * 1000 / speakingRate);

  return {
    buffer,
    mimetype: 'audio/ogg; codecs=opus',
    durationEstMs,
  };
}

// ═══════════════════════════════════════════════════════════════════
// OPENAI TTS
// ═══════════════════════════════════════════════════════════════════
async function _openaiTTS(text, config) {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('[TTS-OPENAI] API key no configurada (OPENAI_API_KEY)');

  const voice = config.voiceId || 'nova'; // Femenina, natural
  const speed = config.speed || 1.0;

  const payload = {
    model: 'tts-1',
    input: text,
    voice,
    speed,
    response_format: 'opus',
  };

  const response = await fetch(OPENAI_TTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`[TTS-OPENAI] Error ${response.status}: ${err.substring(0, 300)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const words = text.split(/\s+/).length;
  const durationEstMs = Math.round((words / 150) * 60 * 1000 / speed);

  return {
    buffer,
    mimetype: 'audio/ogg; codecs=opus',
    durationEstMs,
  };
}

// ═══════════════════════════════════════════════════════════════════
// ELEVENLABS TTS (con voice cloning)
// ═══════════════════════════════════════════════════════════════════
async function _elevenlabsTTS(text, config) {
  const apiKey = config.apiKey || process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('[TTS-ELEVENLABS] API key no configurada (ELEVENLABS_API_KEY)');

  const voiceId = config.voiceId;
  if (!voiceId) throw new Error('[TTS-ELEVENLABS] voiceId requerido');

  const payload = {
    text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: config.mode === 'ninera' ? 0.8 : 0.5, // Más expresivo para niños
    }
  };

  const url = `${ELEVENLABS_TTS_URL}/${voiceId}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`[TTS-ELEVENLABS] Error ${response.status}: ${err.substring(0, 300)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const words = text.split(/\s+/).length;
  const durationEstMs = Math.round((words / 150) * 60 * 1000);

  return {
    buffer,
    mimetype: 'audio/mpeg',
    durationEstMs,
  };
}

// ═══════════════════════════════════════════════════════════════════
// CONFIGURACIÓN DE VOZ
// ═══════════════════════════════════════════════════════════════════

/**
 * Cargar configuración de voz del owner desde Firestore.
 * @param {Object} admin - Firebase admin
 * @param {string} ownerUid
 * @returns {Object|null}
 */
async function loadVoiceConfig(admin, ownerUid) {
  // Cache de 5 min
  const cached = voiceConfigCache[ownerUid];
  if (cached && Date.now() - cached.ts < 300000) return cached.data;

  try {
    const doc = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('settings').doc('voice')
      .get();

    const data = doc.exists ? doc.data() : null;
    voiceConfigCache[ownerUid] = { data, ts: Date.now() };
    return data;
  } catch (e) {
    console.error('[TTS] Error cargando voice config:', e.message);
    return cached?.data || null;
  }
}

/**
 * ¿El owner tiene TTS habilitado?
 */
async function isVoiceEnabled(admin, ownerUid) {
  const config = await loadVoiceConfig(admin, ownerUid);
  return config?.voice_enabled === true;
}

/**
 * Decidir si MIIA debe responder con audio.
 * @param {Object} ctx - { voiceConfig, incomingWasAudio, contactType, messageLength, mode }
 * @returns {boolean}
 */
function shouldRespondWithAudio(ctx) {
  if (!ctx.voiceConfig?.voice_enabled) return false;

  const mode = ctx.voiceConfig.voice_mode || 'keywords';

  switch (mode) {
    case 'auto':
      // Responder audio si: entrante fue audio, o mensaje es corto y emocional
      if (ctx.incomingWasAudio) return true;
      if (ctx.messageLength > 200) return false; // Audios largos cansan
      return false;

    case 'keywords':
      // Solo responder audio si el entrante fue audio
      return ctx.incomingWasAudio === true;

    case 'always':
      // Siempre audio (excepto mensajes muy largos)
      return ctx.messageLength <= 300;

    case 'manual':
      // Solo cuando el prompt genera [ENVIAR_AUDIO]
      return false;

    default:
      return false;
  }
}

/**
 * Enviar respuesta como audio por WhatsApp (Baileys ptt).
 * @param {Function} safeSendMessage - Función de envío seguro
 * @param {string} target - JID del destinatario
 * @param {Buffer} audioBuffer - Buffer del audio
 * @param {string} mimetype - MIME type del audio
 * @param {Object} options - { isSelfChat, caption }
 */
async function sendAudioMessage(safeSendMessage, target, audioBuffer, mimetype, options = {}) {
  console.log(`[TTS] 📤 Enviando audio a ${target} | ${audioBuffer.length} bytes`);

  // Baileys requiere { audio: Buffer, mimetype, ptt: true } para nota de voz
  const content = {
    data: audioBuffer.toString('base64'),
    mimetype: mimetype || 'audio/ogg; codecs=opus',
  };

  return await safeSendMessage(target, content, {
    ...options,
    sendAudioAsVoice: true,
    skipEmoji: true, // Audio no lleva emoji prefix
  });
}

module.exports = {
  generateTTS,
  loadVoiceConfig,
  isVoiceEnabled,
  shouldRespondWithAudio,
  sendAudioMessage,
};
