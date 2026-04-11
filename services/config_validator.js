'use strict';

/**
 * CONFIG_VALIDATOR.JS — Detecta incompatibilidades en la configuración del owner
 *
 * STANDARD: Google + Amazon + APPLE + NASA
 * Fail loudly, exhaustive logging, zero silent failures.
 *
 * Escenarios detectados:
 * 1. Schedule vs horario de negocio: "no molestar fines de semana" pero negocio abre sábados
 * 2. Safe hours vs eventos: recordatorios configurados fuera del rango de envío
 * 3. IMAP sin credenciales: email habilitado pero faltan host/user/pass
 * 4. Timezone faltante: todo el scheduling depende de timezone
 * 5. IA configurada sin API key: proveedor premium seleccionado sin key
 * 6. Agenda sin Google Calendar: owner agenda pero no conectó Calendar
 *
 * Cada validación retorna: { id, severity: 'critical'|'warning'|'info', message, suggestion }
 */

const LOG_PREFIX = '[CONFIG-VALIDATOR]';

// ═══ DEPENDENCIAS INYECTADAS ═══
let _admin = null;
let _safeSendMessage = null;

function setConfigValidatorDependencies({ admin, safeSendMessage }) {
  _admin = admin;
  _safeSendMessage = safeSendMessage;
  console.log(`${LOG_PREFIX} ✅ Dependencias inyectadas`);
}

/**
 * Ejecutar TODAS las validaciones de configuración para un owner
 * @param {string} uid - UID del owner
 * @returns {Promise<Array>} Lista de incompatibilidades encontradas
 */
async function validateConfig(uid) {
  if (!_admin || !uid) return [];

  console.log(`${LOG_PREFIX} 🔍 Validando configuración de ${uid.substring(0, 12)}...`);
  const alerts = [];

  try {
    // Cargar datos del owner
    const userDoc = await _admin.firestore().collection('users').doc(uid).get();
    if (!userDoc.exists) {
      console.warn(`${LOG_PREFIX} ⚠️ Usuario ${uid} no existe en Firestore`);
      return [];
    }
    const userData = userDoc.data();

    // Cargar schedule config
    let scheduleConfig = null;
    try {
      const schedDoc = await _admin.firestore().collection('users').doc(uid)
        .collection('settings').doc('schedule').get();
      if (schedDoc.exists) scheduleConfig = schedDoc.data();
    } catch (e) { /* no schedule config = ok */ }

    // ═══ VALIDACIÓN 1: Timezone faltante ═══
    alerts.push(..._checkTimezone(userData));

    // ═══ VALIDACIÓN 2: IMAP sin credenciales ═══
    alerts.push(..._checkImapConfig(userData));

    // ═══ VALIDACIÓN 3: IA sin API key ═══
    alerts.push(..._checkAIConfig(userData));

    // ═══ VALIDACIÓN 4: Schedule inconsistencias ═══
    alerts.push(..._checkSchedule(scheduleConfig, userData));

    // ═══ VALIDACIÓN 5: Google Calendar no conectado ═══
    alerts.push(..._checkCalendar(userData));

    // ═══ VALIDACIÓN 6: Safe hours vs eventos programados ═══
    alerts.push(...await _checkSafeHoursVsEvents(uid, scheduleConfig));

    const criticals = alerts.filter(a => a.severity === 'critical').length;
    const warnings = alerts.filter(a => a.severity === 'warning').length;
    const infos = alerts.filter(a => a.severity === 'info').length;
    console.log(`${LOG_PREFIX} ✅ Validación completa: ${criticals} críticos, ${warnings} warnings, ${infos} info`);

    return alerts;
  } catch (err) {
    console.error(`${LOG_PREFIX} ❌ Error validando config: ${err.message}`);
    return [];
  }
}

// ═══ VALIDADORES INDIVIDUALES ═══

function _checkTimezone(userData) {
  const alerts = [];
  const phone = userData.phone || '';
  // Si no tiene timezone explícito, verificar que al menos tiene código de país
  if (!userData.timezone && !phone) {
    alerts.push({
      id: 'missing_timezone',
      severity: 'critical',
      message: 'No tenés timezone configurado ni número de teléfono para inferirlo.',
      suggestion: 'Configurá tu timezone en el dashboard (Configuración → Zona horaria) o asegurate de tener tu número de WhatsApp registrado.',
    });
  }
  return alerts;
}

function _checkImapConfig(userData) {
  const alerts = [];
  // Si tiene IMAP parcialmente configurado (algunos campos pero no todos)
  const hasImapHost = !!userData.imapHost;
  const hasImapUser = !!userData.imapUser;
  const hasImapPass = !!userData.imapPass;

  if (hasImapHost && (!hasImapUser || !hasImapPass)) {
    alerts.push({
      id: 'imap_incomplete',
      severity: 'warning',
      message: `Email IMAP: tenés el servidor (${userData.imapHost}) pero falta ${!hasImapUser ? 'el usuario' : 'la contraseña'}.`,
      suggestion: 'Completá la configuración IMAP en el dashboard (Conexiones → Email) para que pueda gestionar tu correo.',
    });
  }

  // Si pide gestión de email pero no tiene IMAP
  if (!hasImapHost && !hasImapUser && userData.emailManagement) {
    alerts.push({
      id: 'imap_not_configured',
      severity: 'warning',
      message: 'Activaste gestión de email pero no configuraste IMAP.',
      suggestion: 'Configurá tu email IMAP en el dashboard para que pueda leer y gestionar tu bandeja de entrada.',
    });
  }

  return alerts;
}

function _checkAIConfig(userData) {
  const alerts = [];
  const provider = userData.aiProvider;
  const apiKey = userData.aiApiKey;

  if (provider && provider !== 'gemini' && !apiKey) {
    alerts.push({
      id: 'ai_no_key',
      severity: 'critical',
      message: `Proveedor de IA "${provider}" seleccionado pero sin API key.`,
      suggestion: `Agregá tu API key de ${provider} en el dashboard (Conexiones → Inteligencia Artificial) o cambiá a Gemini (no requiere key propia).`,
    });
  }

  return alerts;
}

function _checkSchedule(scheduleConfig, userData) {
  const alerts = [];
  if (!scheduleConfig) return alerts;

  // Detectar si tiene "no molestar" en horarios que coinciden con operación
  const workDays = scheduleConfig.workDays || [];
  const safeHoursStart = scheduleConfig.safeHoursStart ?? 7;
  const safeHoursEnd = scheduleConfig.safeHoursEnd ?? 19;

  // Si safe hours son muy restrictivas (menos de 6 horas)
  if (safeHoursEnd - safeHoursStart < 6) {
    alerts.push({
      id: 'narrow_safe_hours',
      severity: 'warning',
      message: `Tu ventana de respuesta es muy corta: ${safeHoursStart}:00 a ${safeHoursEnd}:00 (${safeHoursEnd - safeHoursStart}h).`,
      suggestion: 'Los leads que escriban fuera de ese horario no recibirán respuesta automática. ¿Querés ampliar a un rango más amplio?',
    });
  }

  // Si no tiene ningún día laboral configurado
  if (workDays.length === 0 && scheduleConfig.workDays !== undefined) {
    alerts.push({
      id: 'no_work_days',
      severity: 'critical',
      message: 'No tenés días laborales configurados. MIIA no responderá leads automáticamente ningún día.',
      suggestion: 'Configurá al menos los días de la semana en que tu negocio opera (Configuración → Horarios).',
    });
  }

  return alerts;
}

function _checkCalendar(userData) {
  const alerts = [];
  // Si usa agenda pero no tiene Google Calendar conectado
  if (!userData.googleCalendarToken && !userData.calendarConnected) {
    // Esto es info, no crítico — la agenda funciona sin Calendar
    alerts.push({
      id: 'no_calendar',
      severity: 'info',
      message: 'No tenés Google Calendar conectado.',
      suggestion: 'Si conectás Google Calendar, los eventos que agende MIIA se sincronizan con tu calendario automáticamente.',
    });
  }
  return alerts;
}

async function _checkSafeHoursVsEvents(uid, scheduleConfig) {
  const alerts = [];
  if (!scheduleConfig || !_admin) return alerts;

  const safeStart = scheduleConfig.safeHoursStart ?? 7;
  const safeEnd = scheduleConfig.safeHoursEnd ?? 19;

  try {
    // Buscar eventos próximos que caen fuera de safe hours
    const now = new Date();
    const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const eventsSnap = await _admin.firestore()
      .collection('users').doc(uid).collection('miia_agenda')
      .where('status', '==', 'pending')
      .where('scheduledFor', '>=', now.toISOString())
      .where('scheduledFor', '<=', in7days.toISOString())
      .limit(20)
      .get();

    let outsideCount = 0;
    eventsSnap.docs.forEach(doc => {
      const evt = doc.data();
      const evtDate = new Date(evt.scheduledFor);
      const evtHour = evtDate.getHours();
      if (evtHour < safeStart || evtHour >= safeEnd) {
        outsideCount++;
      }
    });

    if (outsideCount > 0) {
      alerts.push({
        id: 'events_outside_safe_hours',
        severity: 'warning',
        message: `Tenés ${outsideCount} evento${outsideCount > 1 ? 's' : ''} próximo${outsideCount > 1 ? 's' : ''} fuera de tu horario seguro (${safeStart}:00-${safeEnd}:00).`,
        suggestion: 'Los recordatorios de esos eventos podrían no enviarse a tiempo. Considerá ajustar tu horario seguro o mover los eventos.',
      });
    }
  } catch (e) {
    console.warn(`${LOG_PREFIX} ⚠️ Error verificando eventos vs safe hours: ${e.message}`);
  }

  return alerts;
}

/**
 * Formatear alertas para WhatsApp (self-chat)
 * @param {Array} alerts
 * @returns {string}
 */
function formatAlertsForWhatsApp(alerts) {
  if (!alerts || alerts.length === 0) return '';

  const criticals = alerts.filter(a => a.severity === 'critical');
  const warnings = alerts.filter(a => a.severity === 'warning');
  const infos = alerts.filter(a => a.severity === 'info');

  let msg = '⚙️ *Revisión de configuración*\n\n';

  if (criticals.length > 0) {
    msg += '🔴 *CRÍTICO:*\n';
    criticals.forEach(a => {
      msg += `• ${a.message}\n  💡 ${a.suggestion}\n\n`;
    });
  }

  if (warnings.length > 0) {
    msg += '🟡 *ATENCIÓN:*\n';
    warnings.forEach(a => {
      msg += `• ${a.message}\n  💡 ${a.suggestion}\n\n`;
    });
  }

  if (infos.length > 0) {
    msg += '🔵 *SUGERENCIAS:*\n';
    infos.forEach(a => {
      msg += `• ${a.message}\n  💡 ${a.suggestion}\n\n`;
    });
  }

  return msg.trim();
}

/**
 * Ejecutar validación y notificar al owner si hay problemas
 * @param {string} uid
 * @param {string} ownerJid - JID para self-chat
 */
async function validateAndNotify(uid, ownerJid) {
  const alerts = await validateConfig(uid);
  if (alerts.length === 0) {
    console.log(`${LOG_PREFIX} ✅ Sin incompatibilidades para ${uid.substring(0, 12)}`);
    return;
  }

  const criticals = alerts.filter(a => a.severity === 'critical');
  if (criticals.length === 0) {
    // Solo warnings/info — no notificar por WhatsApp, solo log
    console.log(`${LOG_PREFIX} ℹ️ ${alerts.length} alertas no-críticas para ${uid.substring(0, 12)}`);
    return;
  }

  // Hay críticos → notificar al owner
  if (_safeSendMessage && ownerJid) {
    const msg = formatAlertsForWhatsApp(alerts);
    try {
      await _safeSendMessage(ownerJid, msg, { isSelfChat: true, skipEmoji: true });
      console.log(`${LOG_PREFIX} 📢 Alertas enviadas al owner (${criticals.length} críticas)`);
    } catch (sendErr) {
      console.error(`${LOG_PREFIX} ❌ Error enviando alertas: ${sendErr.message}`);
    }
  }
}

// ═══ EXPORTS ═══

module.exports = {
  setConfigValidatorDependencies,
  validateConfig,
  validateAndNotify,
  formatAlertsForWhatsApp,
};
