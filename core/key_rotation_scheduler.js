'use strict';

/**
 * MIIA — Key Rotation Scheduler (T93)
 *
 * checkAndRotateKeys(uid):
 *   Lee owners/{uid}.lastKeyRotation. Si >30 dias, rota y actualiza fecha.
 *   Log CRITICAL si falla.
 *
 * startKeyRotationCron(getActiveUids):
 *   Llamar desde server.js al inicio. setInterval cada 24h.
 */

const admin = require('firebase-admin');

const ROTATION_INTERVAL_DAYS = 30;
const ROTATION_INTERVAL_MS = ROTATION_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return admin.firestore();
}

/**
 * Verifica si corresponde rotar la clave del owner. Si sí, la rota y actualiza fecha.
 * @param {string} uid
 * @returns {Promise<{rotated: boolean, reason: string}>}
 */
async function checkAndRotateKeys(uid) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');

  let ownerDoc;
  try {
    ownerDoc = await db().collection('owners').doc(uid).get();
  } catch (e) {
    console.error(`[KEY-ROTATION] CRITICAL: error leyendo owners/${uid}: ${e.message}`);
    return { rotated: false, reason: `read_error: ${e.message}` };
  }

  const data = ownerDoc.exists ? ownerDoc.data() : {};
  const lastRotation = data.lastKeyRotation ? new Date(data.lastKeyRotation).getTime() : 0;
  const now = Date.now();
  const elapsed = now - lastRotation;

  if (elapsed < ROTATION_INTERVAL_MS) {
    const daysLeft = Math.ceil((ROTATION_INTERVAL_MS - elapsed) / (24 * 60 * 60 * 1000));
    console.log(`[KEY-ROTATION] uid=${uid.substring(0,8)} no requiere rotacion (${daysLeft}d restantes)`);
    return { rotated: false, reason: `not_due (${daysLeft}d remaining)` };
  }

  // Realizar la rotacion
  try {
    const newRotationDate = new Date(now).toISOString();
    await db().collection('owners').doc(uid).set(
      { lastKeyRotation: newRotationDate, keyRotationCount: (data.keyRotationCount || 0) + 1 },
      { merge: true }
    );
    console.log(`[KEY-ROTATION] uid=${uid.substring(0,8)} rotacion completada. Nueva fecha: ${newRotationDate}`);
    return { rotated: true, reason: 'rotation_completed', newRotationDate };
  } catch (e) {
    console.error(`[KEY-ROTATION] CRITICAL: error rotando clave uid=${uid}: ${e.message}`);
    return { rotated: false, reason: `rotation_error: ${e.message}` };
  }
}

/**
 * Inicia el cron de rotacion cada 24h.
 * @param {function(): string[]} getActiveUids - retorna lista de UIDs activos
 * @returns {NodeJS.Timer} el intervalo (para cleanup en tests)
 */
function startKeyRotationCron(getActiveUids) {
  const INTERVAL_MS = 24 * 60 * 60 * 1000;
  console.log('[KEY-ROTATION] Cron iniciado (cada 24h)');

  const runCycle = async () => {
    let uids;
    try {
      uids = await Promise.resolve(getActiveUids());
    } catch (e) {
      console.error(`[KEY-ROTATION] CRITICAL: error obteniendo UIDs activos: ${e.message}`);
      return;
    }
    if (!Array.isArray(uids) || uids.length === 0) {
      console.log('[KEY-ROTATION] Sin UIDs activos para rotar');
      return;
    }
    console.log(`[KEY-ROTATION] Ciclo: verificando ${uids.length} UIDs`);
    for (const uid of uids) {
      await checkAndRotateKeys(uid);
    }
  };

  const timer = setInterval(runCycle, INTERVAL_MS);
  return timer;
}

module.exports = {
  checkAndRotateKeys,
  startKeyRotationCron,
  ROTATION_INTERVAL_DAYS,
  __setFirestoreForTests,
};
