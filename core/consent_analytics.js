'use strict';

/**
 * MIIA — Consent Analytics (T131)
 * Estadisticas del estado de consentimiento de contactos de un owner.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

const CONSENT_STATES = Object.freeze(['granted', 'revoked', 'pending', 'unknown']);

/**
 * Genera un resumen de consentimientos para un uid.
 * Lee de miia_persistent/tenant_conversations.contactTypes o de consent collection.
 * @param {string} uid
 * @param {object} [consentMap] - { phone: { status, grantedAt?, revokedAt? } }
 * @returns {{ total, granted, revoked, pending, unknown, grantRate, revokeRate, generatedAt }}
 */
function buildConsentSummary(uid, consentMap = {}) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');

  const entries = Object.values(consentMap || {});
  const total = entries.length;

  const counts = { granted: 0, revoked: 0, pending: 0, unknown: 0 };
  for (const entry of entries) {
    const state = entry && CONSENT_STATES.includes(entry.status) ? entry.status : 'unknown';
    counts[state]++;
  }

  const grantRate = total > 0 ? parseFloat((counts.granted / total).toFixed(3)) : 0;
  const revokeRate = total > 0 ? parseFloat((counts.revoked / total).toFixed(3)) : 0;

  return {
    uid,
    total,
    granted: counts.granted,
    revoked: counts.revoked,
    pending: counts.pending,
    unknown: counts.unknown,
    grantRate,
    revokeRate,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Calcula tendencia de consentimientos: cuantos se otorgaron en los ultimos N dias.
 * @param {object} consentMap - { phone: { status, grantedAt? } }
 * @param {number} days
 * @param {number} [nowMs]
 * @returns {{ recentGrants, recentRevokes }}
 */
function getConsentTrend(consentMap = {}, days = 30, nowMs = Date.now()) {
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  let recentGrants = 0;
  let recentRevokes = 0;

  for (const entry of Object.values(consentMap || {})) {
    if (!entry) continue;
    if (entry.grantedAt && new Date(entry.grantedAt).getTime() >= cutoff) recentGrants++;
    if (entry.revokedAt && new Date(entry.revokedAt).getTime() >= cutoff) recentRevokes++;
  }

  return { recentGrants, recentRevokes, days };
}

/**
 * Obtiene el resumen de consentimiento desde Firestore.
 * @param {string} uid
 * @returns {Promise<object>}
 */
async function getConsentAnalytics(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('users').doc(uid).collection('miia_persistent').doc('tenant_conversations').get();
    const consentMap = snap.exists ? (snap.data().consentMap || {}) : {};
    const summary = buildConsentSummary(uid, consentMap);
    const trend = getConsentTrend(consentMap);
    return { ...summary, trend };
  } catch (e) {
    console.error(`[CONSENT-ANALYTICS] Error uid=${uid.substring(0, 8)}: ${e.message}`);
    return buildConsentSummary(uid, {});
  }
}

module.exports = {
  buildConsentSummary,
  getConsentTrend,
  getConsentAnalytics,
  CONSENT_STATES,
  __setFirestoreForTests,
};
