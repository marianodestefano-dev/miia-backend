'use strict';

/**
 * MIIA — Dashboard Summary API (T103)
 * Agrega stats para el dashboard del owner:
 * - totalConversations, totalLeads, totalClients
 * - recentActivity (ultimos 7 dias)
 * - topContacts (mas activos)
 * Lee desde users/{uid}/miia_persistent/tenant_conversations
 */

const admin = require('firebase-admin');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || admin.firestore(); }

const RECENT_DAYS = 7;
const TOP_CONTACTS_LIMIT = 5;

/**
 * Genera resumen de dashboard para un owner.
 * @param {string} uid
 * @param {number} [nowMs] - timestamp actual (para tests)
 * @returns {Promise<{
 *   uid, totalConversations, totalLeads, totalClients, totalContacts,
 *   recentMessageCount, topContacts, generatedAt
 * }>}
 */
async function buildDashboardSummary(uid, nowMs = Date.now()) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');

  const result = {
    uid,
    totalConversations: 0,
    totalLeads: 0,
    totalClients: 0,
    totalContacts: 0,
    recentMessageCount: 0,
    topContacts: [],
    generatedAt: new Date(nowMs).toISOString(),
  };

  const recentThreshold = nowMs - RECENT_DAYS * 24 * 60 * 60 * 1000;

  try {
    const snap = await db().collection('users').doc(uid)
      .collection('miia_persistent').doc('tenant_conversations').get();
    if (!snap.exists) return result;
    const data = snap.data();

    const conversations = (data && data.conversations) || {};
    const contactTypes = (data && data.contactTypes) || {};

    const phones = Object.keys(conversations);
    result.totalConversations = phones.length;

    // Contar por tipo
    for (const t of Object.values(contactTypes)) {
      if (t === 'lead' || t === 'miia_lead') result.totalLeads++;
      else if (t === 'client') result.totalClients++;
    }
    result.totalContacts = Object.keys(contactTypes).length;

    // Mensajes recientes + top contacts
    const contactActivity = [];
    for (const phone of phones) {
      const msgs = Array.isArray(conversations[phone]) ? conversations[phone] : [];
      const recentMsgs = msgs.filter(m => typeof m.timestamp === 'number' && m.timestamp >= recentThreshold);
      result.recentMessageCount += recentMsgs.length;
      contactActivity.push({ phone, messageCount: msgs.length });
    }

    // Top 5 contactos por numero de mensajes
    result.topContacts = contactActivity
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, TOP_CONTACTS_LIMIT)
      .map(c => ({ phone: c.phone, messageCount: c.messageCount }));

    console.log(`[DASHBOARD] uid=${uid.substring(0,8)} convs=${result.totalConversations} leads=${result.totalLeads} clients=${result.totalClients}`);
  } catch (e) {
    console.warn(`[DASHBOARD] Error leyendo datos uid=${uid.substring(0,8)}: ${e.message}`);
  }

  return result;
}

module.exports = { buildDashboardSummary, __setFirestoreForTests, RECENT_DAYS, TOP_CONTACTS_LIMIT };
