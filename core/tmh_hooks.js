'use strict';

/**
 * #2 + #3 Hooks para TMH (firma Mariano 2026-05-12)
 *
 * Helpers que encapsulan logica de Owner Voice + forget pipeline para que
 * TMH (tenant_message_handler.js) los invoque con cambios MINIMOS (4-6 lineas).
 * Esto reduce blast radius en zona critica WhatsApp §5 CLAUDE.md.
 *
 * Integracion en TMH (snippet documentado, pendiente edicion inline con
 * protocolo zona critica):
 *
 *   const tmhHooks = require('../core/tmh_hooks');
 *
 *   // 1. Antes de llamar Gemini, detectar forget intent
 *   const forgetResult = await tmhHooks.maybeHandleForget(uid, lead.text);
 *   if (forgetResult.handled) {
 *     // Borrado ya ejecutado. Inyectar mensaje + responder corto.
 *     await sock.sendMessage(jid, { text: 'Listo, ya me olvide 🤷‍♀️' });
 *     return;
 *   }
 *
 *   // 2. Si lead es nuevo + contexto detectado, enviar audio del owner
 *   const audioResult = await tmhHooks.maybeSendOwnerVoice(uid, detectedContext, leadIsNew);
 *   if (audioResult.shouldSend) {
 *     await sock.sendMessage(jid, { audio: { url: audioResult.audio.fileUrl }, mimetype: 'audio/mp4' });
 *     // No retornar: continuar pipeline normal con respuesta de texto.
 *   }
 *
 * ETAPA 1 §2-bis: estos helpers se activan SOLO para MIIA CENTER (UID
 * A5pMESWlfmPWCoCPRbwy85EzUzy2). UIDs distintos retornan no-op silencioso.
 */

const forgetPipeline = require('./mmc/forget_pipeline');
const ownerVoiceLib = require('./owner_voice_library');

const MIIA_CENTER_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';

// Guard ETAPA 1 forget pipeline: solo MIIA CENTER por default.
function _isEligibleUid(uid) {
  if (!uid) return false;
  if (process.env.TMH_HOOKS_ALL_UIDS === 'true') return true;
  return uid === MIIA_CENTER_UID;
}

// Guard Owner Voice (firma Mariano 2026-05-12 ~22:00 COT):
//   "MIIA CENTER NO DEBE ENVIAR AUDIOS DE MI!!! JAMAS"
// -> MIIA CENTER NO es elegible para Owner Voice. Cualquier otro owner SI.
// Flag MIIA_OWNER_VOICE_ENABLED=1 requerido para activar (default OFF).
function _isEligibleForOwnerVoice(uid) {
  if (!uid) return false;
  if (process.env.MIIA_OWNER_VOICE_ENABLED !== '1') return false;
  if (uid === MIIA_CENTER_UID) return false; // Regla dura firma Mariano.
  return true;
}

/**
 * #3 — Si el lead es nuevo + el contexto detectado tiene audio registrado
 * del owner, retorna { shouldSend, audio } para que TMH lo envie via Baileys.
 *
 * @param {string} uid
 * @param {string} context  Uno de owner_voice_library.VALID_CONTEXTS.
 * @param {boolean} leadIsNew
 * @returns {Promise<{shouldSend, audio}>}
 */
async function maybeSendOwnerVoice(uid, context, leadIsNew) {
  if (!_isEligibleForOwnerVoice(uid)) return { shouldSend: false, audio: null };
  try {
    return await ownerVoiceLib.shouldSendAudio(uid, context, leadIsNew);
  } catch (e) {
    /* istanbul ignore next */
    console.warn('[TMH-HOOKS] maybeSendOwnerVoice error: ' + e.message);
    return { shouldSend: false, audio: null };
  }
}

/**
 * Detecta si el lead cuestiona si MIIA es IA + si owner tiene audio para
 * el contexto LEAD_CUESTIONA_IA, retorna { shouldSend, audio }.
 *
 * Guard: NO MIIA CENTER (firma Mariano 2026-05-12). MIIA_OWNER_VOICE_ENABLED=1 requerido.
 *
 * @param {string} uid
 * @param {string} leadMessage
 * @returns {Promise<{shouldSend, audio}>}
 */
async function maybeSendVoiceOnIAQuestion(uid, leadMessage) {
  if (!_isEligibleForOwnerVoice(uid)) return { shouldSend: false, audio: null };
  if (!leadMessage || typeof leadMessage !== 'string') {
    return { shouldSend: false, audio: null };
  }
  if (!ownerVoiceLib.detectLeadQuestionsIA(leadMessage)) {
    return { shouldSend: false, audio: null };
  }
  try {
    // Para este trigger, leadIsNew se considera true (el cuestionamiento "soy IA?"
    // tipicamente viene del lead en sus primeros mensajes).
    const ctx = ownerVoiceLib.CONTEXTS.LEAD_CUESTIONA_IA;
    return await ownerVoiceLib.shouldSendAudio(uid, ctx, true);
  } catch (e) {
    /* istanbul ignore next */
    console.warn('[TMH-HOOKS] maybeSendVoiceOnIAQuestion error: ' + e.message);
    return { shouldSend: false, audio: null };
  }
}

/**
 * #2 — Si el mensaje del owner matchea FORGET_PATTERNS, ejecuta soft-delete
 * semantico + retorna { handled, summary }. TMH debe interceptar ANTES de
 * llamar al LLM.
 *
 * @param {string} uid
 * @param {string} ownerMessage
 * @returns {Promise<{handled, summary, injectionText}>}
 */
async function maybeHandleForget(uid, ownerMessage) {
  if (!_isEligibleUid(uid)) return { handled: false, summary: null, injectionText: '' };
  if (!ownerMessage || typeof ownerMessage !== 'string') {
    return { handled: false, summary: null, injectionText: '' };
  }
  const intent = forgetPipeline.detectForgetIntent(ownerMessage);
  if (!intent.match) return { handled: false, summary: null, injectionText: '' };
  try {
    const result = await forgetPipeline.executeForget(uid, ownerMessage);
    const injectionText = forgetPipeline.buildForgetInjection(result);
    return {
      handled: true,
      summary: {
        episodiosBorrados: result.episodiosBorrados || 0,
        lessonsBorradas: result.lessonsBorradas || 0,
        noEmbedding: !!result.noEmbedding,
      },
      injectionText,
    };
  } catch (e) {
    /* istanbul ignore next */
    console.warn('[TMH-HOOKS] maybeHandleForget error: ' + e.message);
    return { handled: false, summary: null, injectionText: '' };
  }
}

/**
 * Helper para tests: simular qué UID es elegible.
 */
function _isEligibleUidForTests(uid) {
  return _isEligibleUid(uid);
}

function _isEligibleForOwnerVoiceForTests(uid) {
  return _isEligibleForOwnerVoice(uid);
}

module.exports = {
  maybeSendOwnerVoice,
  maybeSendVoiceOnIAQuestion,
  maybeHandleForget,
  _isEligibleUidForTests,
  _isEligibleForOwnerVoiceForTests,
  MIIA_CENTER_UID,
};
