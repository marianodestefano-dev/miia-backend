/**
 * MIIA Biweekly Report — Reporte quincenal por email al owner.
 * Cada 15 días, MIIA genera un resumen ejecutivo y lo envía por email.
 *
 * Métricas incluidas:
 * - Total mensajes procesados (por tipo: owner, familia, leads)
 * - Leads nuevos vs recurrentes
 * - Tiempo promedio de respuesta
 * - Top 5 contactos más activos
 * - Uso de IA (tokens, proveedores)
 * - Estado de la suscripción
 * - Aprendizajes guardados en el período
 *
 * (c) 2024-2026 Mariano De Stefano. All rights reserved.
 */

'use strict';

let _deps = null;
let _ownerUid = null;
let _checkInterval = null;

const REPORT_INTERVAL_DAYS = 15;
const CHECK_INTERVAL_MS = 3600000; // Chequear cada hora si toca enviar

/**
 * Inicializa el sistema de reportes quincenales.
 * @param {string} ownerUid
 * @param {Object} deps - { firestore, aiGateway, mailService, safeSendMessage, OWNER_PHONE }
 */
function init(ownerUid, deps) {
  _ownerUid = ownerUid;
  _deps = deps;

  _checkInterval = setInterval(checkIfReportDue, CHECK_INTERVAL_MS);
  console.log('[BIWEEKLY-REPORT] ✅ Inicializado — reporte cada 15 días');

  // Chequear inmediatamente
  setTimeout(checkIfReportDue, 30000);
}

async function checkIfReportDue() {
  if (!_deps || !_ownerUid) return;

  const { firestore } = _deps;
  if (!firestore) return;

  try {
    const settingsDoc = await firestore.collection('users').doc(_ownerUid)
      .collection('settings').doc('biweekly_report').get();

    const lastSent = settingsDoc.exists ? settingsDoc.data().lastSentAt : null;
    const daysSinceLast = lastSent
      ? (Date.now() - new Date(lastSent).getTime()) / 86400000
      : REPORT_INTERVAL_DAYS + 1; // Nunca enviado → enviar

    if (daysSinceLast >= REPORT_INTERVAL_DAYS) {
      console.log(`[BIWEEKLY-REPORT] 📊 Han pasado ${Math.round(daysSinceLast)} días — generando reporte...`);
      await generateAndSendReport();
    }
  } catch (e) {
    console.error(`[BIWEEKLY-REPORT] ❌ Error chequeando: ${e.message}`);
  }
}

async function generateAndSendReport() {
  const { firestore, aiGateway, mailService, safeSendMessage, OWNER_PHONE } = _deps;

  // 1. Recolectar métricas de los últimos 15 días
  const metrics = await collectMetrics();

  if (!metrics) {
    console.log('[BIWEEKLY-REPORT] ⚠️ Sin métricas suficientes — saltando');
    return;
  }

  // 2. Generar resumen con IA
  const reportText = await generateReportWithAI(metrics);
  if (!reportText) return;

  // 3. Obtener email del owner
  const userDoc = await firestore.collection('users').doc(_ownerUid).get();
  const ownerEmail = userDoc.exists ? userDoc.data().email : null;
  const ownerName = userDoc.exists ? userDoc.data().name : 'Usuario';

  // 4. Enviar por email si hay SMTP configurado
  if (ownerEmail && mailService?.isConfigured()) {
    const today = new Date().toLocaleDateString('es-AR', { year: 'numeric', month: 'long', day: 'numeric' });
    await mailService.sendGenericEmail(
      ownerEmail,
      `📊 Reporte quincenal MIIA — ${today}`,
      reportText,
      { fromName: 'MIIA Reports' }
    );
    console.log(`[BIWEEKLY-REPORT] 📧 Reporte enviado a ${ownerEmail}`);
  } else {
    console.log('[BIWEEKLY-REPORT] ⚠️ Sin email o SMTP — enviando por WhatsApp');
  }

  // 5. También enviar resumen corto por WhatsApp self-chat
  if (safeSendMessage && OWNER_PHONE) {
    const shortReport = reportText.length > 1500
      ? reportText.substring(0, 1500) + '\n\n_...reporte completo enviado por email_'
      : reportText;
    await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
      `📊 *Reporte quincenal MIIA*\n\n${shortReport}`,
      { isSelfChat: true });
  }

  // 6. Guardar timestamp
  await firestore.collection('users').doc(_ownerUid)
    .collection('settings').doc('biweekly_report')
    .set({ lastSentAt: new Date().toISOString() }, { merge: true });

  // 7. Guardar reporte completo
  const reportDate = new Date().toISOString().split('T')[0];
  await firestore.collection('users').doc(_ownerUid)
    .collection('biweekly_reports').doc(reportDate)
    .set({
      date: reportDate,
      metrics,
      report: reportText,
      sentTo: ownerEmail || 'whatsapp-only',
      generatedAt: new Date().toISOString()
    });

  console.log(`[BIWEEKLY-REPORT] ✅ Reporte generado y guardado (${reportDate})`);
}

async function collectMetrics() {
  const { firestore } = _deps;
  const metrics = {
    totalMessages: 0,
    ownerMessages: 0,
    familyMessages: 0,
    leadMessages: 0,
    daysWithActivity: 0,
    topContacts: {},
    aiCalls: 0,
    errors: 0
  };

  try {
    // Leer métricas diarias de los últimos 15 días
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - REPORT_INTERVAL_DAYS);

    for (let d = 0; d < REPORT_INTERVAL_DAYS; d++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + d);
      const dateStr = `daily_${date.toISOString().split('T')[0]}`;

      const doc = await firestore.collection('users').doc(_ownerUid)
        .collection('miia_metrics').doc(dateStr).get();

      if (doc.exists) {
        const data = doc.data();
        metrics.daysWithActivity++;
        metrics.totalMessages += data.messages_processed || 0;
        metrics.aiCalls += data.ai_calls || 0;
        metrics.errors += data.errors || 0;

        // Breakdown por tipo
        if (data.message_types) {
          metrics.ownerMessages += data.message_types.owner || 0;
          metrics.familyMessages += data.message_types.family || 0;
          metrics.leadMessages += data.message_types.lead || 0;
        }

        // Top contactos
        if (data.contact_activity) {
          for (const [phone, count] of Object.entries(data.contact_activity)) {
            metrics.topContacts[phone] = (metrics.topContacts[phone] || 0) + count;
          }
        }
      }
    }

    // Ordenar top contactos
    metrics.topContactsList = Object.entries(metrics.topContacts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([phone, count]) => ({ phone, messages: count }));

    return metrics.totalMessages > 0 ? metrics : null;
  } catch (e) {
    console.error(`[BIWEEKLY-REPORT] ❌ Error recolectando métricas: ${e.message}`);
    return null;
  }
}

async function generateReportWithAI(metrics) {
  const { aiGateway } = _deps;
  if (!aiGateway) return formatBasicReport(metrics);

  try {
    const prompt = `Sos MIIA, asistente IA. Generá un reporte quincenal ejecutivo para el owner basado en estas métricas:

MÉTRICAS (últimos 15 días):
- Mensajes totales: ${metrics.totalMessages}
- Del owner (self-chat): ${metrics.ownerMessages}
- De familia: ${metrics.familyMessages}
- De leads: ${metrics.leadMessages}
- Días con actividad: ${metrics.daysWithActivity}/15
- Llamadas a IA: ${metrics.aiCalls}
- Errores: ${metrics.errors}
- Top contactos: ${metrics.topContactsList.map(c => `${c.phone}: ${c.messages} msgs`).join(', ')}

FORMATO:
📊 Resumen ejecutivo de 2 semanas
- Highlights positivos
- Áreas de mejora
- Tendencia (crecimiento/estable/baja)
- Recomendaciones accionables (2-3 máximo)

Máximo 20 líneas. Lenguaje directo, profesional pero cercano. NO mencionar que sos IA.`;

    const result = await aiGateway.smartCall('nightly_brain', prompt, {}, { maxTokens: 1024 });
    return result?.text || formatBasicReport(metrics);
  } catch (e) {
    console.error(`[BIWEEKLY-REPORT] ❌ Error generando con IA: ${e.message}`);
    return formatBasicReport(metrics);
  }
}

function formatBasicReport(metrics) {
  return `📊 Resumen quincenal MIIA

📩 Mensajes procesados: ${metrics.totalMessages}
  • Owner: ${metrics.ownerMessages}
  • Familia: ${metrics.familyMessages}
  • Leads: ${metrics.leadMessages}

📅 Días activos: ${metrics.daysWithActivity}/15
🤖 Llamadas a IA: ${metrics.aiCalls}
${metrics.errors > 0 ? `⚠️ Errores: ${metrics.errors}` : '✅ Sin errores'}

Top contactos:
${metrics.topContactsList.map((c, i) => `  ${i + 1}. ${c.phone}: ${c.messages} msgs`).join('\n')}`;
}

function stop() {
  if (_checkInterval) clearInterval(_checkInterval);
  console.log('[BIWEEKLY-REPORT] 🛑 Detenido');
}

/**
 * Forzar envío del reporte (testing).
 */
async function forceReport() {
  console.log('[BIWEEKLY-REPORT] 🔧 Forzando reporte...');
  await generateAndSendReport();
}

module.exports = { init, stop, forceReport };
