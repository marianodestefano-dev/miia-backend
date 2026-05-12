'use strict';

/**
 * EXTRA #3 — Training Data Store persistente en Firestore (Wi mail 2026-05-12)
 *
 * Bug: training_data se perdia en redeploys Railway (almacenamiento efimero).
 * ADN_MARIANO_v1.0 decia "training_data: 0 chars" anulando todo lo que
 * web_scraper.js + cerebro_absoluto.js aprendian cada lunes.
 *
 * Schema Firestore: training_data/{ownerUid}/snapshots/{ts}
 *   Cada snapshot: { ts, source, country, text, gemini_summary, sizeChars }
 *
 * API:
 *   appendLearning(uid, source, country, text, summary) -> {snapshotId, sizeChars}
 *   getRecent(uid, days) -> Array de snapshots
 *   getTotalSize(uid) -> Number (total chars acumulados)
 */

const MAX_TEXT_CHARS_PER_SNAPSHOT = 50000;
const MAX_SUMMARY_CHARS = 5000;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

// ── Firestore refs ────────────────────────────────────────────────────────────
function _snapshotsCol(uid) {
  return db().collection('training_data').doc(uid).collection('snapshots');
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Persiste un nuevo snapshot de aprendizaje del scraper/mining.
 * @param {string} uid
 * @param {string} source - 'web_scraper' | 'cerebro_whatsapp' | etc.
 * @param {string} country - 'COLOMBIA' | 'MEDILINK_LATAM' | etc.
 * @param {string} text - contenido raw
 * @param {string} [summary] - resumen Gemini opcional
 * @returns {Promise<{snapshotId, sizeChars}>}
 */
async function appendLearning(uid, source, country, text, summary) {
  if (!uid) throw new Error('uid_requerido');
  if (!source) throw new Error('source_requerido');
  if (typeof text !== 'string') throw new Error('text_requerido_string');
  const ts = new Date().toISOString();
  const snapshotId = ts + '_' + Math.random().toString(36).slice(2, 8);
  const truncatedText = text.slice(0, MAX_TEXT_CHARS_PER_SNAPSHOT);
  const truncatedSummary = typeof summary === 'string'
    ? summary.slice(0, MAX_SUMMARY_CHARS)
    : null;
  const payload = {
    snapshotId,
    ts,
    source,
    country: country || null,
    text: truncatedText,
    gemini_summary: truncatedSummary,
    sizeChars: truncatedText.length,
  };
  await _snapshotsCol(uid).doc(snapshotId).set(payload);
  console.log('[TRAINING-STORE] uid=' + uid.slice(0, 8) +
    ' source=' + source + ' country=' + (country || 'null') +
    ' chars=' + truncatedText.length);
  return { snapshotId, sizeChars: truncatedText.length };
}

/**
 * Lee snapshots de los ultimos N dias del owner.
 * @param {string} uid
 * @param {number} days - default 7
 * @returns {Promise<Array<object>>}
 */
async function getRecent(uid, days) {
  if (!uid) throw new Error('uid_requerido');
  const n = typeof days === 'number' && days > 0 ? days : 7;
  const cutoff = new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const snap = await _snapshotsCol(uid).get();
  const items = [];
  (snap.docs || []).forEach(function (doc) {
    const data = doc.data();
    if (data.ts && data.ts >= cutoff) items.push(data);
  });
  /* istanbul ignore next */
  items.sort(function (a, b) { return (b.ts || '').localeCompare(a.ts || ''); });
  return items;
}

/**
 * Calcula el total de chars acumulados del owner.
 * @param {string} uid
 * @returns {Promise<number>}
 */
async function getTotalSize(uid) {
  if (!uid) throw new Error('uid_requerido');
  const snap = await _snapshotsCol(uid).get();
  let total = 0;
  (snap.docs || []).forEach(function (doc) {
    const data = doc.data();
    total += (data.sizeChars || 0);
  });
  return total;
}

/**
 * Borra snapshots antiguos (>retentionDays) para evitar bloat.
 * @param {string} uid
 * @param {number} retentionDays
 * @returns {Promise<{deleted: number}>}
 */
async function cleanupOldSnapshots(uid, retentionDays) {
  if (!uid) throw new Error('uid_requerido');
  const n = typeof retentionDays === 'number' && retentionDays > 0 ? retentionDays : 90;
  const cutoff = new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const snap = await _snapshotsCol(uid).get();
  let deleted = 0;
  for (const doc of (snap.docs || [])) {
    const data = doc.data();
    if (data.ts && data.ts < cutoff) {
      await doc.ref.delete();
      deleted++;
    }
  }
  if (deleted > 0) {
    console.log('[TRAINING-STORE] cleanup uid=' + uid.slice(0, 8) + ' deleted=' + deleted);
  }
  return { deleted };
}

module.exports = {
  appendLearning,
  getRecent,
  getTotalSize,
  cleanupOldSnapshots,
  MAX_TEXT_CHARS_PER_SNAPSHOT,
  MAX_SUMMARY_CHARS,
  __setFirestoreForTests,
};
