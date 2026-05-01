'use strict';

/**
 * MIIA - Owner Dashboard Builder (T221)
 * Construye el snapshot completo del dashboard para el owner.
 */

const DASHBOARD_SECTIONS = Object.freeze([
  'summary', 'leads', 'conversations', 'broadcasts', 'referrals', 'growth', 'anomalies',
]);

const HEALTH_LEVELS = Object.freeze({ OK: 'ok', WARNING: 'warning', CRITICAL: 'critical' });

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidSection(section) {
  return DASHBOARD_SECTIONS.includes(section);
}

function calculateHealthScore(metrics) {
  if (!metrics || typeof metrics !== 'object') return { score: 0, level: HEALTH_LEVELS.CRITICAL };
  var score = 100;
  if (metrics.openAnomalies > 0) score -= Math.min(metrics.openAnomalies * 10, 40);
  if (metrics.failedBroadcasts > 0) score -= Math.min(metrics.failedBroadcasts * 5, 20);
  if (metrics.p95ResponseMs > 2000) score -= 20;
  if (metrics.responseRate < 0.5) score -= 15;
  score = Math.max(0, score);
  var level = score >= 80 ? HEALTH_LEVELS.OK : score >= 50 ? HEALTH_LEVELS.WARNING : HEALTH_LEVELS.CRITICAL;
  return { score: Math.round(score), level };
}

async function getLeadsSummary(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('contacts').get();
    var total = 0;
    snap.forEach(function() { total++; });
    return { total, active: total };
  } catch (e) {
    console.error('[DASHBOARD] Error obteniendo leads: ' + e.message);
    return { total: 0, active: 0 };
  }
}

async function buildDashboardSnapshot(uid, sections) {
  if (!uid) throw new Error('uid requerido');
  var requestedSections = Array.isArray(sections) ? sections : DASHBOARD_SECTIONS;
  var invalid = requestedSections.filter(function(s) { return !isValidSection(s); });
  if (invalid.length > 0) throw new Error('secciones invalidas: ' + invalid.join(', '));
  
  var snapshot = {
    uid,
    generatedAt: new Date().toISOString(),
    sections: {},
  };

  try {
    if (requestedSections.includes('summary')) {
      var leadsData = await getLeadsSummary(uid);
      snapshot.sections.summary = {
        totalContacts: leadsData.total,
        activeContacts: leadsData.active,
        lastUpdated: new Date().toISOString(),
      };
    }
    return snapshot;
  } catch (e) {
    console.error('[DASHBOARD] Error buildando snapshot: ' + e.message);
    throw e;
  }
}

async function getDashboardAlerts(uid) {
  if (!uid) throw new Error('uid requerido');
  var alerts = [];
  try {
    var snap = await db().collection('tenants').doc(uid).collection('anomalies').where('resolved', '==', false).get();
    snap.forEach(function(doc) {
      var d = doc.data();
      alerts.push({ id: doc.id, type: d.type, severity: d.severity, timestamp: d.timestamp });
    });
    return alerts.sort(function(a, b) { return new Date(b.timestamp || 0) - new Date(a.timestamp || 0); });
  } catch (e) {
    console.error('[DASHBOARD] Error obteniendo alertas: ' + e.message);
    return [];
  }
}

function formatDashboardForDisplay(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    uid: snapshot.uid,
    generatedAt: snapshot.generatedAt,
    sectionsCount: Object.keys(snapshot.sections || {}).length,
    hasSummary: !!(snapshot.sections && snapshot.sections.summary),
    totalContacts: snapshot.sections && snapshot.sections.summary ? snapshot.sections.summary.totalContacts : 0,
  };
}

module.exports = {
  isValidSection,
  calculateHealthScore,
  getLeadsSummary,
  buildDashboardSnapshot,
  getDashboardAlerts,
  formatDashboardForDisplay,
  DASHBOARD_SECTIONS,
  HEALTH_LEVELS,
  __setFirestoreForTests,
};
