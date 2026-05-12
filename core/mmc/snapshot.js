'use strict';

/**
 * MMC — Snapshot diario + TTL 48h (spec 13 v0.3 FASE 0 NIGHTLY-BRAIN + R-SPEC-3 Vi).
 *
 * Path canonico: users/{uid}/miia_snapshots/{YYYY-MM-DD}
 *
 * Funcion:
 *   - writeDailySnapshot(uid, conversations) -> guarda conversations[phone]
 *     COMPLETO (no .slice). NIGHTLY-BRAIN lo lee y luego cleanup.
 *   - cleanupOldSnapshots(uid) -> hard-delete snapshots > TTL_MS de antiguedad.
 *
 * TTL 48h como safety net si NIGHTLY-BRAIN falla una noche (spec).
 */

const TTL_MS = 48 * 60 * 60 * 1000;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _snapshotsCol(uid) {
  return db().collection('users').doc(uid).collection('miia_snapshots');
}

function _dateId(timestampMs) {
  const d = typeof timestampMs === 'number' ? new Date(timestampMs) : new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Escribe el snapshot diario.
 * @param {string} uid
 * @param {object} conversations - estructura conversations[phone] COMPLETO
 * @param {object} [opts] - { timestamp, mensajesAnalizados }
 * @returns {Promise<{snapshotId, contactsCount, totalMessages}>}
 */
async function writeDailySnapshot(uid, conversations, opts) {
  if (!uid) throw new Error('uid_requerido');
  if (!conversations || typeof conversations !== 'object') {
    throw new Error('conversations_invalido');
  }
  const o = opts || {};
  const dateId = _dateId(o.timestamp);
  const phones = Object.keys(conversations);
  let totalMessages = 0;
  for (const phone of phones) {
    const conv = conversations[phone];
    const history = (conv && Array.isArray(conv.history)) ? conv.history : [];
    totalMessages += history.length;
  }
  const payload = {
    snapshotId: dateId,
    uid,
    conversations,
    contactsCount: phones.length,
    totalMessages,
    mensajesAnalizados: typeof o.mensajesAnalizados === 'number' ? o.mensajesAnalizados : totalMessages,
    createdAt: new Date(typeof o.timestamp === 'number' ? o.timestamp : Date.now()).toISOString(),
    ttlMs: TTL_MS,
  };
  await _snapshotsCol(uid).doc(dateId).set(payload);
  console.log('[SNAPSHOT] uid=' + uid.slice(0, 8) + ' date=' + dateId +
    ' contacts=' + phones.length + ' msgs=' + totalMessages);
  return { snapshotId: dateId, contactsCount: phones.length, totalMessages };
}

/**
 * Lee el snapshot del dia dado.
 */
async function getSnapshot(uid, dateId) {
  if (!uid) throw new Error('uid_requerido');
  const snap = await _snapshotsCol(uid).doc(dateId).get();
  if (!snap.exists) return null;
  return snap.data();
}

/**
 * Hard-delete snapshots con antiguedad > TTL_MS.
 * @param {string} uid
 * @param {object} [opts] - { nowMs } para tests
 * @returns {Promise<{eliminados: number}>}
 */
async function cleanupOldSnapshots(uid, opts) {
  if (!uid) throw new Error('uid_requerido');
  const o = opts || {};
  const now = typeof o.nowMs === 'number' ? o.nowMs : Date.now();
  const snap = await _snapshotsCol(uid).get();
  let eliminados = 0;
  for (const doc of (snap.docs || [])) {
    const data = doc.data();
    const createdAt = data.createdAt ? new Date(data.createdAt).getTime() : 0;
    if (createdAt > 0 && (now - createdAt) > TTL_MS) {
      await doc.ref.delete();
      eliminados++;
    }
  }
  if (eliminados > 0) {
    console.log('[SNAPSHOT] cleanup uid=' + uid.slice(0, 8) + ' eliminados=' + eliminados);
  }
  return { eliminados };
}

module.exports = {
  writeDailySnapshot,
  getSnapshot,
  cleanupOldSnapshots,
  TTL_MS,
  __setFirestoreForTests,
};
