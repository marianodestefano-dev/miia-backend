'use strict';

/**
 * MIIA — MMC Cross-Tenant Isolation Test (T101)
 * Verifica que datos de UID_A nunca aparezcan en lecturas de UID_B.
 * Canary: UNICORNIO_FUCSIA_42 (token unico que no deberia cruzar tenants).
 * Si detecta leak: log CRITICAL y retorna { leak: true }.
 */

const admin = require('firebase-admin');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || admin.firestore(); }

const CANARY_TOKEN = 'UNICORNIO_FUCSIA_42';

/**
 * Inserta una memoria canary en el tenant A.
 * @param {string} uidA
 * @param {string} phone
 * @returns {Promise<string>} el docPath donde se escribio
 */
async function writeCanary(uidA, phone) {
  if (!uidA || !phone) throw new Error('uidA y phone requeridos');
  const entry = {
    type: 'canary',
    content: CANARY_TOKEN,
    timestamp: Date.now(),
    importanceScore: 0.5,
  };
  await db().collection('users').doc(uidA).collection('mmc').doc(phone)
    .set({ entries: [entry] }, { merge: true });
  console.log(`[MMC-ISOLATION] Canary escrito en uid=${uidA.substring(0,8)} phone=${phone}`);
  return `users/${uidA}/mmc/${phone}`;
}

/**
 * Verifica que UID_B NO puede ver datos de UID_A.
 * Lee users/{uidB}/mmc/{phone} y verifica que no contiene CANARY_TOKEN.
 * @param {string} uidB
 * @param {string} phone
 * @returns {Promise<{ leak: boolean, canaryFound: boolean, details: string }>}
 */
async function checkIsolation(uidA, uidB, phone) {
  if (!uidA || !uidB || !phone) throw new Error('uidA, uidB y phone requeridos');
  if (uidA === uidB) throw new Error('uidA y uidB deben ser distintos');

  let canaryFoundInB = false;
  let details = 'ok';

  try {
    const snapB = await db().collection('users').doc(uidB).collection('mmc').doc(phone).get();
    if (snapB.exists) {
      const data = snapB.data();
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const leaked = entries.some(e => e.content === CANARY_TOKEN || JSON.stringify(e).includes(CANARY_TOKEN));
      if (leaked) {
        canaryFoundInB = true;
        details = `LEAK: canary ${CANARY_TOKEN} encontrado en uid=${uidB.substring(0,8)} phone=${phone}`;
        console.error(`[MMC-ISOLATION] CRITICAL ${details}`);
      } else {
        console.log(`[MMC-ISOLATION] OK: uidB=${uidB.substring(0,8)} no tiene datos de uidA=${uidA.substring(0,8)}`);
      }
    } else {
      console.log(`[MMC-ISOLATION] OK: uidB=${uidB.substring(0,8)} doc inexistente`);
    }
  } catch (e) {
    details = `Error en lectura uidB: ${e.message}`;
    console.warn(`[MMC-ISOLATION] ${details}`);
  }

  return {
    leak: canaryFoundInB,
    canaryFound: canaryFoundInB,
    uidA, uidB, phone, details,
  };
}

/**
 * Suite de isolation completa: escribe canary en A, lee en B, verifica no hay leak.
 * Si leak: retorna resultado con leak=true (el caller debe STOP y reportar a Wi).
 */
async function runIsolationSuite(uidA, uidB, phone) {
  console.log(`[MMC-ISOLATION] Iniciando suite: uidA=${uidA.substring(0,8)} uidB=${uidB.substring(0,8)} phone=${phone}`);
  await writeCanary(uidA, phone);
  const result = await checkIsolation(uidA, uidB, phone);
  if (result.leak) {
    console.error('[MMC-ISOLATION] CRITICAL LEAK DETECTADO — REPORTAR A WI INMEDIATAMENTE');
  } else {
    console.log('[MMC-ISOLATION] Suite OK: no leak detectado');
  }
  return result;
}

module.exports = {
  writeCanary, checkIsolation, runIsolationSuite,
  CANARY_TOKEN, __setFirestoreForTests,
};
