/**
 * MIIA Nightly Brain — Análisis nocturno con Claude Opus.
 * Cada noche (configurable, default 22:00), Opus analiza TODAS las
 * conversaciones del día y genera un informe para el owner.
 *
 * Insights:
 * - Leads calientes (quién mostró más interés)
 * - Patrones detectados (preguntas repetidas, objeciones comunes)
 * - Oportunidades perdidas (leads que no cerraron)
 * - Resumen emocional (tono general de las conversaciones)
 * - Sugerencias para mañana
 *
 * (c) 2024-2026 Mariano De Stefano. All rights reserved.
 */

'use strict';

let _deps = null;
let _ownerUid = null;
let _checkInterval = null;
let _lastRunDate = null;

const DEFAULT_NIGHTLY_HOUR = 23;   // 11 PM — día completamente cerrado
const DEFAULT_NIGHTLY_MINUTE = 0;  // :00 — análisis toma ~30s, no necesita margen

/**
 * Inicializa el nightly brain.
 * @param {string} ownerUid
 * @param {Object} deps - { firestore, aiGateway, safeSendMessage, getScheduleConfig, OWNER_PHONE }
 */
function init(ownerUid, deps) {
  _ownerUid = ownerUid;
  _deps = deps;

  // Chequear cada minuto si es hora del análisis nocturno
  _checkInterval = setInterval(checkNightlyTime, 60000);
  console.log('[NIGHTLY-BRAIN] ✅ Inicializado — análisis nocturno con Opus');

  // Chequear inmediatamente
  checkNightlyTime();
}

async function getOwnerLocalTime() {
  try {
    const scheduleConfig = await _deps.getScheduleConfig(_ownerUid);
    const tz = scheduleConfig?.timezone || 'America/Bogota';
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    return { hour: now.getHours(), minute: now.getMinutes(), date: now.toISOString().split('T')[0], tz };
  } catch {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    return { hour: now.getHours(), minute: now.getMinutes(), date: now.toISOString().split('T')[0], tz: 'America/Bogota' };
  }
}

async function getNightlyHour() {
  try {
    if (_deps.firestore && _ownerUid) {
      const doc = await _deps.firestore.collection('users').doc(_ownerUid)
        .collection('settings').doc('briefing').get();
      if (doc.exists && doc.data().nightlyHour !== undefined) {
        return doc.data().nightlyHour;
      }
    }
  } catch (e) {
    console.error(`[NIGHTLY-BRAIN] ❌ Error leyendo nightlyHour: ${e.message}`);
  }
  return DEFAULT_NIGHTLY_HOUR;
}

async function checkNightlyTime() {
  if (!_deps || !_ownerUid) return;

  const { hour, minute, date } = await getOwnerLocalTime();
  const nightlyHour = await getNightlyHour();

  // Ya corrió hoy
  if (_lastRunDate === date) return;

  // Es la hora:minuto configurado (±5 min de ventana)
  const nightlyMinute = DEFAULT_NIGHTLY_MINUTE;
  if (hour === nightlyHour && minute >= nightlyMinute && minute <= nightlyMinute + 5) {
    _lastRunDate = date;
    console.log(`[NIGHTLY-BRAIN] 🧠 Iniciando análisis nocturno (${date})...`);
    try {
      await runNightlyAnalysis(date);
    } catch (e) {
      console.error(`[NIGHTLY-BRAIN] ❌ Error en análisis nocturno: ${e.message}`);
    }
  }
}

/**
 * Ejecuta el análisis nocturno completo.
 */
async function runNightlyAnalysis(date) {
  const { firestore, aiGateway, safeSendMessage, OWNER_PHONE } = _deps;
  if (!firestore || !aiGateway || !safeSendMessage || !OWNER_PHONE) {
    console.error('[NIGHTLY-BRAIN] ❌ Dependencias faltantes');
    return;
  }

  // 1. Recolectar sesiones del día
  const todaySessions = await collectTodaySessions(date);
  if (!todaySessions || todaySessions.length === 0) {
    console.log('[NIGHTLY-BRAIN] 📭 Sin conversaciones hoy — saltando análisis');
    return;
  }

  console.log(`[NIGHTLY-BRAIN] 📊 ${todaySessions.length} conversaciones del día encontradas`);

  // 1.5. Recolectar recordatorios y tareas pendientes para mañana y próximos días
  let pendingReminders = '';
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const in7days = new Date();
    in7days.setDate(in7days.getDate() + 7);
    const pendingSnap = await firestore.collection('users').doc(_ownerUid)
      .collection('miia_agenda')
      .where('status', '==', 'pending')
      .where('scheduledFor', '>=', new Date().toISOString())
      .where('scheduledFor', '<=', in7days.toISOString())
      .orderBy('scheduledFor', 'asc')
      .limit(20)
      .get();
    if (!pendingSnap.empty) {
      const items = pendingSnap.docs.map(d => {
        const e = d.data();
        // Formato legible: extraer fecha y hora local
        const rawDate = e.scheduledForLocal || e.scheduledFor || '';
        let dateLabel = rawDate;
        try {
          const dt = new Date(rawDate);
          const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
          const day = dayNames[dt.getDay()];
          const hora = dt.toTimeString().substring(0, 5);
          const fecha = `${dt.getDate()}/${dt.getMonth() + 1}`;
          dateLabel = `${day} ${fecha} a las ${hora}`;
        } catch (_) {}
        const contact = e.contactName || e.contactPhone || 'desconocido';
        const isForContact = e.contactPhone && e.contactPhone !== 'self';
        const source = e.source === 'miia_center_lead' ? ' (lead MIIA CENTER)' : '';
        const action = isForContact
          ? `Recordarle a ${contact}: "${e.reason}"${source}`
          : `Recordatorio owner: "${e.reason}"`;
        return `- ${dateLabel} → ${action}`;
      });
      pendingReminders = `\n\nRECORDATORIOS Y TAREAS PENDIENTES (próximos 7 días):\n${items.join('\n')}`;
      console.log(`[NIGHTLY-BRAIN] 📅 ${items.length} recordatorios pendientes incluidos en análisis`);
    }
  } catch (e) {
    console.warn(`[NIGHTLY-BRAIN] ⚠️ Error cargando recordatorios pendientes: ${e.message}`);
  }

  // 2. Construir prompt para Opus
  const prompt = buildNightlyPrompt(todaySessions, date, pendingReminders);

  // 3. Generar análisis con Opus via ai_gateway (contexto NIGHTLY_BRAIN)
  try {
    const result = await aiGateway.smartCall('nightly_brain', prompt, {}, { maxTokens: 2048 });
    const analysis = result?.text;

    if (!analysis || analysis.length < 50) {
      console.log('[NIGHTLY-BRAIN] ⚠️ Análisis vacío o muy corto');
      return;
    }

    // 4. Enviar al owner via self-chat
    const header = `🧠 *Análisis nocturno MIIA — ${date}*\n\n`;
    await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, header + analysis, { isSelfChat: true });
    console.log(`[NIGHTLY-BRAIN] ✅ Análisis enviado (${analysis.length} chars)`);

    // 5. Guardar en Firestore para historial
    await firestore.collection('users').doc(_ownerUid)
      .collection('nightly_reports').doc(date)
      .set({
        date,
        sessionsAnalyzed: todaySessions.length,
        analysis,
        generatedAt: new Date().toISOString()
      });

    console.log(`[NIGHTLY-BRAIN] 💾 Reporte guardado en Firestore`);
  } catch (e) {
    console.error(`[NIGHTLY-BRAIN] ❌ Error generando análisis: ${e.message}`);
  }
}

/**
 * Recolecta todas las sesiones de conversación del día desde Firestore.
 */
async function collectTodaySessions(date) {
  const { firestore } = _deps;
  const sessions = [];

  try {
    // Sesiones del owner
    const ownerSessionDoc = await firestore.collection('users').doc(_ownerUid)
      .collection('training_sessions').doc(date).get();

    if (ownerSessionDoc.exists) {
      const data = ownerSessionDoc.data();
      if (data.messages && data.messages.length > 0) {
        sessions.push({
          type: 'self_chat',
          contact: 'Owner (self-chat)',
          messageCount: data.messages.length,
          messages: summarizeMessages(data.messages, 30) // Max 30 msgs
        });
      }
    }

    // Sesiones de leads/contactos (tenant conversations)
    const tenantSessions = await firestore.collection('users').doc(_ownerUid)
      .collection('tenant_sessions').doc(date).get();

    if (tenantSessions.exists) {
      const data = tenantSessions.data();
      if (data.conversations) {
        for (const [phone, conv] of Object.entries(data.conversations)) {
          if (conv.messages && conv.messages.length > 0) {
            sessions.push({
              type: conv.type || 'lead',
              contact: conv.contactName || phone,
              phone,
              messageCount: conv.messages.length,
              messages: summarizeMessages(conv.messages, 20)
            });
          }
        }
      }
    }

    // Sesiones de familia
    const familySessions = await firestore.collection('users').doc(_ownerUid)
      .collection('family_sessions').doc(date).get();

    if (familySessions.exists) {
      const data = familySessions.data();
      if (data.conversations) {
        for (const [phone, conv] of Object.entries(data.conversations)) {
          if (conv.messages && conv.messages.length > 0) {
            sessions.push({
              type: 'family',
              contact: conv.contactName || phone,
              messageCount: conv.messages.length,
              messages: summarizeMessages(conv.messages, 15)
            });
          }
        }
      }
    }
  } catch (e) {
    console.error(`[NIGHTLY-BRAIN] ❌ Error recolectando sesiones: ${e.message}`);
  }

  return sessions;
}

/**
 * Resume mensajes para no exceder el contexto del prompt.
 */
function summarizeMessages(messages, maxCount) {
  const limited = messages.slice(-maxCount); // Últimos N mensajes
  return limited.map(m => {
    const role = m.role || m.from || 'unknown';
    const text = (m.text || m.body || m.content || '').substring(0, 200);
    return `[${role}]: ${text}`;
  }).join('\n');
}

/**
 * Construye el prompt para el análisis nocturno.
 */
function buildNightlyPrompt(sessions, date, pendingReminders = '') {
  const sessionsSummary = sessions.map(s => {
    return `--- ${s.type.toUpperCase()}: ${s.contact} (${s.messageCount} msgs) ---\n${s.messages}`;
  }).join('\n\n');

  return `Sos MIIA, la asistente IA de un emprendedor. Analizá TODAS las conversaciones de hoy (${date}) y generá un informe ejecutivo.

CONVERSACIONES DEL DÍA:
${sessionsSummary}
${pendingReminders}

GENERÁ UN INFORME con estas secciones (si aplican):

🔥 *LEADS CALIENTES*
- Quién mostró más interés, qué preguntaron, qué tan cerca están de comprar

📊 *PATRONES DETECTADOS*
- Preguntas que se repiten, objeciones comunes, temas recurrentes

⚠️ *OPORTUNIDADES PERDIDAS*
- Leads que se enfriaron, conversaciones que no cerraron, seguimientos pendientes

📅 *TAREAS Y RECORDATORIOS PENDIENTES*
- Qué recordatorios hay para mañana y los próximos días (incluir leads de MIIA CENTER)
- Qué seguimientos prometidos hay que cumplir
- Si algún lead pidió algo que MIIA debe hacer → listarlo con fecha y hora

💡 *SUGERENCIAS PARA MAÑANA*
- Qué contactos seguir, qué mejorar, qué oportunidades aprovechar

😊 *TONO GENERAL*
- Resumen emocional del día (positivo, neutro, difícil)

Reglas:
- Máximo 30 líneas total
- Sé directo y accionable (no poesía)
- Si no hubo leads, enfocá en familia/self-chat insights
- Lenguaje argentino informal
- NO mencionar que sos IA
- La sección de TAREAS Y RECORDATORIOS es CRÍTICA — si hay pendientes, SIEMPRE incluirla`;
}

/**
 * Forzar el análisis nocturno (para testing).
 */
async function forceRun() {
  const { date } = await getOwnerLocalTime();
  console.log(`[NIGHTLY-BRAIN] 🔧 Forzando análisis nocturno para ${date}`);
  await runNightlyAnalysis(date);
}

function stop() {
  if (_checkInterval) clearInterval(_checkInterval);
  console.log('[NIGHTLY-BRAIN] 🛑 Detenido');
}

function getStatus() {
  return {
    initialized: !!_deps,
    lastRunDate: _lastRunDate,
    nightlyHourDefault: DEFAULT_NIGHTLY_HOUR
  };
}

module.exports = { init, forceRun, stop, getStatus };
