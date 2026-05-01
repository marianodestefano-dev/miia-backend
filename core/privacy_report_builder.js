'use strict';

/**
 * MIIA - Privacy Report Builder (T232)
 * P1.2 ROADMAP: reporte de privacidad + derecho al olvido self-service.
 * Owner ve que memorias guardo MIIA + borra por categoria + exporta GDPR-compliant.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const ERASURE_CATEGORIES = Object.freeze([
  'conversations', 'training_data', 'memory', 'contacts',
  'analytics', 'audit_logs', 'preferences', 'all',
]);

const REPORT_SECTIONS = Object.freeze([
  'summary', 'conversations', 'contacts', 'memory', 'training', 'exports', 'anomalies',
]);

const GDPR_VERSION = '1.0';
const MAX_REPORT_CONTACTS = 1000;
const DATA_RETENTION_DAYS = 365;

function isValidCategory(cat) {
  return ERASURE_CATEGORIES.includes(cat);
}

async function getConversationStats(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('conversations').get();
    var count = 0;
    var oldest = null;
    var newest = null;
    snap.forEach(function(doc) {
      count++;
      var d = doc.data();
      if (d.lastMessageAt) {
        if (!oldest || d.lastMessageAt < oldest) oldest = d.lastMessageAt;
        if (!newest || d.lastMessageAt > newest) newest = d.lastMessageAt;
      }
    });
    return { count, oldest, newest };
  } catch (e) {
    console.error('[PRIVACY_REPORT] Error stats conversaciones: ' + e.message);
    return { count: 0, oldest: null, newest: null };
  }
}

async function getContactStats(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('contacts').get();
    var byType = {};
    var count = 0;
    snap.forEach(function(doc) {
      count++;
      var d = doc.data();
      var t = d.type || 'unknown';
      byType[t] = (byType[t] || 0) + 1;
    });
    return { total: count, byType };
  } catch (e) {
    console.error('[PRIVACY_REPORT] Error stats contactos: ' + e.message);
    return { total: 0, byType: {} };
  }
}

async function getMemoryStats(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('miia_memory').get();
    var count = 0;
    var byType = {};
    snap.forEach(function(doc) {
      count++;
      var d = doc.data();
      var t = d.type || 'unknown';
      byType[t] = (byType[t] || 0) + 1;
    });
    return { episodeCount: count, byType };
  } catch (e) {
    console.error('[PRIVACY_REPORT] Error stats memoria: ' + e.message);
    return { episodeCount: 0, byType: {} };
  }
}

async function buildPrivacyReport(uid) {
  if (!uid) throw new Error('uid requerido');
  var [convStats, contactStats, memStats] = await Promise.all([
    getConversationStats(uid),
    getContactStats(uid),
    getMemoryStats(uid),
  ]);
  return {
    uid,
    gdprVersion: GDPR_VERSION,
    generatedAt: new Date().toISOString(),
    dataRetentionDays: DATA_RETENTION_DAYS,
    conversations: convStats,
    contacts: contactStats,
    memory: memStats,
    erasureCategories: ERASURE_CATEGORIES,
    sections: REPORT_SECTIONS,
  };
}

async function requestErasure(uid, category, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!category) throw new Error('category requerido');
  if (!isValidCategory(category)) throw new Error('categoria invalida: ' + category);
  var record = {
    uid,
    category,
    requestedAt: new Date().toISOString(),
    status: 'pending',
    requestedBy: (opts && opts.requestedBy) ? opts.requestedBy : 'owner',
    reason: (opts && opts.reason) ? String(opts.reason) : null,
    completedAt: null,
  };
  var requestId = 'erasure_' + uid.slice(0, 4) + '_' + Date.now().toString(36);
  await db().collection('tenants').doc(uid).collection('erasure_requests').doc(requestId).set(record);
  console.log('[PRIVACY_REPORT] Solicitud de borrado uid=' + uid + ' category=' + category + ' id=' + requestId);
  return { requestId, record };
}

async function getErasureRequests(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('erasure_requests').get();
    var results = [];
    snap.forEach(function(doc) { results.push({ id: doc.id, ...doc.data() }); });
    results.sort(function(a, b) { return new Date(b.requestedAt) - new Date(a.requestedAt); });
    return results;
  } catch (e) {
    console.error('[PRIVACY_REPORT] Error leyendo solicitudes: ' + e.message);
    return [];
  }
}

function buildGDPRExportPackage(uid, reportData, contactList) {
  if (!uid) throw new Error('uid requerido');
  return {
    exportVersion: GDPR_VERSION,
    exportedAt: new Date().toISOString(),
    subject: uid,
    legalBasis: 'legitimate_interest',
    retentionPolicy: DATA_RETENTION_DAYS + ' dias',
    report: reportData || {},
    contacts: (contactList || []).slice(0, MAX_REPORT_CONTACTS),
    contactsIncluded: Math.min((contactList || []).length, MAX_REPORT_CONTACTS),
    rightsAvailable: [
      'acceso', 'rectificacion', 'supresion', 'portabilidad', 'oposicion',
    ],
    contactDpo: 'privacy@miia-app.com',
  };
}

module.exports = {
  buildPrivacyReport,
  requestErasure,
  getErasureRequests,
  buildGDPRExportPackage,
  getConversationStats,
  getContactStats,
  getMemoryStats,
  isValidCategory,
  ERASURE_CATEGORIES,
  REPORT_SECTIONS,
  GDPR_VERSION,
  DATA_RETENTION_DAYS,
  MAX_REPORT_CONTACTS,
  __setFirestoreForTests,
};
