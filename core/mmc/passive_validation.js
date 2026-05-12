'use strict';

/**
 * MMC — Validacion pasiva (spec 13 v0.3 §Validacion pasiva).
 *
 * 4 estados:
 *   HIT       sin correccion en 3 turnos          +1
 *   REFUERZO  regex multi-dialecto positivo       +2
 *   MISS      regex multi-dialecto negativo       -1
 *   SILENCIO  sesion termino sin feedback          0
 *
 * Regex unificado multi-dialecto ES (cubre neutro, argentina, colombia, mexico).
 * Log por inyeccion: users/{uid}/miia_memory/{episodeId}/injections/{injectionId}.
 * Resolucion en batch (despues de 3 turnos o cierre de sesion).
 *
 * Ajuste automatico de umbral coseno (batch mensual):
 *   precision = (HIT*1 + REFUERZO*2) / (HIT*1 + REFUERZO*2 + MISS*1)
 *   < 0.7 -> umbral +0.02
 *   > 0.9 -> umbral -0.02
 *   piso 0.75, techo 0.92, default 0.82
 */

const STATES = Object.freeze({ HIT: 'HIT', REFUERZO: 'REFUERZO', MISS: 'MISS', SILENCIO: 'SILENCIO' });
const WEIGHTS = Object.freeze({ HIT: 1, REFUERZO: 2, MISS: -1, SILENCIO: 0 });

// Regex spec 13 v0.3 §Validacion pasiva (unificado ES)
const REFUERZO_REGEX = /^(si|sí|exacto|eso es|justo|tal cual|claro|así es|asi es|dale|posta|obvio|obvia|correcto|correctamente|chévere|chevere|bacano|listo|órale|orale|eso|neta|así|ahi va|ahí va|perfecto)/i;
const MISS_REGEX = /^(no|mal|eso no|de qué habl|de que habl|no fue así|no fue asi|cuándo dije|cuando dije|nada que ver|qué decís|que decis|no entendiste|estás equivocad|estas equivocad|te equivocás|te equivocas|no es así|no es asi|cómo así|como asi|no man|nel)/i;

const COS_THRESHOLD_DEFAULT = 0.82;
const COS_THRESHOLD_MIN = 0.75;
const COS_THRESHOLD_MAX = 0.92;
const COS_ADJUST_STEP = 0.02;
const PRECISION_LOW = 0.7;
const PRECISION_HIGH = 0.9;

const RESOLVE_AFTER_TURNS = 3;
const RESOLVE_AFTER_SESSION_END_MS = 30 * 60 * 1000; // 30min sin actividad = sesion termino

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _injectionsCol(uid, episodeId) {
  return db().collection('users').doc(uid)
    .collection('miia_memory').doc(episodeId)
    .collection('injections');
}

function _baselineDoc(uid) {
  return db().collection('users').doc(uid).collection('miia_baseline').doc('personal');
}

/**
 * Clasifica una respuesta del owner como HIT / REFUERZO / MISS / SILENCIO.
 * @param {string|null} ownerReply - respuesta del owner posterior a la inyeccion
 * @param {number} turnsSinceInjection - cuantos turnos pasaron sin correccion
 * @param {boolean} sessionEnded - true si la sesion ya termino
 * @returns {string} STATES.*
 */
function classifyFeedback(ownerReply, turnsSinceInjection, sessionEnded) {
  if (sessionEnded && !ownerReply) return STATES.SILENCIO;
  if (!ownerReply || typeof ownerReply !== 'string') {
    return sessionEnded ? STATES.SILENCIO : STATES.HIT;
  }
  const trimmed = ownerReply.trim();
  if (REFUERZO_REGEX.test(trimmed)) return STATES.REFUERZO;
  if (MISS_REGEX.test(trimmed)) return STATES.MISS;
  if (typeof turnsSinceInjection === 'number' && turnsSinceInjection >= RESOLVE_AFTER_TURNS) {
    return STATES.HIT;
  }
  return STATES.HIT;
}

/**
 * Registra una inyeccion pendiente (antes de saber el feedback).
 * @param {string} uid
 * @param {string} episodeId
 * @param {{ lessonId, lessonText, similarityScore, threshold }} payload
 * @returns {Promise<{injectionId}>}
 */
async function logInjection(uid, episodeId, payload) {
  if (!uid) throw new Error('uid_requerido');
  if (!episodeId) throw new Error('episodeId_requerido');
  if (!payload || !payload.lessonId) throw new Error('lessonId_requerido');
  const injectionId = 'inj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const record = {
    injectionId,
    lessonId: payload.lessonId,
    lessonText: payload.lessonText || '',
    similarityScore: typeof payload.similarityScore === 'number' ? payload.similarityScore : 0,
    threshold: typeof payload.threshold === 'number' ? payload.threshold : COS_THRESHOLD_DEFAULT,
    feedbackState: null, // pending
    resolved: false,
    createdAt: new Date().toISOString(),
  };
  await _injectionsCol(uid, episodeId).doc(injectionId).set(record);
  return { injectionId };
}

/**
 * Resuelve una inyeccion pendiente con el feedback observado.
 */
async function resolveInjection(uid, episodeId, injectionId, feedbackState) {
  if (!uid || !episodeId || !injectionId) throw new Error('parametros_requeridos');
  if (!Object.values(STATES).includes(feedbackState)) {
    throw new Error('feedbackState_invalido: ' + feedbackState);
  }
  await _injectionsCol(uid, episodeId).doc(injectionId).set({
    feedbackState,
    weight: WEIGHTS[feedbackState],
    resolved: true,
    resolvedAt: new Date().toISOString(),
  }, { merge: true });
  return { ok: true, weight: WEIGHTS[feedbackState] };
}

/**
 * Lee inyecciones resueltas del owner en una ventana (default ultimos 30 dias)
 * y calcula precision para ajuste de umbral.
 * @param {string} uid
 * @param {Array<object>} resolved - injections con feedbackState seteado
 * @returns {{ precision: number, total: number, hits, refuerzos, misses }}
 */
function computePrecision(resolved) {
  if (!Array.isArray(resolved) || resolved.length === 0) {
    return { precision: 0, total: 0, hits: 0, refuerzos: 0, misses: 0 };
  }
  let hits = 0, refuerzos = 0, misses = 0;
  for (const r of resolved) {
    if (r.feedbackState === STATES.HIT) hits++;
    else if (r.feedbackState === STATES.REFUERZO) refuerzos++;
    else if (r.feedbackState === STATES.MISS) misses++;
  }
  const positiveWeight = hits * 1 + refuerzos * 2;
  const totalWeight = positiveWeight + misses * 1;
  const precision = totalWeight > 0 ? positiveWeight / totalWeight : 0;
  return { precision, total: resolved.length, hits, refuerzos, misses };
}

/**
 * Calcula el nuevo umbral coseno segun precision observada.
 * @param {number} currentThreshold
 * @param {number} precision
 * @returns {number}
 */
function computeNewThreshold(currentThreshold, precision) {
  const cur = typeof currentThreshold === 'number' ? currentThreshold : COS_THRESHOLD_DEFAULT;
  if (typeof precision !== 'number' || precision < 0 || precision > 1) return cur;
  let newT = cur;
  if (precision < PRECISION_LOW) newT = cur + COS_ADJUST_STEP;
  else if (precision > PRECISION_HIGH) newT = cur - COS_ADJUST_STEP;
  // Clamp piso/techo
  if (newT < COS_THRESHOLD_MIN) newT = COS_THRESHOLD_MIN;
  if (newT > COS_THRESHOLD_MAX) newT = COS_THRESHOLD_MAX;
  return Math.round(newT * 100) / 100;
}

/**
 * Obtiene el umbral coseno actual del owner (persistido en baseline).
 */
async function getCosThreshold(uid) {
  if (!uid) throw new Error('uid_requerido');
  const snap = await _baselineDoc(uid).get();
  if (!snap.exists) return COS_THRESHOLD_DEFAULT;
  const data = snap.data();
  return typeof data.cosThreshold === 'number' ? data.cosThreshold : COS_THRESHOLD_DEFAULT;
}

/**
 * Actualiza el umbral coseno del owner en baseline.
 */
async function setCosThreshold(uid, threshold) {
  if (!uid) throw new Error('uid_requerido');
  if (typeof threshold !== 'number') throw new Error('threshold_invalido');
  await _baselineDoc(uid).set({
    cosThreshold: threshold,
    cosThresholdUpdatedAt: new Date().toISOString(),
  }, { merge: true });
  return { ok: true, threshold };
}

module.exports = {
  classifyFeedback,
  logInjection,
  resolveInjection,
  computePrecision,
  computeNewThreshold,
  getCosThreshold,
  setCosThreshold,
  REFUERZO_REGEX,
  MISS_REGEX,
  STATES,
  WEIGHTS,
  COS_THRESHOLD_DEFAULT,
  COS_THRESHOLD_MIN,
  COS_THRESHOLD_MAX,
  COS_ADJUST_STEP,
  PRECISION_LOW,
  PRECISION_HIGH,
  RESOLVE_AFTER_TURNS,
  RESOLVE_AFTER_SESSION_END_MS,
  __setFirestoreForTests,
};
