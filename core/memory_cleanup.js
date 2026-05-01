'use strict';

/**
 * MIIA — Memory Cleanup (T130)
 * Limpieza de memorias MMC: elimina entradas bajo score minimo o mas antiguas que maxAgeDays.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

const CLEANUP_DEFAULTS = Object.freeze({
  minScore: 0.05,       // eliminar memorias con score <= minScore
  maxAgeDays: 365,      // eliminar memorias mas viejas que esto
  maxMemoriesPerContact: 100, // si hay mas de esto, eliminar las de menor score
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Determina si una memoria debe eliminarse.
 * @param {object} memory - { importanceScore, timestamp }
 * @param {{ minScore, maxAgeDays }} opts
 * @param {number} nowMs
 * @returns {boolean}
 */
function shouldDelete(memory, { minScore = CLEANUP_DEFAULTS.minScore, maxAgeDays = CLEANUP_DEFAULTS.maxAgeDays } = {}, nowMs = Date.now()) {
  if (typeof memory.importanceScore === 'number' && memory.importanceScore <= minScore) return true;
  if (typeof memory.timestamp === 'number') {
    const ageDays = (nowMs - memory.timestamp) / MS_PER_DAY;
    if (ageDays > maxAgeDays) return true;
  }
  return false;
}

/**
 * Limpia las memorias de un contacto especifico.
 * @param {string} uid
 * @param {string} phone
 * @param {object} opts
 * @returns {Promise<{ deleted: number, kept: number }>}
 */
async function cleanupContactMemories(uid, phone, opts = {}) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!phone || typeof phone !== 'string') throw new Error('phone requerido');

  const minScore = opts.minScore ?? CLEANUP_DEFAULTS.minScore;
  const maxAgeDays = opts.maxAgeDays ?? CLEANUP_DEFAULTS.maxAgeDays;
  const maxMemoriesPerContact = opts.maxMemoriesPerContact ?? CLEANUP_DEFAULTS.maxMemoriesPerContact;
  const nowMs = opts._nowMs || Date.now();

  try {
    const snap = await db().collection('users').doc(uid).collection('mmc').doc(phone).get();
    if (!snap.exists) return { deleted: 0, kept: 0 };

    const data = snap.data();
    const memories = Array.isArray(data.memories) ? data.memories : [];

    // Filtrar memorias a eliminar
    let surviving = memories.filter(m => !shouldDelete(m, { minScore, maxAgeDays }, nowMs));

    // Si sigue habiendo demasiadas, eliminar las de menor score
    if (surviving.length > maxMemoriesPerContact) {
      surviving.sort((a, b) => (b.importanceScore || 0) - (a.importanceScore || 0));
      surviving = surviving.slice(0, maxMemoriesPerContact);
    }

    const deleted = memories.length - surviving.length;
    if (deleted > 0) {
      await db().collection('users').doc(uid).collection('mmc').doc(phone).set(
        { memories: surviving },
        { merge: true }
      );
      console.log(`[MEMORY-CLEANUP] uid=${uid.substring(0,8)} phone=${phone.slice(-4)} deleted=${deleted} kept=${surviving.length}`);
    }
    return { deleted, kept: surviving.length };
  } catch (e) {
    console.error(`[MEMORY-CLEANUP] Error uid=${uid.substring(0,8)} phone=${phone}: ${e.message}`);
    return { deleted: 0, kept: 0, error: e.message };
  }
}

/**
 * Limpia memorias de todos los contactos de un owner.
 * @param {string} uid
 * @param {object} opts
 * @returns {Promise<{ processedContacts, totalDeleted }>}
 */
async function cleanupOwnerMemories(uid, opts = {}) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('users').doc(uid).collection('mmc').get();
    let processedContacts = 0;
    let totalDeleted = 0;
    for (const doc of snap.docs) {
      const result = await cleanupContactMemories(uid, doc.id, opts);
      processedContacts++;
      totalDeleted += result.deleted || 0;
    }
    console.log(`[MEMORY-CLEANUP] Owner uid=${uid.substring(0,8)}: processed=${processedContacts} deleted=${totalDeleted}`);
    return { processedContacts, totalDeleted };
  } catch (e) {
    console.error(`[MEMORY-CLEANUP] Error owner uid=${uid.substring(0,8)}: ${e.message}`);
    return { processedContacts: 0, totalDeleted: 0, error: e.message };
  }
}

module.exports = {
  cleanupContactMemories,
  cleanupOwnerMemories,
  shouldDelete,
  CLEANUP_DEFAULTS,
  MS_PER_DAY,
  __setFirestoreForTests,
};
