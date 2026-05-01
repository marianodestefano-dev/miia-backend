// ════════════════════════════════════════════════════════════════════════════
// MIIA — Privacy Report / Informe Semestral (P3.7)
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// Genera informe de privacidad semestral por owner:
// - Cuántos mensajes procesó MIIA
// - Qué datos almacena
// - Quién accedió (audit_logs)
// - Opciones: ver en dashboard, descargar PDF, MIIA notifica por WhatsApp
// ════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
let _db = null;
function db() { if (!_db) _db = admin.firestore(); return _db; }

/**
 * Genera el informe de privacidad semestral para un owner.
 * @param {string} ownerUid
 * @returns {Object} Informe completo con métricas, datos almacenados, accesos
 */
async function generateReport(ownerUid) {
  const now = new Date();
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const periodStart = sixMonthsAgo.toISOString();
  const periodEnd = now.toISOString();

  console.log(`[PRIVACY-REPORT] 📊 Generando informe para ${ownerUid} (${periodStart} → ${periodEnd})`);

  const report = {
    ownerUid,
    generatedAt: now.toISOString(),
    periodStart,
    periodEnd,
    metrics: {},
    dataStored: {},
    accessLog: [],
    recommendations: []
  };

  try {
    // 1. Métricas de mensajes (de privacy_counters)
    const countersDoc = await db().collection('users').doc(ownerUid)
      .collection('stats').doc('counters').get();
    if (countersDoc.exists) {
      report.metrics = {
        messagesProcessed: countersDoc.data().messagesProcessed || 0,
        messagesOut: countersDoc.data().messagesOut || 0,
        contactsTotal: countersDoc.data().contactsTotal || 0,
        businessesTotal: countersDoc.data().businessesTotal || 0,
        lastMessageAt: countersDoc.data().lastMessageAt || null,
        lastActiveAt: countersDoc.data().lastActiveAt || null
      };
    }

    // 2. Datos almacenados (inventario)
    const dataStored = {};

    // Negocios
    const bizSnap = await db().collection('users').doc(ownerUid)
      .collection('businesses').get();
    dataStored.businesses = bizSnap.size;

    // Productos (contar dentro de cada negocio)
    let totalProducts = 0;
    for (const bizDoc of bizSnap.docs) {
      const prodSnap = await bizDoc.ref.collection('products').get();
      totalProducts += prodSnap.size;
    }
    dataStored.products = totalProducts;

    // Grupos de contacto
    const groupsSnap = await db().collection('users').doc(ownerUid)
      .collection('contact_groups').get();
    dataStored.contactGroups = groupsSnap.size;

    // Contactos totales
    let totalContacts = 0;
    for (const groupDoc of groupsSnap.docs) {
      const contactsSnap = await groupDoc.ref.collection('contacts').get();
      totalContacts += contactsSnap.size;
    }
    dataStored.contacts = totalContacts;

    // Contact index
    const indexSnap = await db().collection('users').doc(ownerUid)
      .collection('contact_index').get();
    dataStored.contactIndex = indexSnap.size;

    // Sports preferences
    const sportsSnap = await db().collection('users').doc(ownerUid)
      .collection('miia_sports').get();
    dataStored.sportsPreferences = sportsSnap.size;

    // Slots
    const slotsSnap = await db().collection('users').doc(ownerUid)
      .collection('slots').get();
    dataStored.slots = slotsSnap.size;

    // Personal brain
    const personalDoc = await db().collection('users').doc(ownerUid)
      .collection('personal').doc('personal_brain').get();
    dataStored.personalBrain = personalDoc.exists ? 'Sí' : 'No';

    report.dataStored = dataStored;

    // 3. Log de accesos (audit_logs del período)
    try {
      const auditSnap = await db().collection('users').doc(ownerUid)
        .collection('audit_logs')
        .where('timestamp', '>=', periodStart)
        .orderBy('timestamp', 'desc')
        .limit(50)
        .get();
      report.accessLog = auditSnap.docs.map(d => ({
        type: d.data().type || 'unknown',
        timestamp: d.data().timestamp || d.data().createdAt,
        details: d.data().details || ''
      }));
    } catch (_) {
      // audit_logs puede no tener index por timestamp — listar sin filtro
      try {
        const auditSnap = await db().collection('users').doc(ownerUid)
          .collection('audit_logs').limit(50).get();
        report.accessLog = auditSnap.docs.map(d => ({
          type: d.data().type || 'unknown',
          timestamp: d.data().timestamp || d.data().createdAt || d.data().completedAt,
          details: d.data().details || ''
        }));
      } catch (_2) {}
    }

    // 4. Recomendaciones automáticas
    if (!personalDoc.exists) {
      report.recommendations.push('Configurá tu cerebro personal para que MIIA te conozca mejor');
    }
    if (dataStored.businesses === 0) {
      report.recommendations.push('Creá al menos un negocio para que MIIA pueda atender leads');
    }
    if (dataStored.contactGroups === 0) {
      report.recommendations.push('Organizá tus contactos en grupos para personalizar el tono de MIIA');
    }
    if (report.metrics.messagesProcessed > 1000 && dataStored.slots === 0) {
      report.recommendations.push('Con tu volumen de mensajes, considerá agregar slots para familiares o agentes');
    }

    console.log(`[PRIVACY-REPORT] ✅ Informe generado: ${report.metrics.messagesProcessed} msgs, ${dataStored.contacts} contactos, ${report.accessLog.length} accesos`);

    // Guardar informe en Firestore
    await db().collection('users').doc(ownerUid)
      .collection('privacy_reports').add({
        ...report,
        createdAt: now.toISOString()
      });

    return report;

  } catch (e) {
    console.error(`[PRIVACY-REPORT] ❌ Error generando informe:`, e.message);
    throw e;
  }
}

/**
 * Formatea el informe como texto para enviar por WhatsApp.
 */
function formatForWhatsApp(report) {
  const m = report.metrics;
  const d = report.dataStored;
  const period = `${new Date(report.periodStart).toLocaleDateString('es')} - ${new Date(report.periodEnd).toLocaleDateString('es')}`;

  let text = `📊 *Informe de Privacidad Semestral*\n`;
  text += `Período: ${period}\n\n`;
  text += `📨 *Actividad*\n`;
  text += `• Mensajes procesados: ${m.messagesProcessed || 0}\n`;
  text += `• Mensajes enviados: ${m.messagesOut || 0}\n`;
  text += `• Contactos totales: ${m.contactsTotal || 0}\n\n`;
  text += `💾 *Datos almacenados*\n`;
  text += `• Negocios: ${d.businesses || 0}\n`;
  text += `• Productos: ${d.products || 0}\n`;
  text += `• Grupos: ${d.contactGroups || 0}\n`;
  text += `• Contactos: ${d.contacts || 0}\n`;
  text += `• Slots: ${d.slots || 0}\n`;
  text += `• Cerebro personal: ${d.personalBrain || 'No'}\n\n`;
  text += `🔐 *Accesos registrados*: ${report.accessLog.length} en el período\n\n`;

  if (report.recommendations.length > 0) {
    text += `💡 *Recomendaciones*\n`;
    report.recommendations.forEach(r => { text += `• ${r}\n`; });
  }

  text += `\n_Podés descargar tu informe completo y tus datos desde el dashboard → Privacidad._`;

  return text;
}

/**
 * Verifica si es hora de enviar el informe semestral (enero y julio).
 */
function shouldSendReport(timezone) {
  const tz = timezone || 'America/Bogota';
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const month = now.getMonth(); // 0=ene, 6=jul
  const day = now.getDate();
  const hour = now.getHours();

  // Enviar el 1ro de enero y 1ro de julio, entre 9 y 10am
  return (month === 0 || month === 6) && day === 1 && hour >= 9 && hour < 10;
}

/**
 * Lista informes previos de un owner.
 */
async function listReports(ownerUid) {
  try {
    const snap = await db().collection('users').doc(ownerUid)
      .collection('privacy_reports')
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error(`[PRIVACY-REPORT] ❌ listReports error:`, e.message);
    return [];
  }
}


// ── T91 (Wi mapa) ── __setFirestoreForTests para tests ──
function __setFirestoreForTests(fs) { _db = fs; }

/**
 * T91 — Informe rapido de datos almacenados por owner.
 * Campos: conversationsCount, oldestConversationDate, contactTypesCount,
 *         staleCacheCount, trainingDataSize, personalBrainSize, generatedAt.
 * @param {string} uid
 * @returns {Promise<object>}
 */
async function buildPrivacyReport(uid) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');

  const dbInst = db();
  const now = new Date();
  const result = {
    uid,
    conversationsCount: 0,
    oldestConversationDate: null,
    contactTypesCount: 0,
    staleCacheCount: 0,
    trainingDataSize: 0,
    personalBrainSize: 0,
    generatedAt: now.toISOString()
  };

  // 1. tenant_conversations
  try {
    const convDoc = await dbInst.collection('users').doc(uid)
      .collection('miia_persistent').doc('tenant_conversations').get();
    if (convDoc.exists) {
      const data = convDoc.data();
      const conversations = data.conversations || {};
      result.conversationsCount = Object.keys(conversations).length;
      result.contactTypesCount = Object.keys(data.contactTypes || {}).length;

      let oldest = null;
      for (const msgs of Object.values(conversations)) {
        if (!Array.isArray(msgs)) continue;
        for (const msg of msgs) {
          const ts = msg.timestamp || msg.ts;
          if (ts && (!oldest || ts < oldest)) oldest = ts;
        }
      }
      result.oldestConversationDate = oldest || null;
    }
  } catch (e) {
    console.warn(`[PRIVACY-REPORT] Error leyendo tenant_conversations ${uid.substring(0, 8)}: ${e.message}`);
  }

  // 2. staleCacheCount (si contact_classification_cache.getStats existe)
  try {
    const classCache = require('../lib/contact_classification_cache');
    if (typeof classCache.getStats === 'function') {
      const stats = classCache.getStats(uid);
      result.staleCacheCount = stats.staleCount || 0;
    }
  } catch (_) {}

  // 3. training_data size
  try {
    const tdDoc = await dbInst.collection('users').doc(uid)
      .collection('miia_persistent').doc('training_data').get();
    if (tdDoc.exists) {
      const content = tdDoc.data().content || '';
      result.trainingDataSize = Buffer.byteLength(content, 'utf8');
    }
  } catch (e) {
    console.warn(`[PRIVACY-REPORT] Error leyendo training_data ${uid.substring(0, 8)}: ${e.message}`);
  }

  // 4. personal_brain size
  try {
    const pbDoc = await dbInst.collection('users').doc(uid)
      .collection('personal').doc('personal_brain').get();
    if (pbDoc.exists) {
      const content = JSON.stringify(pbDoc.data());
      result.personalBrainSize = Buffer.byteLength(content, 'utf8');
    }
  } catch (e) {
    console.warn(`[PRIVACY-REPORT] Error leyendo personal_brain ${uid.substring(0, 8)}: ${e.message}`);
  }

  console.log(`[PRIVACY-REPORT] buildPrivacyReport ${uid.substring(0, 8)}: ${result.conversationsCount} convs, td=${result.trainingDataSize}B, pb=${result.personalBrainSize}B`);
  return result;
}

module.exports = {
  generateReport,
  buildPrivacyReport,
  __setFirestoreForTests,
  formatForWhatsApp,
  shouldSendReport,
  listReports
};
