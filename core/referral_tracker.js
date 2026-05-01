'use strict';

/**
 * MIIA - Referral Tracker (T202)
 * Seguimiento del ciclo de vida de leads referidos entre negocios.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const LEAD_STAGES = Object.freeze(['referred', 'contacted', 'interested', 'quote_sent', 'negotiating', 'converted', 'lost']);
const DEFAULT_PERIOD_DAYS = 30;

async function trackReferralEvent(referralId, leadPhone, stage, meta) {
  if (!referralId) throw new Error('referralId requerido');
  if (!leadPhone) throw new Error('leadPhone requerido');
  if (!LEAD_STAGES.includes(stage)) throw new Error('stage invalido: ' + stage);
  var docId = referralId + '_' + stage + '_' + Date.now().toString(36);
  var data = {
    referralId, leadPhone, stage,
    meta: meta || {},
    recordedAt: new Date().toISOString(),
  };
  try {
    await db().collection('referral_tracking').doc(referralId).collection('events').doc(docId).set(data);
    await db().collection('referral_tracking').doc(referralId).set(
      { currentStage: stage, lastUpdatedAt: data.recordedAt, referralId, leadPhone },
      { merge: true }
    );
    console.log('[REFERRAL_TRACKER] referralId=' + referralId + ' stage=' + stage);
  } catch (e) {
    console.error('[REFERRAL_TRACKER] Error tracking: ' + e.message);
    throw e;
  }
}

async function getReferralStatus(referralId) {
  if (!referralId) throw new Error('referralId requerido');
  try {
    var snap = await db().collection('referral_tracking').doc(referralId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (e) {
    console.error('[REFERRAL_TRACKER] Error leyendo status: ' + e.message);
    return null;
  }
}

async function getReferralHistory(referralId) {
  if (!referralId) throw new Error('referralId requerido');
  try {
    var snap = await db().collection('referral_tracking').doc(referralId).collection('events').get();
    var events = [];
    snap.forEach(function(doc) { events.push(doc.data()); });
    return events.sort(function(a, b) { return new Date(a.recordedAt) - new Date(b.recordedAt); });
  } catch (e) {
    console.error('[REFERRAL_TRACKER] Error leyendo historial: ' + e.message);
    return [];
  }
}

async function getConversionStats(uid, referralIds, nowMs) {
  if (!uid) throw new Error('uid requerido');
  if (!Array.isArray(referralIds)) throw new Error('referralIds debe ser array');
  if (referralIds.length === 0) return { total: 0, converted: 0, lost: 0, inProgress: 0, conversionRate: 0 };
  try {
    var statuses = await Promise.all(referralIds.map(function(id) { return getReferralStatus(id); }));
    var converted = statuses.filter(function(s) { return s && s.currentStage === 'converted'; }).length;
    var lost = statuses.filter(function(s) { return s && s.currentStage === 'lost'; }).length;
    var inProgress = statuses.filter(function(s) { return s && s.currentStage !== 'converted' && s.currentStage !== 'lost'; }).length;
    var total = referralIds.length;
    return {
      total,
      converted,
      lost,
      inProgress,
      conversionRate: total > 0 ? Math.round((converted / total) * 100) : 0,
    };
  } catch (e) {
    console.error('[REFERRAL_TRACKER] Error calculando stats: ' + e.message);
    return { total: 0, converted: 0, lost: 0, inProgress: 0, conversionRate: 0 };
  }
}

function getNextSuggestedStage(currentStage) {
  var idx = LEAD_STAGES.indexOf(currentStage);
  if (idx === -1 || idx >= LEAD_STAGES.length - 1) return null;
  var nextIdx = LEAD_STAGES.indexOf('converted') === idx + 1 ? idx + 1 : idx + 1;
  return LEAD_STAGES[nextIdx];
}

module.exports = {
  trackReferralEvent,
  getReferralStatus,
  getReferralHistory,
  getConversionStats,
  getNextSuggestedStage,
  LEAD_STAGES,
  DEFAULT_PERIOD_DAYS,
  __setFirestoreForTests,
};