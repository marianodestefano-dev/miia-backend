'use strict';

/**
 * MMC Capa 2 — Baseline personal del owner (spec 13 v0.3 §Baseline personal).
 * Path canonico (decision A.1): users/{uid}/miia_baseline/personal
 *
 * 16 campos (spec 13 v0.3):
 *   intensidadLenguaje, toleranciaBully, tonoPreferido[], horariosEnergia{},
 *   frecuenciaDisculpa, latenciaMediaRespuesta, palabrasConfianza[],
 *   duracionSesionTipica, idiomaBase, tonadaRegional, tonadaDetectadaAt,
 *   tonadaConfidence, adaptacionActiva, bootstrapComplete,
 *   bootstrapStartedAt, mensajesAnalizados, seededManually, updatedAt
 *
 * Reglas (spec):
 *   - bootstrapComplete=false -> mod_memory() NO inyecta cadencias
 *   - Se marca true cuando: 14d desde start OR mensajesAnalizados>=50
 *   - Baseline se actualiza en cada batch nocturno (FASE 6 NIGHTLY-BRAIN)
 *
 * Decision A.4: tonadasRegionales soportadas v1.0: neutro, argentina, colombia, mexico.
 */

const TONADAS_SOPORTADAS = Object.freeze(['neutro', 'argentina', 'colombia', 'mexico']);
const TONADA_CONFIDENCE = Object.freeze(['low', 'medium', 'high']);
const BOOTSTRAP_DAYS = 14;
const BOOTSTRAP_MIN_MESSAGES = 50;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

// ── Firestore refs ────────────────────────────────────────────────────────────
function _baselineDoc(uid) {
  return db().collection('users').doc(uid).collection('miia_baseline').doc('personal');
}

// ── Default baseline ──────────────────────────────────────────────────────────
function _defaultBaseline(uid) {
  const now = new Date().toISOString();
  return {
    uid,
    intensidadLenguaje: 5,
    toleranciaBully: 5,
    tonoPreferido: [],
    horariosEnergia: { madrugada: 0, manana: 0, tarde: 0, noche: 0 },
    frecuenciaDisculpa: 0,
    latenciaMediaRespuesta: 0,
    palabrasConfianza: [],
    duracionSesionTipica: 0,
    idiomaBase: 'es',
    tonadaRegional: 'neutro',
    tonadaDetectadaAt: null,
    tonadaConfidence: 'low',
    adaptacionActiva: false,
    bootstrapComplete: false,
    bootstrapStartedAt: now,
    mensajesAnalizados: 0,
    seededManually: false,
    updatedAt: now,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Lee el baseline del owner. Si no existe, lo crea con defaults y retorna.
 * @param {string} uid
 * @returns {Promise<object>}
 */
async function getOrCreateBaseline(uid) {
  if (!uid) throw new Error('uid_requerido');
  const ref = _baselineDoc(uid);
  const snap = await ref.get();
  if (snap.exists) return snap.data();
  const baseline = _defaultBaseline(uid);
  await ref.set(baseline);
  console.log('[BASELINE] creado uid=' + uid.slice(0, 8));
  return baseline;
}

/**
 * Lee el baseline sin crear si no existe.
 * @param {string} uid
 * @returns {Promise<object|null>}
 */
async function getBaseline(uid) {
  if (!uid) throw new Error('uid_requerido');
  const snap = await _baselineDoc(uid).get();
  if (!snap.exists) return null;
  return snap.data();
}

/**
 * Actualiza campos del baseline (merge).
 * Valida tipos. Setea updatedAt automaticamente.
 * @param {string} uid
 * @param {object} updates
 */
async function updateBaseline(uid, updates) {
  if (!uid) throw new Error('uid_requerido');
  if (!updates || typeof updates !== 'object') throw new Error('updates_invalido');
  const payload = {};
  // Validaciones por campo (solo se incluyen los campos validos)
  if (typeof updates.intensidadLenguaje === 'number') payload.intensidadLenguaje = updates.intensidadLenguaje;
  if (typeof updates.toleranciaBully === 'number') payload.toleranciaBully = updates.toleranciaBully;
  if (Array.isArray(updates.tonoPreferido)) payload.tonoPreferido = updates.tonoPreferido;
  if (updates.horariosEnergia && typeof updates.horariosEnergia === 'object') payload.horariosEnergia = updates.horariosEnergia;
  if (typeof updates.frecuenciaDisculpa === 'number') payload.frecuenciaDisculpa = updates.frecuenciaDisculpa;
  if (typeof updates.latenciaMediaRespuesta === 'number') payload.latenciaMediaRespuesta = updates.latenciaMediaRespuesta;
  if (Array.isArray(updates.palabrasConfianza)) payload.palabrasConfianza = updates.palabrasConfianza;
  if (typeof updates.duracionSesionTipica === 'number') payload.duracionSesionTipica = updates.duracionSesionTipica;
  if (typeof updates.idiomaBase === 'string') payload.idiomaBase = updates.idiomaBase;
  if (typeof updates.tonadaRegional === 'string' && TONADAS_SOPORTADAS.includes(updates.tonadaRegional)) {
    payload.tonadaRegional = updates.tonadaRegional;
  }
  if (updates.tonadaDetectadaAt !== undefined) payload.tonadaDetectadaAt = updates.tonadaDetectadaAt;
  if (typeof updates.tonadaConfidence === 'string' && TONADA_CONFIDENCE.includes(updates.tonadaConfidence)) {
    payload.tonadaConfidence = updates.tonadaConfidence;
  }
  if (typeof updates.adaptacionActiva === 'boolean') payload.adaptacionActiva = updates.adaptacionActiva;
  if (typeof updates.bootstrapComplete === 'boolean') payload.bootstrapComplete = updates.bootstrapComplete;
  if (typeof updates.mensajesAnalizados === 'number') payload.mensajesAnalizados = updates.mensajesAnalizados;
  if (typeof updates.seededManually === 'boolean') payload.seededManually = updates.seededManually;

  payload.updatedAt = new Date().toISOString();
  await _baselineDoc(uid).set(payload, { merge: true });
  return { ok: true, updatedFields: Object.keys(payload) };
}

/**
 * Incrementa mensajesAnalizados y evalua si bootstrap deberia completarse.
 * Condiciones (spec): 14d desde bootstrapStartedAt OR mensajesAnalizados >= 50.
 * Si se completa, marca bootstrapComplete=true.
 * @param {string} uid
 * @param {number} delta - cantidad de mensajes nuevos
 * @returns {Promise<{mensajesAnalizados, bootstrapComplete, justCompleted}>}
 */
async function recordMessagesAnalyzed(uid, delta) {
  if (!uid) throw new Error('uid_requerido');
  if (typeof delta !== 'number' || delta < 0) throw new Error('delta_invalido');
  const baseline = await getOrCreateBaseline(uid);
  const newCount = (baseline.mensajesAnalizados || 0) + delta;
  const now = Date.now();
  const startedAt = baseline.bootstrapStartedAt
    ? new Date(baseline.bootstrapStartedAt).getTime()
    : now;
  const daysSince = (now - startedAt) / (24 * 60 * 60 * 1000);
  const wasComplete = !!baseline.bootstrapComplete;
  const isComplete = wasComplete || daysSince >= BOOTSTRAP_DAYS || newCount >= BOOTSTRAP_MIN_MESSAGES;
  const justCompleted = !wasComplete && isComplete;

  const updates = { mensajesAnalizados: newCount };
  if (justCompleted) updates.bootstrapComplete = true;
  await updateBaseline(uid, updates);
  if (justCompleted) console.log('[BASELINE] bootstrap completado uid=' + uid.slice(0, 8) + ' n=' + newCount);
  return { mensajesAnalizados: newCount, bootstrapComplete: isComplete, justCompleted };
}

/**
 * Activa la adaptacion de tonada si la confianza es suficiente.
 * Reglas (spec): adaptacionActiva=true requiere bootstrapComplete y
 * tonadaConfidence >= 'medium' Y tonadaRegional != 'neutro'.
 * @param {string} uid
 * @param {string} tonada - 'argentina'|'colombia'|'mexico'|'neutro'
 * @param {string} confidence - 'low'|'medium'|'high'
 */
async function setTonada(uid, tonada, confidence) {
  if (!uid) throw new Error('uid_requerido');
  if (!TONADAS_SOPORTADAS.includes(tonada)) throw new Error('tonada_invalida: ' + tonada);
  if (!TONADA_CONFIDENCE.includes(confidence)) throw new Error('confidence_invalida: ' + confidence);
  const baseline = await getOrCreateBaseline(uid);
  const isLow = confidence === 'low';
  const isNeutro = tonada === 'neutro';
  const bootstrapOk = !!baseline.bootstrapComplete;
  const adaptacionActiva = bootstrapOk && !isLow && !isNeutro;
  await updateBaseline(uid, {
    tonadaRegional: tonada,
    tonadaConfidence: confidence,
    tonadaDetectadaAt: new Date().toISOString(),
    adaptacionActiva,
  });
  return { ok: true, adaptacionActiva, tonada, confidence };
}

/**
 * Kill-switch: owner pidio neutro -> apaga adaptacion permanentemente
 * hasta que owner la reactive.
 */
async function disableTonadaAdaptation(uid) {
  if (!uid) throw new Error('uid_requerido');
  await updateBaseline(uid, {
    adaptacionActiva: false,
    tonadaRegional: 'neutro',
  });
  console.log('[BASELINE] tonada apagada uid=' + uid.slice(0, 8));
  return { ok: true };
}

/**
 * Bootstrap pre-cumplido para MIIA CENTER (spec): si ya hay 50+ mensajes
 * analizados, marca bootstrapComplete retroactivo.
 */
async function tryRetroactiveBootstrapComplete(uid) {
  if (!uid) throw new Error('uid_requerido');
  const baseline = await getBaseline(uid);
  if (!baseline) return { applied: false, reason: 'baseline_inexistente' };
  if (baseline.bootstrapComplete) return { applied: false, reason: 'ya_complete' };
  if ((baseline.mensajesAnalizados || 0) >= BOOTSTRAP_MIN_MESSAGES) {
    await updateBaseline(uid, { bootstrapComplete: true });
    console.log('[BASELINE] bootstrap retroactivo uid=' + uid.slice(0, 8));
    return { applied: true };
  }
  return { applied: false, reason: 'insuficientes_mensajes' };
}

module.exports = {
  getOrCreateBaseline,
  getBaseline,
  updateBaseline,
  recordMessagesAnalyzed,
  setTonada,
  disableTonadaAdaptation,
  tryRetroactiveBootstrapComplete,
  TONADAS_SOPORTADAS,
  TONADA_CONFIDENCE,
  BOOTSTRAP_DAYS,
  BOOTSTRAP_MIN_MESSAGES,
  __setFirestoreForTests,
};
