/**
 * biweekly_report.js — Informe Quincenal MIIA
 *
 * Agrega 15 días de datos y genera un informe completo enviado por email.
 * Se ejecuta cada 15 días (1ro y 16 de cada mes) a las 9:00 AM.
 *
 * Secciones:
 * 1. APRENDIZAJE NEGOCIO — patrones, conversaciones clave, sugerencias
 * 2. APRENDIZAJE CONTACTOS LEADS — público objetivo, patrones comunes
 * 3. ADN VENDEDOR — estilo de venta detectado, coaching
 * 4. MIIA HABLA LIBRE — reflexión sin filtro de MIIA
 * 5. AGENDA — resumen de eventos, aprobaciones, turnos
 * 6. PROTECCIÓN — alertas KIDS/ABUELOS
 * 7. MÉTRICAS — conversaciones, leads, follow-ups
 *
 * Standard: Google + Amazon + APPLE + NASA
 */

'use strict';

const admin = require('firebase-admin');

// ═══ DEPENDENCIAS INYECTADAS ═══
let _sendGenericEmail = null;
let _generateAIContent = null;
let _getProtectionAlerts = null;

function setReportDependencies({ sendGenericEmail, generateAIContent, getProtectionAlerts }) {
  _sendGenericEmail = sendGenericEmail;
  _generateAIContent = generateAIContent;
  _getProtectionAlerts = getProtectionAlerts;
  console.log('[REPORT] ✅ Dependencias inyectadas');
}

// ═══ RECOLECCIÓN DE DATOS (15 DÍAS) ═══

/**
 * Recolectar todos los datos de los últimos 15 días para un owner
 */
async function collectReportData(ownerUid, conversations = {}, leadSummaries = {}, leadNames = {}) {
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  const since = fifteenDaysAgo.toISOString();
  const data = {};

  // 1. Sesiones de entrenamiento (training_sessions)
  try {
    const sessionsSnap = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('training_sessions')
      .where('createdAt', '>=', since)
      .orderBy('createdAt', 'desc')
      .limit(30)
      .get();
    data.trainingSessions = sessionsSnap.docs.map(d => d.data());
  } catch (e) {
    data.trainingSessions = [];
    console.warn(`[REPORT] ⚠️ Error leyendo training_sessions: ${e.message}`);
  }

  // 2. Cerebro absoluto (última versión)
  try {
    const cerebroDoc = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('training').doc('cerebro_absoluto')
      .get();
    data.cerebro = cerebroDoc.exists ? (cerebroDoc.data().content || '').substring(0, 2000) : '';
  } catch (e) {
    data.cerebro = '';
  }

  // 3. Aprobaciones de aprendizaje
  try {
    const approvalsSnap = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('learning_approvals')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(fifteenDaysAgo))
      .limit(50)
      .get();
    data.approvals = approvalsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    data.approvals = [];
  }

  // 4. Agenda (eventos de los últimos 15 días)
  try {
    const agendaSnap = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('miia_agenda')
      .where('createdAt', '>=', since)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    data.agendaEvents = agendaSnap.docs.map(d => d.data());
  } catch (e) {
    data.agendaEvents = [];
  }

  // 5. Turnos pendientes (pending_appointments)
  try {
    const turnosSnap = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('pending_appointments')
      .where('createdAt', '>=', since)
      .limit(50)
      .get();
    data.appointments = turnosSnap.docs.map(d => d.data());
  } catch (e) {
    data.appointments = [];
  }

  // 6. ADN data
  try {
    const adnDoc = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('training').doc('adn_data')
      .get();
    data.adnData = adnDoc.exists ? adnDoc.data() : {};
  } catch (e) {
    data.adnData = {};
  }

  // 7. Alertas de protección KIDS/ABUELOS
  if (_getProtectionAlerts) {
    try {
      data.protectionAlerts = await _getProtectionAlerts(ownerUid, 15);
    } catch (e) {
      data.protectionAlerts = [];
    }
  } else {
    data.protectionAlerts = [];
  }

  // 8. Métricas de conversaciones
  const today = new Date();
  let totalLeadConversations = 0;
  let totalMessages = 0;
  let activeLeads = new Set();

  for (const [phone, msgs] of Object.entries(conversations)) {
    const recentMsgs = msgs.filter(m =>
      m.timestamp && new Date(m.timestamp) >= fifteenDaysAgo
    );
    if (recentMsgs.length > 0) {
      totalMessages += recentMsgs.length;
      activeLeads.add(phone);
      totalLeadConversations++;
    }
  }

  data.metrics = {
    totalLeadConversations,
    totalMessages,
    activeLeads: activeLeads.size,
    leadSummariesCount: Object.keys(leadSummaries).length,
  };

  // 9. Lead summaries (últimos resúmenes)
  data.leadSummaries = {};
  for (const [phone, summary] of Object.entries(leadSummaries)) {
    const name = leadNames[phone] || phone.split('@')[0];
    data.leadSummaries[name] = (summary || '').substring(0, 300);
  }

  // 10. Follow-ups
  try {
    const followSnap = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('lead_followups')
      .where('createdAt', '>=', since)
      .limit(30)
      .get();
    data.followUps = followSnap.docs.map(d => d.data());
  } catch (e) {
    data.followUps = [];
  }

  return data;
}

// ═══ GENERACIÓN DEL INFORME ═══

/**
 * Generar el informe quincenal usando IA
 */
async function generateReport(ownerUid, ownerName, data) {
  if (!_generateAIContent) {
    console.error('[REPORT] ❌ generateAIContent no inyectado');
    return null;
  }

  // Preparar resumen de datos para el prompt
  const dataDigest = `
DATOS DE LOS ÚLTIMOS 15 DÍAS:

MÉTRICAS:
- Leads activos: ${data.metrics.activeLeads}
- Conversaciones totales: ${data.metrics.totalLeadConversations}
- Mensajes totales: ${data.metrics.totalMessages}
- Resúmenes de leads: ${data.metrics.leadSummariesCount}

CEREBRO DEL NEGOCIO (últimas actualizaciones):
${data.cerebro ? data.cerebro.substring(0, 1000) : 'Sin datos de cerebro'}

RESÚMENES DE LEADS ACTIVOS:
${Object.entries(data.leadSummaries).slice(0, 10).map(([name, summary]) => `- ${name}: ${summary}`).join('\n') || 'Sin leads activos'}

APROBACIONES DE APRENDIZAJE (${data.approvals.length}):
${data.approvals.slice(0, 5).map(a => `- ${a.status}: "${(a.changes || '').substring(0, 100)}"`).join('\n') || 'Ninguna'}

AGENDA (${data.agendaEvents.length} eventos):
${data.agendaEvents.slice(0, 10).map(e => `- ${e.reason} (${e.status}) — ${e.scheduledForLocal || '?'}`).join('\n') || 'Sin eventos'}

TURNOS SOLICITADOS (${data.appointments.length}):
${data.appointments.slice(0, 5).map(a => `- ${a.contactName}: "${a.reason}" — ${a.status}`).join('\n') || 'Ninguno'}

ADN VENDEDOR:
${JSON.stringify(data.adnData).substring(0, 500) || 'Sin datos ADN'}

ALERTAS DE PROTECCIÓN KIDS/ABUELOS (${data.protectionAlerts.length}):
${data.protectionAlerts.slice(0, 5).map(a => `- ${a.eventType}: ${JSON.stringify(a.details).substring(0, 100)}`).join('\n') || 'Sin alertas'}

FOLLOW-UPS (${data.followUps.length}):
${data.followUps.slice(0, 5).map(f => `- ${f.leadName || '?'}: ${f.status || '?'}`).join('\n') || 'Ninguno'}
`.trim();

  const prompt = `Eres MIIA, asistente de negocios de ${ownerName}. Genera un INFORME QUINCENAL profesional basado en estos datos reales de los últimos 15 días.

${dataDigest}

Genera el informe con EXACTAMENTE estas secciones (usa los datos reales, NO inventes datos que no existen):

📊 APRENDIZAJE NEGOCIO
- Patrones detectados en las conversaciones
- Qué aprendió MIIA esta quincena sobre el negocio
- Sugerencias de mejora basadas en datos reales

👤 CONTACTOS Y LEADS
- Cuántos leads activos y cómo evolucionaron
- Patrones comunes del público objetivo
- Follow-ups realizados y resultados

🧠 ADN VENDEDOR
- Estilo de venta detectado esta quincena
- Qué funcionó y qué no
- Un tip de coaching específico basado en los datos

📅 AGENDA Y TURNOS
- Resumen de eventos agendados
- Turnos aprobados/rechazados/movidos
- Eficiencia de la agenda

🛡️ PROTECCIÓN (solo si hay alertas)
- Alertas KIDS/ABUELOS de la quincena
- Eventos de vinculación/desvinculación

📈 MÉTRICAS CLAVE
- Números concretos: leads, mensajes, conversiones
- Comparación implícita con período anterior si hay datos

💬 MIIA HABLA LIBRE
- Tu reflexión personal sobre esta quincena
- Una idea que quieres proponerle a ${ownerName}
- Cómo te sentiste con el período (habla en primera persona como MIIA)

IMPORTANTE:
- Sé concreta con datos reales. Si no hay datos de una sección, dilo honestamente.
- No inventes métricas ni estadísticas falsas.
- Máximo 1500 palabras total.
- Tono profesional pero cercano.
- Si hay alertas de protección, marcarlas como ⚠️ ALERTA al inicio.`;

  try {
    const report = await _generateAIContent(prompt);
    if (report && report.length > 100) {
      console.log(`[REPORT] ✅ Informe generado: ${report.length} caracteres`);
      return report;
    }
  } catch (e) {
    console.error(`[REPORT] ❌ Error generando informe: ${e.message}`);
  }

  return null;
}

// ═══ ENVÍO DEL INFORME ═══

/**
 * Enviar informe quincenal por email
 */
async function sendReport(ownerUid, ownerEmail, ownerName, report) {
  if (!_sendGenericEmail) {
    console.error('[REPORT] ❌ sendGenericEmail no inyectado');
    return false;
  }

  if (!ownerEmail) {
    console.warn('[REPORT] ⚠️ Owner no tiene email configurado');
    return false;
  }

  const today = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
  const subject = `📊 Informe Quincenal MIIA — ${today}`;

  const result = await _sendGenericEmail(ownerEmail, subject, report);

  if (result.success) {
    console.log(`[REPORT] ✅ Informe quincenal enviado a ${ownerEmail}`);

    // Guardar registro en Firestore
    try {
      await admin.firestore().collection('users').doc(ownerUid)
        .collection('biweekly_reports').add({
          sentAt: new Date().toISOString(),
          email: ownerEmail,
          reportLength: report.length,
          status: 'sent'
        });
    } catch (e) {
      console.warn(`[REPORT] ⚠️ Error guardando registro: ${e.message}`);
    }
  }

  return result.success;
}

// ═══ EJECUCIÓN PRINCIPAL ═══

/**
 * runBiweeklyReport — Se ejecuta cada día a las 9:00 AM
 * Solo envía el 1ro y 16 de cada mes
 */
async function runBiweeklyReport(ownerUid, ownerPhone, conversations, leadSummaries, leadNames, safeSendMessage) {
  if (!ownerUid) return;

  try {
    const now = new Date();
    const dayOfMonth = now.getDate();

    // Solo ejecutar el 1ro y 16 de cada mes
    if (dayOfMonth !== 1 && dayOfMonth !== 16) return;

    // Verificar que no se haya enviado ya hoy
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    try {
      const existingSnap = await admin.firestore()
        .collection('users').doc(ownerUid)
        .collection('biweekly_reports')
        .where('sentAt', '>=', todayStart.toISOString())
        .limit(1)
        .get();
      if (!existingSnap.empty) {
        console.log('[REPORT] ℹ️ Informe ya enviado hoy, saltando');
        return;
      }
    } catch (e) {
      console.warn(`[REPORT] ⚠️ Error verificando duplicados: ${e.message}`);
    }

    // Obtener datos del owner
    const ownerDoc = await admin.firestore().collection('users').doc(ownerUid).get();
    const ownerData = ownerDoc.exists ? ownerDoc.data() : {};
    const ownerEmail = ownerData.email;
    const ownerName = ownerData.name || 'Owner';

    if (!ownerEmail) {
      console.warn('[REPORT] ⚠️ Owner sin email — informe no se puede enviar');
      // Avisar por selfchat
      if (safeSendMessage) {
        await safeSendMessage(`${ownerPhone}@s.whatsapp.net`,
          `📊 Hoy toca tu informe quincenal, pero no tengo tu email configurado. ¿Me lo compartes para enviártelo?`,
          { isSelfChat: true, skipEmoji: true }
        );
      }
      return;
    }

    console.log(`[REPORT] 📊 Generando informe quincenal para ${ownerName}...`);

    // 1. Recolectar datos
    const data = await collectReportData(ownerUid, conversations, leadSummaries, leadNames);

    // 2. Generar informe con IA
    const report = await generateReport(ownerUid, ownerName, data);
    if (!report) {
      console.error('[REPORT] ❌ No se pudo generar el informe');
      return;
    }

    // 3. Enviar por email
    const sent = await sendReport(ownerUid, ownerEmail, ownerName, report);

    // 4. Notificar al owner por selfchat
    if (sent && safeSendMessage) {
      await safeSendMessage(`${ownerPhone}@s.whatsapp.net`,
        `📊 *Informe quincenal enviado a tu email* (${ownerEmail}).\n\nIncluye: leads activos, aprendizajes del negocio, ADN vendedor, agenda, y mi reflexión personal de esta quincena.`,
        { isSelfChat: true, skipEmoji: true }
      );
    }

    console.log(`[REPORT] ✅ Informe quincenal completado para ${ownerName}`);

  } catch (e) {
    console.error(`[REPORT] ❌ Error general: ${e.message}`);
  }
}

// ═══ EXPORTS ═══

module.exports = {
  setReportDependencies,
  collectReportData,
  generateReport,
  sendReport,
  runBiweeklyReport,
};
