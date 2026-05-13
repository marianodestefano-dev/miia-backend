'use strict';

/**
 * EXTRA #5 — Owner Voice Library (P3.3 ROADMAP).
 *
 * Owner graba audios reales con su voz para contextos pre-definidos
 * (saludo inicial, estoy manejando, plan basico, agradecimiento post-cierre).
 * MIIA los envia como respuesta cuando detecta contexto coincidente y el lead
 * es nuevo. Lead escucha la voz REAL del owner, no TTS.
 *
 * Schema Firestore: owners/{uid}/voice_audios/{context}
 *   { context, fileUrl, transcript, durationSec, uploadedAt, active }
 *
 * Funciones:
 *   - listAvailableContexts(): retorna contextos predefinidos disponibles.
 *   - registerAudio(uid, context, fileUrl, transcript, durationSec): persiste.
 *   - getAudiosForOwner(uid): devuelve audios activos del owner.
 *   - getAudioForContext(uid, context): retorna audio especifico o null.
 *   - deactivateAudio(uid, context): soft-delete (no borra storage).
 *   - shouldSendAudio(uid, context, leadIsNew): decide si TMH envia audio.
 */

// Contextos pre-definidos spec (Wi mail 2026-05-12).
const CONTEXTS = Object.freeze({
  SALUDO_INICIAL: 'saludo_inicial_calido',
  ESTOY_MANEJANDO: 'estoy_manejando',
  EXPLICACION_PLAN_BASICO: 'explicacion_plan_basico',
  AGRADECIMIENTO_POST_CIERRE: 'agradecimiento_post_cierre',
  // Audios Personalizados firmados Mariano 2026-05-12 (NO MIIA CENTER)
  LEAD_CUESTIONA_IA: 'lead_cuestiona_ia',
  COMPRA_CONFIRMADA: 'compra_confirmada',
  DESPEDIDA_CALIDA: 'despedida_calida',
});

const VALID_CONTEXTS = Object.freeze(Object.values(CONTEXTS));

const MAX_DURATION_SEC = 60;
const MAX_TRANSCRIPT_CHARS = 500;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

// ── Firestore refs ────────────────────────────────────────────────────────────
function _voiceAudiosCol(uid) {
  return db().collection('owners').doc(uid).collection('voice_audios');
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Lista los contextos predefinidos disponibles para grabar.
 * @returns {Array<{key, label, suggestedScript}>}
 */
function listAvailableContexts() {
  return [
    {
      key: CONTEXTS.SALUDO_INICIAL,
      label: 'Saludo inicial cálido',
      suggestedScript: 'Hola! Soy [tu nombre], gracias por escribirnos. En un momento te respondo personalmente.',
    },
    {
      key: CONTEXTS.ESTOY_MANEJANDO,
      label: 'Estoy manejando',
      suggestedScript: 'Hola, ahora estoy manejando, en un rato te llamo o te escribo. Gracias por tu paciencia.',
    },
    {
      key: CONTEXTS.EXPLICACION_PLAN_BASICO,
      label: 'Explicación plan básico',
      suggestedScript: 'Te cuento brevemente lo más importante del plan que ofrecemos. [descripcion del plan en tu voz].',
    },
    {
      key: CONTEXTS.AGRADECIMIENTO_POST_CIERRE,
      label: 'Agradecimiento post-cierre',
      suggestedScript: 'Muchas gracias por confiar en nosotros. Cualquier duda, escribime directo. Saludos!',
    },
    // Audios Personalizados firmados Mariano 2026-05-12
    {
      key: CONTEXTS.LEAD_CUESTIONA_IA,
      label: 'Lead cuestiona si es IA',
      suggestedScript: 'Hola Dr/Dra, no soy IA, soy [tu nombre]. Disculpa la demora, en este momento estoy subiendo al ascensor / en transporte. En unos minutos te respondo personalmente.',
    },
    {
      key: CONTEXTS.COMPRA_CONFIRMADA,
      label: 'Compra confirmada',
      suggestedScript: 'Confirmado! Ya quedo registrado tu pedido. Recibiras los detalles en los proximos minutos. Gracias por tu confianza.',
    },
    {
      key: CONTEXTS.DESPEDIDA_CALIDA,
      label: 'Despedida calida',
      suggestedScript: 'Gracias por escribir! Quedo atento por cualquier consulta. Que tengas excelente dia.',
    },
  ];
}

/**
 * Registra un audio del owner para un contexto especifico.
 * @param {string} uid
 * @param {string} context - debe estar en VALID_CONTEXTS
 * @param {string} fileUrl - URL del audio (ej. Firebase Storage)
 * @param {string} transcript - texto trans del audio (para fallback si MIIA debe usar texto)
 * @param {number} durationSec - duracion en segundos
 */
async function registerAudio(uid, context, fileUrl, transcript, durationSec) {
  if (!uid) throw new Error('uid_requerido');
  if (!VALID_CONTEXTS.includes(context)) {
    throw new Error('context_invalido: ' + context);
  }
  if (!fileUrl || typeof fileUrl !== 'string') throw new Error('fileUrl_requerido');
  if (typeof durationSec !== 'number' || durationSec <= 0) throw new Error('durationSec_invalido');
  if (durationSec > MAX_DURATION_SEC) {
    throw new Error('duracion_excede_max: max ' + MAX_DURATION_SEC + 's');
  }
  const safeTranscript = typeof transcript === 'string'
    ? transcript.trim().slice(0, MAX_TRANSCRIPT_CHARS)
    : '';
  const payload = {
    context,
    fileUrl,
    transcript: safeTranscript,
    durationSec,
    uploadedAt: new Date().toISOString(),
    active: true,
  };
  await _voiceAudiosCol(uid).doc(context).set(payload);
  console.log('[OWNER-VOICE] uid=' + uid.slice(0, 8) + ' context=' + context +
    ' duration=' + durationSec + 's');
  return { ok: true, ...payload };
}

/**
 * Lista los audios activos del owner.
 * @param {string} uid
 * @returns {Promise<Array<object>>}
 */
async function getAudiosForOwner(uid) {
  if (!uid) throw new Error('uid_requerido');
  const snap = await _voiceAudiosCol(uid).get();
  const items = [];
  (snap.docs || []).forEach(function (doc) {
    const data = doc.data();
    if (data.active !== false) items.push(data);
  });
  return items;
}

/**
 * Obtiene el audio del owner para un contexto especifico.
 * @param {string} uid
 * @param {string} context
 * @returns {Promise<object|null>}
 */
async function getAudioForContext(uid, context) {
  if (!uid) throw new Error('uid_requerido');
  if (!VALID_CONTEXTS.includes(context)) {
    throw new Error('context_invalido: ' + context);
  }
  const snap = await _voiceAudiosCol(uid).doc(context).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (data.active === false) return null;
  return data;
}

/**
 * Soft-delete del audio (no borra storage, solo marca inactivo).
 */
async function deactivateAudio(uid, context) {
  if (!uid) throw new Error('uid_requerido');
  if (!VALID_CONTEXTS.includes(context)) {
    throw new Error('context_invalido: ' + context);
  }
  await _voiceAudiosCol(uid).doc(context).set({
    active: false,
    deactivatedAt: new Date().toISOString(),
  }, { merge: true });
  return { ok: true };
}

/**
 * Decide si MIIA debe enviar audio para este contexto:
 *   - leadIsNew=true: SI (impacto maximo, primera impresion)
 *   - leadIsNew=false: NO (lead ya conoce al owner, audio redundante)
 *   - audio inexistente para el contexto: NO
 *
 * @param {string} uid
 * @param {string} context
 * @param {boolean} leadIsNew
 * @returns {Promise<{shouldSend, audio}>}
 */
async function shouldSendAudio(uid, context, leadIsNew) {
  if (!uid) return { shouldSend: false, audio: null };
  if (!VALID_CONTEXTS.includes(context)) return { shouldSend: false, audio: null };
  if (!leadIsNew) return { shouldSend: false, audio: null };
  const audio = await getAudioForContext(uid, context);
  if (!audio) return { shouldSend: false, audio: null };
  return { shouldSend: true, audio };
}

/**
 * Detecta si el mensaje del lead cuestiona si MIIA es una IA / bot / automatico.
 * Patrones espanol (case-insens, acentos opcionales):
 *   - "sos/eres/sois IA/bot/robot/maquina"
 *   - "esto es automatico / un bot / una maquina"
 *   - "hablo con una persona / persona real / humano"
 *   - "es un sistema / programa"
 *   - "respondes vos / responde una persona"
 *
 * @param {string} message
 * @returns {boolean}
 */
function detectLeadQuestionsIA(message) {
  if (!message || typeof message !== 'string') return false;
  const m = message.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Pattern set: estructurados por proposito
  const patterns = [
    /\b(sos|eres|sois|es|son)\s+(un[a]?\s+)?(ia|inteligencia\s+artificial|bot|robot|m[aá]quina|chatbot|sistema)\b/,
    /\besto\s+es\s+(un[a]?\s+)?(ia|bot|robot|m[aá]quina|sistema|programa|chatbot|automatico|automatizado)\b/,
    /\b(hablo|estoy\s+hablando|me\s+responde)\s+con\s+(un[a]?\s+)?(ia|bot|persona|humano|m[aá]quina|robot)\b/,
    /\b(persona|humano)\s+real\b/,
    /\b(responde|contesta|escribe)\s+(una?\s+)?(persona|humano|bot|robot)\b/,
    /\beres\s+real\b/,
    /\bes\s+autom[aá]tico\b/,
  ];
  for (const re of patterns) {
    if (re.test(m)) return true;
  }
  return false;
}

module.exports = {
  listAvailableContexts,
  detectLeadQuestionsIA,
  registerAudio,
  getAudiosForOwner,
  getAudioForContext,
  deactivateAudio,
  shouldSendAudio,
  CONTEXTS,
  VALID_CONTEXTS,
  MAX_DURATION_SEC,
  MAX_TRANSCRIPT_CHARS,
  __setFirestoreForTests,
};
