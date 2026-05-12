'use strict';

/**
 * R16-B — mod_onboarding.js (IDEA #019 + #022 + #024)
 * Onboarding socrático 6 fases + gamificación Bronze→Silver→Gold→Diamond.
 */

const FASES = Object.freeze({
  DESCUBRIMIENTO: 1,
  CARGA_MATERIAL: 2,
  PREGUNTAS_ADAPTATIVAS: 3,
  DETECCION_GRISES: 4,
  CERTIFICACION: 5,
  APRENDIZAJE_PASIVO: 6,
});

const PREGUNTAS_FASE1 = Object.freeze([
  '¿Qué tipo de negocio tenés?',
  '¿Cómo se llaman tus mejores clientes?',
  '¿Cuál es la pregunta que más te hacen?',
  '¿Cómo describirías tu estilo de comunicación?',
  '¿Qué es lo que NO querés que MIIA haga NUNCA?',
]);

const NIVELES = Object.freeze(['Bronze', 'Silver', 'Gold', 'Diamond']);
const CERTIFICATION_PASS_SCORE = 8;
const CERTIFICATION_TOTAL = 10;
const TOTAL_FASES = 6;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _isValidFase(n) {
  return Number.isInteger(n) && n >= 1 && n <= TOTAL_FASES;
}

function _faseDoc(uid, fase) {
  return db().collection('owners').doc(uid).collection('onboarding').doc('fase' + fase);
}

function _gamDoc(uid) {
  return db().collection('owners').doc(uid).collection('gamification').doc('status');
}

async function _otorgarNivel(uid, nivel, scoreIncremento) {
  try {
    const snap = await _gamDoc(uid).get();
    const prev = snap.exists ? snap.data() : {};
    const prevLogros = Array.isArray(prev.logros) ? prev.logros : [];
    const logros = prevLogros.includes(nivel) ? prevLogros : [...prevLogros, nivel];
    await _gamDoc(uid).set({
      nivel,
      score: (prev.score || 0) + scoreIncremento,
      racha_dias: prev.racha_dias || 0,
      logros,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    console.log('[MOD-ONBOARDING] nivel otorgado uid=' + uid.slice(0, 8) + ' nivel=' + nivel);
  } catch (e) {
    console.error('[MOD-ONBOARDING] _otorgarNivel error:', e.message);
  }
}

/**
 * Inicia o retoma el onboarding del owner.
 * @param {string} uid
 * @returns {{ fase: number, siguientePregunta: string|null, completado: boolean }}
 */
async function startOnboarding(uid) {
  if (!uid) throw new Error('uid_requerido');
  const status = await getOnboardingStatus(uid);
  if (status.completado) return { fase: TOTAL_FASES, siguientePregunta: null, completado: true };
  const fase = status.fase_actual || 1;
  if (fase === 1) {
    const snap = await _faseDoc(uid, 1).get();
    if (!snap.exists) {
      await _faseDoc(uid, 1).set({
        fase: 1, respuestas: [], iniciadoAt: new Date().toISOString(), completado: false,
      });
    }
    const data = snap.exists ? snap.data() : {};
    const prevRespuestas = Array.isArray(data.respuestas) ? data.respuestas : [];
    const idx = prevRespuestas.length;
    if (idx >= PREGUNTAS_FASE1.length) return { fase: 1, siguientePregunta: null, completado: false };
    return { fase: 1, siguientePregunta: PREGUNTAS_FASE1[idx], completado: false };
  }
  return { fase, siguientePregunta: null, completado: false };
}

/**
 * Procesa la respuesta del owner a la pregunta de la fase activa.
 * @param {string} uid
 * @param {number} fase
 * @param {string} respuesta
 * @returns {{ siguiente: string|null, completado: boolean, fase: number }}
 */
async function processAnswer(uid, fase, respuesta) {
  if (!uid) throw new Error('uid_requerido');
  if (!_isValidFase(fase)) throw new Error('fase_invalida');
  if (!respuesta || typeof respuesta !== 'string' || !respuesta.trim()) throw new Error('respuesta_requerida');

  if (fase === 1) {
    const snap = await _faseDoc(uid, 1).get();
    const prevData = snap.exists ? snap.data() : {};
    const prevRespuestas = Array.isArray(prevData.respuestas) ? prevData.respuestas : [];
    const prevCompletadoAt = prevData.completadoAt || null;
    const respuestas = [...prevRespuestas, respuesta.trim()];
    const completado = respuestas.length >= PREGUNTAS_FASE1.length;
    await _faseDoc(uid, 1).set({
      fase: 1,
      respuestas,
      completado,
      completadoAt: completado ? new Date().toISOString() : prevCompletadoAt,
    }, { merge: true });
    if (completado) {
      console.log('[MOD-ONBOARDING] fase1 completada uid=' + uid.slice(0, 8));
      return { siguiente: null, completado: true, fase: 1 };
    }
    return { siguiente: PREGUNTAS_FASE1[respuestas.length], completado: false, fase: 1 };
  }

  if (fase === 5) {
    const score = parseInt(respuesta, 10) || 0;
    const aprobado = score >= CERTIFICATION_PASS_SCORE;
    await _faseDoc(uid, 5).set({
      fase: 5, score, aprobado, completado: true, completadoAt: new Date().toISOString(),
    }, { merge: true });
    if (aprobado) await _otorgarNivel(uid, 'Bronze', score * 10);
    console.log('[MOD-ONBOARDING] fase5 uid=' + uid.slice(0, 8) + ' score=' + score + ' aprobado=' + aprobado);
    return { siguiente: null, completado: true, fase: 5 };
  }

  const snap = await _faseDoc(uid, fase).get();
  const prevData = snap.exists ? snap.data() : {};
  const prevRespuestas = Array.isArray(prevData.respuestas) ? prevData.respuestas : [];
  const respuestas = [...prevRespuestas, respuesta.trim()];
  await _faseDoc(uid, fase).set({
    fase, respuestas, completado: false, updatedAt: new Date().toISOString(),
  }, { merge: true });
  return { siguiente: null, completado: false, fase };
}

/**
 * Retorna el estado actual del onboarding.
 * @param {string} uid
 * @returns {{ fase_actual: number, progreso_pct: number, completado: boolean, gamification: object|null }}
 */
async function getOnboardingStatus(uid) {
  if (!uid) return { fase_actual: 0, progreso_pct: 0, completado: false, gamification: null };
  try {
    let faseActual = 1;
    let completado = false;
    for (let f = 1; f <= TOTAL_FASES; f++) {
      const snap = await _faseDoc(uid, f).get();
      if (!snap.exists) { faseActual = f; break; }
      const data = snap.data();
      if (!data.completado) { faseActual = f; break; }
      if (f === TOTAL_FASES) { faseActual = TOTAL_FASES; completado = true; }
    }
    const progreso_pct = completado ? 100 : Math.round(((faseActual - 1) / TOTAL_FASES) * 100);
    let gamification = null;
    try {
      const gSnap = await _gamDoc(uid).get();
      gamification = gSnap.exists ? gSnap.data() : null;
    } catch (_) { /* non-critical */ }
    return { fase_actual: faseActual, progreso_pct, completado, gamification };
  } catch (e) {
    console.error('[MOD-ONBOARDING] getOnboardingStatus error:', e.message);
    return { fase_actual: 0, progreso_pct: 0, completado: false, gamification: null };
  }
}

module.exports = {
  startOnboarding,
  processAnswer,
  getOnboardingStatus,
  FASES,
  PREGUNTAS_FASE1,
  NIVELES,
  CERTIFICATION_PASS_SCORE,
  CERTIFICATION_TOTAL,
  __setFirestoreForTests,
};
