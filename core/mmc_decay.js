'use strict';

/**
 * MIIA — MMC Decay (T100)
 * Memorias de mas de 90 dias: importanceScore *= 0.95 por dia de antiguedad
 * mas alla del umbral. setInterval cada 24h. No decaer scores < MIN_FLOOR.
 */

const admin = require('firebase-admin');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || admin.firestore(); }

const DECAY_THRESHOLD_DAYS = 90;
const DECAY_RATE = 0.95;        // factor por dia de antiguedad extra
const MIN_FLOOR = 0.05;         // score minimo, no decaer por debajo
const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DECAY_THRESHOLD_MS = DECAY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

const { assignImportanceScore } = require('./mmc_retrieval');

/**
 * Aplica decay a una lista de memorias segun su timestamp.
 * @param {Array<object>} memories - cada memoria puede tener timestamp y importanceScore
 * @param {number} [nowMs] - timestamp actual (para tests)
 * @returns {Array<object>} memorias con importanceScore actualizado
 */
function applyDecay(memories, nowMs = Date.now()) {
  if (!Array.isArray(memories)) return [];

  return memories.map(m => {
    const ts = typeof m.timestamp === 'number' ? m.timestamp : null;
    if (ts === null) return m; // sin timestamp, no decaer

    const ageMs = nowMs - ts;
    if (ageMs <= DECAY_THRESHOLD_MS) return m; // no llego al umbral

    const baseScore = assignImportanceScore(m);
    const extraDays = Math.floor((ageMs - DECAY_THRESHOLD_MS) / (24 * 60 * 60 * 1000));
    const decayed = baseScore * Math.pow(DECAY_RATE, extraDays);
    const finalScore = Math.max(MIN_FLOOR, decayed);

    console.log(`[MMC-DECAY] memory type=${m.type||'?'} age=${Math.floor(ageMs/86400000)}d score: ${baseScore.toFixed(3)} -> ${finalScore.toFixed(3)}`);
    return { ...m, importanceScore: finalScore };
  });
}

/**
 * Ejecuta decay sobre TODAS las memorias de un owner en Firestore.
 * Lee cada doc en users/{uid}/mmc/, aplica decay, escribe de vuelta.
 * @param {string} uid
 * @param {number} [nowMs]
 * @returns {Promise<{ processed: number, updated: number, errors: number }>}
 */
async function runDecayForOwner(uid, nowMs = Date.now()) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  let processed = 0, updated = 0, errors = 0;

  try {
    const mmcRef = db().collection('users').doc(uid).collection('mmc');
    const snapshot = await mmcRef.get();

    for (const doc of snapshot.docs) {
      processed++;
      try {
        const data = doc.data();
        const entries = Array.isArray(data.entries) ? data.entries : [];
        const decayed = applyDecay(entries, nowMs);
        // Solo escribir si hubo cambios
        const changed = decayed.some((m, i) => m.importanceScore !== (entries[i] ? entries[i].importanceScore : undefined));
        if (changed) {
          await doc.ref.update({ entries: decayed });
          updated++;
          console.log(`[MMC-DECAY] doc ${doc.id} updated (${entries.length} entries)`);
        }
      } catch (e) {
        errors++;
        console.warn(`[MMC-DECAY] Error procesando doc ${doc.id}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn(`[MMC-DECAY] Error leyendo mmc de uid=${uid.substring(0,8)}: ${e.message}`);
    errors++;
  }

  console.log(`[MMC-DECAY] uid=${uid.substring(0,8)} processed=${processed} updated=${updated} errors=${errors}`);
  return { processed, updated, errors };
}

/**
 * Inicia el cron de decay que corre cada 24h para todos los owners activos.
 * @param {Function} getActiveUids - () => Promise<string[]>
 * @returns {{ stop: Function }} handle para parar el cron en tests
 */
function startDecayCron(getActiveUids) {
  const runCycle = async () => {
    console.log('[MMC-DECAY] Iniciando ciclo de decay diario');
    let uids = [];
    try { uids = await getActiveUids(); } catch (e) {
      console.warn(`[MMC-DECAY] Error obteniendo UIDs activos: ${e.message}`);
      return;
    }
    for (const uid of uids) {
      try { await runDecayForOwner(uid); }
      catch (e) { console.warn(`[MMC-DECAY] Error en decay para uid=${uid.substring(0,8)}: ${e.message}`); }
    }
    console.log(`[MMC-DECAY] Ciclo completado para ${uids.length} owners`);
  };

  const handle = setInterval(runCycle, DECAY_INTERVAL_MS);
  return { stop: () => clearInterval(handle) };
}

module.exports = {
  applyDecay, runDecayForOwner, startDecayCron,
  DECAY_THRESHOLD_DAYS, DECAY_RATE, MIN_FLOOR,
  __setFirestoreForTests,
};
