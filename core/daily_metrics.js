'use strict';

/**
 * PB.6 — Metricas diarias por owner
 * Firestore: owners/{uid}/metrics/{YYYY-MM-DD}
 * Campos: messages_received, messages_sent, leads_new, leads_responded,
 *         gemini_calls, gemini_errors, wa_reconnects
 */

const VALID_FIELDS = Object.freeze([
  'messages_received', 'messages_sent', 'leads_new', 'leads_responded',
  'gemini_calls', 'gemini_errors', 'wa_reconnects',
]);

let _db = null;
let _admin = null;

function __setFirestoreForTests(fs) { _db = fs; }
function __setAdminForTests(admin) { _admin = admin; }
function _db_() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }
function _increment(n) {
  const a = _admin || /* istanbul ignore next */ require('firebase-admin');
  return a.firestore.FieldValue.increment(n);
}

function getTodayDateKey(now) {
  const d = now ? new Date(now) : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/**
 * Incrementa un contador para el owner en la fecha de hoy.
 * @param {string} uid
 * @param {string} field - uno de VALID_FIELDS
 * @param {number} [amount=1]
 * @returns {Promise<boolean>}
 */
async function incrementMetric(uid, field, amount) {
  if (amount === undefined) amount = 1;
  if (!uid) return false;
  if (!VALID_FIELDS.includes(field)) {
    console.warn('[DAILY-METRICS] Campo invalido: ' + field);
    return false;
  }
  const dateKey = getTodayDateKey();
  try {
    await _db_().collection('owners').doc(uid).collection('metrics').doc(dateKey).set(
      { [field]: _increment(amount), updatedAt: new Date().toISOString() },
      { merge: true }
    );
    return true;
  } catch (e) {
    console.error('[DAILY-METRICS] Error incrementando ' + field + ' uid=' + uid.substring(0, 8) + ': ' + e.message);
    return false;
  }
}

/**
 * Lee las metricas del dia para un owner.
 * @param {string} uid
 * @param {string} [dateKey] - YYYY-MM-DD (default hoy)
 * @returns {Promise<Object|null>}
 */
async function getDailyMetrics(uid, dateKey) {
  if (!uid) return null;
  const key = dateKey || getTodayDateKey();
  const doc = await _db_().collection('owners').doc(uid).collection('metrics').doc(key).get();
  return doc.exists ? doc.data() : null;
}

module.exports = {
  incrementMetric,
  getDailyMetrics,
  getTodayDateKey,
  VALID_FIELDS,
  __setFirestoreForTests,
  __setAdminForTests,
};
