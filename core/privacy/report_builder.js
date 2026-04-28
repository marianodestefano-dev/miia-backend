/**
 * C-442 §B — Privacy Report Builder helper.
 *
 * Origen: CARTA_C-442 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27].
 *
 * Construye reporte privacy de un owner: counts y summaries por
 * categoría desde Firestore. Output validado contra Zod schema §A.
 *
 * NO expone raw content sensible (mensajes, contenidos cotizaciones,
 * etc.). Solo metadatos agregados.
 */

'use strict';

const reportSchema = require('./report_schema');

let _firestore = null;
function __setFirestoreForTests(fs) {
  _firestore = fs;
}
function _getFirestore() {
  if (_firestore) return _firestore;
  const admin = require('firebase-admin');
  return admin.firestore();
}

/**
 * Construye reporte privacy completo para owner.
 * @param {string} ownerUid
 * @returns {Promise<object>} validado contra privacyReportSchema
 */
async function buildPrivacyReport(ownerUid) {
  if (typeof ownerUid !== 'string' || ownerUid.length < 20 || ownerUid.length > 128) {
    throw new Error('ownerUid invalid');
  }
  const fs = _getFirestore();

  const [profile, convs, contacts, events, quotes, flags, audit] = await Promise.all([
    _buildProfile(fs, ownerUid),
    _buildConversationsSummary(fs, ownerUid),
    _buildContactsClassifications(fs, ownerUid),
    _buildCalendarEvents(fs, ownerUid),
    _buildQuotes(fs, ownerUid),
    _buildConfigFlags(fs, ownerUid),
    _buildAuditLog(fs, ownerUid),
  ]);

  const report = {
    ownerUid,
    generatedAt: new Date().toISOString(),
    profile,
    conversationsSummary: convs,
    contactsClassifications: contacts,
    calendarEvents: events,
    quotes,
    configFlags: flags,
    auditLog: audit,
  };

  // Validar shape con Zod (continuidad C-435 doctrina)
  const parsed = reportSchema.privacyReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(`buildPrivacyReport schema validation failed: ${parsed.error.issues.slice(0, 3).map(i => i.path.join('.') + ':' + i.message).join('; ')}`);
  }
  return parsed.data;
}

// ════════════════════════════════════════════════════════════════════
// Builders por categoría (defensivos: doc inexistente → defaults)
// ════════════════════════════════════════════════════════════════════

async function _buildProfile(fs, uid) {
  try {
    const doc = await fs.collection('users').doc(uid).get();
    if (!doc.exists) {
      return { uid, email: null, ownerName: null };
    }
    const data = doc.data() || {};
    return {
      uid,
      email: data.email || null,
      ownerName: data.name || data.ownerName || null,
    };
  } catch (e) {
    return { uid, email: null, ownerName: null };
  }
}

async function _buildConversationsSummary(fs, uid) {
  try {
    const doc = await fs.collection('users').doc(uid).collection('miia_state').doc('conversations').get();
    if (!doc.exists) {
      return { totalContacts: 0, totalMessages: 0, conversationsWithMessages: 0 };
    }
    const data = doc.data() || {};
    const conversations = data.conversations || {};
    const phones = Object.keys(conversations);
    let totalMessages = 0;
    let convsWithMessages = 0;
    for (const phone of phones) {
      const arr = Array.isArray(conversations[phone]) ? conversations[phone] : [];
      if (arr.length > 0) {
        convsWithMessages += 1;
        totalMessages += arr.length;
      }
    }
    return {
      totalContacts: phones.length,
      totalMessages,
      conversationsWithMessages: convsWithMessages,
    };
  } catch (_) {
    return { totalContacts: 0, totalMessages: 0, conversationsWithMessages: 0 };
  }
}

async function _buildContactsClassifications(fs, uid) {
  try {
    const snap = await fs.collection('users').doc(uid).collection('contactTypes').get();
    const byType = {};
    let total = 0;
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const type = data.type || 'unknown';
      byType[type] = (byType[type] || 0) + 1;
      total += 1;
    }
    return { totalClassified: total, byType };
  } catch (_) {
    return { totalClassified: 0, byType: {} };
  }
}

async function _buildCalendarEvents(fs, uid) {
  try {
    const snap = await fs.collection('users').doc(uid).collection('calendar_events').get();
    const now = Date.now();
    let upcoming = 0;
    let past = 0;
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const ts = typeof data.startTimestamp === 'number' ? data.startTimestamp : 0;
      if (ts >= now) upcoming += 1;
      else past += 1;
    }
    return { totalCreated: upcoming + past, upcoming, past };
  } catch (_) {
    return { totalCreated: 0, upcoming: 0, past: 0 };
  }
}

async function _buildQuotes(fs, uid) {
  try {
    const snap = await fs
      .collection('users')
      .doc(uid)
      .collection('quotes')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    const total = (await fs.collection('users').doc(uid).collection('quotes').get()).docs.length;
    let lastQuoteAt = null;
    if (snap.docs.length > 0) {
      const data = snap.docs[0].data() || {};
      lastQuoteAt = data.createdAt || null;
    }
    return { totalGenerated: total, lastQuoteAt };
  } catch (_) {
    return { totalGenerated: 0, lastQuoteAt: null };
  }
}

async function _buildConfigFlags(fs, uid) {
  try {
    const doc = await fs.collection('users').doc(uid).get();
    const data = doc.exists ? (doc.data() || {}) : {};
    return {
      aiDisclosureEnabled: typeof data.aiDisclosureEnabled === 'boolean' ? data.aiDisclosureEnabled : null,
      fortalezaSealed: typeof data.fortalezaSealed === 'boolean' ? data.fortalezaSealed : null,
      weekendModeEnabled: typeof data.weekendModeEnabled === 'boolean' ? data.weekendModeEnabled : null,
    };
  } catch (_) {
    return { aiDisclosureEnabled: null, fortalezaSealed: null, weekendModeEnabled: null };
  }
}

async function _buildAuditLog(fs, uid) {
  try {
    const consentSnap = await fs
      .collection('consent_records')
      .where('uid', '==', uid)
      .get();
    const auditSnap = await fs
      .collection('users')
      .doc(uid)
      .collection('audit_logs')
      .get();
    return {
      consentRecords: consentSnap.docs.length,
      totalEntries: auditSnap.docs.length,
    };
  } catch (_) {
    return { consentRecords: 0, totalEntries: 0 };
  }
}

module.exports = {
  buildPrivacyReport,
  __setFirestoreForTests,
};
