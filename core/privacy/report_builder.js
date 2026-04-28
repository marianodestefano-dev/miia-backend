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
 * Defaults para cada categoria cuando el helper falla.
 * Sirven como "placeholder seguro" en partial errors.
 */
const _CATEGORY_DEFAULTS = {
  profile: (uid) => ({ uid, email: null, ownerName: null }),
  conversationsSummary: () => ({ totalContacts: 0, totalMessages: 0, conversationsWithMessages: 0 }),
  contactsClassifications: () => ({ totalClassified: 0, byType: {} }),
  calendarEvents: () => ({ totalCreated: 0, upcoming: 0, past: 0 }),
  quotes: () => ({ totalGenerated: 0, lastQuoteAt: null }),
  configFlags: () => ({ aiDisclosureEnabled: null, fortalezaSealed: null, weekendModeEnabled: null }),
  auditLog: () => ({ consentRecords: 0, totalEntries: 0 }),
};

/**
 * C-462-PRIVACY-REPORT-LOUD-FAIL — Construye reporte privacy completo.
 *
 * Origen: ITER 3 RRC §B hallazgo BAJA. Patron LOUD-FAIL anchor C-459 BUG 2.
 *
 * Comportamiento:
 *   - Cada helper devuelve { ok, data, error?, section }.
 *   - OK helpers contribuyen su data normal al report.
 *   - FAIL helpers loguean warning, contribuyen data default + agregan
 *     entrada a `_diagnostic.partial_errors`.
 *   - Si TODOS fallan -> throw (signal claro al endpoint para 500).
 *   - Si algunos fallan -> report con _diagnostic populated, UI muestra
 *     "algunas secciones no se pudieron cargar".
 *
 * @param {string} ownerUid
 * @returns {Promise<object>} validado contra privacyReportSchema
 */
async function buildPrivacyReport(ownerUid) {
  if (typeof ownerUid !== 'string' || ownerUid.length < 20 || ownerUid.length > 128) {
    throw new Error('ownerUid invalid');
  }
  const fs = _getFirestore();

  const results = await Promise.all([
    _buildProfile(fs, ownerUid),
    _buildConversationsSummary(fs, ownerUid),
    _buildContactsClassifications(fs, ownerUid),
    _buildCalendarEvents(fs, ownerUid),
    _buildQuotes(fs, ownerUid),
    _buildConfigFlags(fs, ownerUid),
    _buildAuditLog(fs, ownerUid),
  ]);

  const partialErrors = [];
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    for (const r of failed) {
      console.warn(`[V2-ALERT][PRIVACY-REPORT-PARTIAL] section=${r.section} error=${r.error}`);
      partialErrors.push({ section: r.section, error: r.error });
    }
  }

  // Si TODOS fallaron, propagar error agregado (endpoint responde 500).
  if (failed.length === results.length) {
    const err = new Error(`buildPrivacyReport: all ${results.length} sections failed`);
    err.code = 'PRIVACY_REPORT_ALL_FAILED';
    err.partial_errors = partialErrors;
    throw err;
  }

  const [profile, convs, contacts, events, quotes, flags, audit] = results.map((r, idx) => {
    if (r.ok) return r.data;
    const sectionName = ['profile', 'conversationsSummary', 'contactsClassifications',
      'calendarEvents', 'quotes', 'configFlags', 'auditLog'][idx];
    const defaultFn = _CATEGORY_DEFAULTS[sectionName];
    return defaultFn(ownerUid);
  });

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

  if (partialErrors.length > 0) {
    report._diagnostic = { partial_errors: partialErrors };
  }

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

// C-462: helpers ahora devuelven { ok, data, error?, section } para
// que buildPrivacyReport pueda agregar partial_errors al diagnostic.

async function _buildProfile(fs, uid) {
  try {
    const doc = await fs.collection('users').doc(uid).get();
    if (!doc.exists) {
      return { ok: true, section: 'profile', data: { uid, email: null, ownerName: null } };
    }
    const data = doc.data() || {};
    return {
      ok: true,
      section: 'profile',
      data: {
        uid,
        email: data.email || null,
        ownerName: data.name || data.ownerName || null,
      },
    };
  } catch (e) {
    return { ok: false, section: 'profile', error: e.message };
  }
}

async function _buildConversationsSummary(fs, uid) {
  try {
    const doc = await fs.collection('users').doc(uid).collection('miia_state').doc('conversations').get();
    if (!doc.exists) {
      return { ok: true, section: 'conversationsSummary', data: { totalContacts: 0, totalMessages: 0, conversationsWithMessages: 0 } };
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
      ok: true,
      section: 'conversationsSummary',
      data: {
        totalContacts: phones.length,
        totalMessages,
        conversationsWithMessages: convsWithMessages,
      },
    };
  } catch (e) {
    return { ok: false, section: 'conversationsSummary', error: e.message };
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
    return { ok: true, section: 'contactsClassifications', data: { totalClassified: total, byType } };
  } catch (e) {
    return { ok: false, section: 'contactsClassifications', error: e.message };
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
    return { ok: true, section: 'calendarEvents', data: { totalCreated: upcoming + past, upcoming, past } };
  } catch (e) {
    return { ok: false, section: 'calendarEvents', error: e.message };
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
    return { ok: true, section: 'quotes', data: { totalGenerated: total, lastQuoteAt } };
  } catch (e) {
    return { ok: false, section: 'quotes', error: e.message };
  }
}

async function _buildConfigFlags(fs, uid) {
  try {
    const doc = await fs.collection('users').doc(uid).get();
    const data = doc.exists ? (doc.data() || {}) : {};
    return {
      ok: true,
      section: 'configFlags',
      data: {
        aiDisclosureEnabled: typeof data.aiDisclosureEnabled === 'boolean' ? data.aiDisclosureEnabled : null,
        fortalezaSealed: typeof data.fortalezaSealed === 'boolean' ? data.fortalezaSealed : null,
        weekendModeEnabled: typeof data.weekendModeEnabled === 'boolean' ? data.weekendModeEnabled : null,
      },
    };
  } catch (e) {
    return { ok: false, section: 'configFlags', error: e.message };
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
      ok: true,
      section: 'auditLog',
      data: {
        consentRecords: consentSnap.docs.length,
        totalEntries: auditSnap.docs.length,
      },
    };
  } catch (e) {
    return { ok: false, section: 'auditLog', error: e.message };
  }
}

module.exports = {
  buildPrivacyReport,
  __setFirestoreForTests,
};
