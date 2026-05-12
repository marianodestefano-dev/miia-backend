'use strict';

/**
 * P1.2 — Privacy Report MMC (ROADMAP_POST_C398 P1.2).
 *
 * Agregador de lo que MIIA recuerda del owner por categoria, para alimentar
 * los endpoints /api/privacy/* y el Dashboard Privacidad.
 *
 * Schema fuente:
 *   - users/{uid}/miia_memory/{episodeId} (CAPA 2)
 *   - users/{uid}/brain/memory_graduated (CAPA 3)
 *   - users/{uid}/miia_baseline/personal
 *
 * Funciones:
 *   - getMyMmcData(uid): resumen agregado por categoria
 *   - exportMmc(uid): JSON GDPR-compliant completo
 *   - deleteMmcCategory(uid, category): borrado por categoria
 */

const VALID_CATEGORIES = Object.freeze([
  'episodios',
  'lessons',
  'graduadas',
  'baseline',
  'preferencias',
  'tonada',
  'all',
]);

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _memoryCol(uid) {
  return db().collection('users').doc(uid).collection('miia_memory');
}
function _brainDoc(uid) {
  return db().collection('users').doc(uid).collection('brain').doc('memory_graduated');
}
function _baselineDoc(uid) {
  return db().collection('users').doc(uid).collection('miia_baseline').doc('personal');
}

// ── getMyMmcData ──────────────────────────────────────────────────────────────
/**
 * Resumen agregado para mostrar al owner: cuantos episodios, cuantas lecciones,
 * cuantas graduadas, tonada actual, etc.
 *
 * @param {string} uid
 * @returns {Promise<{episodios, lessons, graduadas, baseline, generatedAt}>}
 */
async function getMyMmcData(uid) {
  if (!uid) throw new Error('uid_requerido');

  const [memSnap, brainSnap, baselineSnap] = await Promise.all([
    _memoryCol(uid).get(),
    _brainDoc(uid).get(),
    _baselineDoc(uid).get(),
  ]);

  const episodios = [];
  let totalLessons = 0;
  let totalContradicted = 0;
  let totalDeleted = 0;

  /* istanbul ignore next */
  for (const doc of (memSnap.docs || [])) {
    const ep = doc.data();
    const lecciones = Array.isArray(ep.lecciones) ? ep.lecciones : [];
    for (const l of lecciones) {
      totalLessons++;
      if (l.contradicted) totalContradicted++;
      if (l.deletedByOwnerAt) totalDeleted++;
    }
    episodios.push({
      episodeId: ep.episodeId || doc.id,
      startedAt: ep.startedAt || null,
      endedAt: ep.endedAt || null,
      topic: ep.topic || null,
      summary: ep.summary || null,
      tono: ep.tono || null,
      tonadaDetectada: ep.tonadaDetectada || null,
      lessonsCount: lecciones.length,
      status: ep.status || 'open',
      deletedByOwnerAt: ep.deletedByOwnerAt || null,
    });
  }

  const graduadas = brainSnap.exists ? (brainSnap.data().items || []) : [];
  const baseline = baselineSnap.exists ? baselineSnap.data() : null;

  return {
    uid,
    summary: {
      totalEpisodios: episodios.length,
      totalLessons,
      totalContradicted,
      totalDeletedByOwner: totalDeleted,
      totalGraduadas: graduadas.length,
      bootstrapComplete: !!(baseline && baseline.bootstrapComplete),
      tonadaRegional: (baseline && baseline.tonadaRegional) || 'neutro',
      adaptacionActiva: !!(baseline && baseline.adaptacionActiva),
    },
    episodios,
    graduadas,
    baseline: baseline ? {
      idiomaBase: baseline.idiomaBase || 'es',
      tonadaRegional: baseline.tonadaRegional || 'neutro',
      tonadaConfidence: baseline.tonadaConfidence || 'low',
      adaptacionActiva: !!baseline.adaptacionActiva,
      bootstrapComplete: !!baseline.bootstrapComplete,
      mensajesAnalizados: baseline.mensajesAnalizados || 0,
      palabrasConfianza: baseline.palabrasConfianza || [],
    } : null,
    generatedAt: new Date().toISOString(),
  };
}

// ── exportMmc ────────────────────────────────────────────────────────────────
/**
 * Export JSON GDPR-compliant completo. Incluye TODO lo que MIIA tiene del owner.
 * @param {string} uid
 * @returns {Promise<object>}
 */
async function exportMmc(uid) {
  if (!uid) throw new Error('uid_requerido');

  const [memSnap, brainSnap, baselineSnap] = await Promise.all([
    _memoryCol(uid).get(),
    _brainDoc(uid).get(),
    _baselineDoc(uid).get(),
  ]);

  /* istanbul ignore next */
  const docsArr = memSnap.docs || [];
  const episodios = docsArr.map(function (doc) {
    return { ...doc.data(), episodeId: doc.data().episodeId || doc.id };
  });
  const graduadas = brainSnap.exists ? (brainSnap.data().items || []) : [];
  const baseline = baselineSnap.exists ? baselineSnap.data() : null;

  return {
    uid,
    exportFormat: 'gdpr_v1',
    exportedAt: new Date().toISOString(),
    episodios,
    graduadas,
    baseline,
    disclaimer: 'Este export contiene todos los datos de memoria episodica que MIIA mantiene sobre tu cuenta. Para borrar parte o todo, usa /api/privacy/delete-mmc-category.',
  };
}

// ── deleteMmcCategory ────────────────────────────────────────────────────────
/**
 * Borra por categoria. Soft-delete inmediato + audit log.
 * Categorias:
 *   'all'         -> soft-delete TODO (episodios + graduadas + baseline reset)
 *   'episodios'   -> soft-delete todos los episodios
 *   'lessons'     -> soft-delete todas las lessons (por-episodio)
 *   'graduadas'   -> limpia chunk memory_graduated
 *   'baseline'    -> reset baseline a defaults
 *   'preferencias' -> reset campos de baseline conductuales
 *   'tonada'      -> reset tonada a neutro
 *
 * @param {string} uid
 * @param {string} category
 * @returns {Promise<{deleted, category}>}
 */
async function deleteMmcCategory(uid, category) {
  if (!uid) throw new Error('uid_requerido');
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error('category_invalido: ' + category);
  }
  const now = new Date().toISOString();
  let deletedCount = 0;

  if (category === 'episodios' || category === 'all') {
    const snap = await _memoryCol(uid).get();
    /* istanbul ignore next */
    for (const doc of (snap.docs || [])) {
      await doc.ref.set({
        deletedByOwnerAt: now,
        deletionReason: 'privacy_dashboard_category_' + category,
      }, { merge: true });
      deletedCount++;
    }
  }

  if (category === 'lessons') {
    const snap = await _memoryCol(uid).get();
    /* istanbul ignore next */
    for (const doc of (snap.docs || [])) {
      const ep = doc.data();
      const lecciones = Array.isArray(ep.lecciones) ? ep.lecciones.slice() : [];
      let modified = false;
      for (const l of lecciones) {
        if (!l.deletedByOwnerAt) {
          l.deletedByOwnerAt = now;
          modified = true;
          deletedCount++;
        }
      }
      if (modified) {
        await doc.ref.set({ lecciones }, { merge: true });
      }
    }
  }

  if (category === 'graduadas' || category === 'all') {
    await _brainDoc(uid).set({ items: [], clearedByOwnerAt: now }, { merge: true });
  }

  if (category === 'baseline' || category === 'all') {
    await _baselineDoc(uid).set({
      bootstrapComplete: false,
      mensajesAnalizados: 0,
      palabrasConfianza: [],
      tonadaRegional: 'neutro',
      adaptacionActiva: false,
      tonadaConfidence: 'low',
      resetByOwnerAt: now,
    }, { merge: true });
  }

  if (category === 'preferencias') {
    await _baselineDoc(uid).set({
      intensidadLenguaje: 5,
      toleranciaBully: 5,
      tonoPreferido: [],
      horariosEnergia: { madrugada: 0, manana: 0, tarde: 0, noche: 0 },
      frecuenciaDisculpa: 0,
      latenciaMediaRespuesta: 0,
      palabrasConfianza: [],
      duracionSesionTipica: 0,
      preferenciasResetByOwnerAt: now,
    }, { merge: true });
  }

  if (category === 'tonada') {
    await _baselineDoc(uid).set({
      tonadaRegional: 'neutro',
      tonadaConfidence: 'low',
      adaptacionActiva: false,
      tonadaResetByOwnerAt: now,
    }, { merge: true });
  }

  console.log('[PRIVACY] uid=' + uid.slice(0, 8) + ' category=' + category + ' deleted=' + deletedCount);
  return { ok: true, deleted: deletedCount, category };
}

module.exports = {
  getMyMmcData,
  exportMmc,
  deleteMmcCategory,
  VALID_CATEGORIES,
  __setFirestoreForTests,
};
