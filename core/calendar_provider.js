/**
 * CALENDAR PROVIDER — Abstracción multi-calendar para MIIA.
 *
 * Soporta:
 * - Google Calendar (via google_calendar.js, ya implementado)
 * - Microsoft Outlook (via Microsoft Graph API) — PENDIENTE de implementar
 * - CalDAV (Nextcloud, iCloud, etc) — PENDIENTE de implementar
 *
 * Cada MIIA usa el calendar que su owner tenga configurado.
 * Si no tiene ninguno, MIIA le avisa que conecte uno desde Dashboard.
 *
 * (c) 2024-2026 Mariano De Stefano. All rights reserved.
 */

'use strict';

const admin = require('firebase-admin');
const googleCalendar = require('./google_calendar');

// ═══ PROVIDERS SOPORTADOS ═══
const SUPPORTED_PROVIDERS = {
  google: {
    name: 'Google Calendar',
    icon: '📅',
    authUrl: '/api/auth/google/calendar',
    fields: ['googleTokens', 'calendarEnabled']
  },
  outlook: {
    name: 'Microsoft Outlook',
    icon: '📧',
    authUrl: '/api/auth/outlook/calendar',
    fields: ['outlookTokens', 'outlookCalendarEnabled']
  },
  caldav: {
    name: 'CalDAV (Nextcloud, iCloud)',
    icon: '🗓️',
    authUrl: null, // Config manual: URL + user + password
    fields: ['caldavUrl', 'caldavUser', 'caldavEnabled']
  }
};

/**
 * Detecta qué provider de calendar tiene configurado un usuario.
 * @param {string} uid
 * @returns {Promise<{provider: string, connected: boolean, providerName: string}>}
 */
async function detectCalendarProvider(uid) {
  try {
    const doc = await admin.firestore().collection('users').doc(uid).get();
    if (!doc.exists) return { provider: null, connected: false, providerName: 'Ninguno' };
    const data = doc.data();

    // Prioridad: Google → Outlook → CalDAV
    if (data.googleTokens && data.calendarEnabled) {
      return { provider: 'google', connected: true, providerName: 'Google Calendar' };
    }
    if (data.outlookTokens && data.outlookCalendarEnabled) {
      return { provider: 'outlook', connected: true, providerName: 'Microsoft Outlook' };
    }
    if (data.caldavUrl && data.caldavEnabled) {
      return { provider: 'caldav', connected: true, providerName: 'CalDAV' };
    }

    return { provider: null, connected: false, providerName: 'Ninguno' };
  } catch (e) {
    console.error(`[CALENDAR-PROVIDER] ❌ Error detectando provider para ${uid}:`, e.message);
    return { provider: null, connected: false, providerName: 'Error' };
  }
}

/**
 * Crea un evento de calendar usando el provider configurado del usuario.
 * @param {object} opts - Mismos opts que createCalendarEvent + uid
 * @returns {Promise<{success: boolean, eventId?: string, provider: string, error?: string}>}
 */
async function createEvent(opts) {
  const { uid } = opts;
  const calInfo = await detectCalendarProvider(uid);

  if (!calInfo.connected) {
    console.log(`[CALENDAR-PROVIDER] ⚠️ Usuario ${uid} no tiene calendar conectado`);
    return { success: false, provider: 'none', error: 'Calendar no conectado' };
  }

  switch (calInfo.provider) {
    case 'google':
      try {
        const result = await googleCalendar.createCalendarEvent(opts);
        return { success: true, eventId: result?.eventId, provider: 'google', meetLink: result?.meetLink };
      } catch (e) {
        console.error(`[CALENDAR-PROVIDER:GOOGLE] ❌ Error creando evento: ${e.message}`);
        return { success: false, provider: 'google', error: e.message };
      }

    case 'outlook':
      // TODO: Implementar Microsoft Graph API
      console.log(`[CALENDAR-PROVIDER:OUTLOOK] ⚠️ Outlook Calendar aún no implementado — evento guardado solo en Firestore`);
      return { success: false, provider: 'outlook', error: 'Outlook aún no implementado' };

    case 'caldav':
      // TODO: Implementar CalDAV
      console.log(`[CALENDAR-PROVIDER:CALDAV] ⚠️ CalDAV aún no implementado — evento guardado solo en Firestore`);
      return { success: false, provider: 'caldav', error: 'CalDAV aún no implementado' };

    default:
      return { success: false, provider: 'unknown', error: 'Provider desconocido' };
  }
}

/**
 * Lista de providers soportados (para mostrar en Dashboard).
 */
function getSupportedProviders() {
  return SUPPORTED_PROVIDERS;
}

module.exports = {
  detectCalendarProvider,
  createEvent,
  getSupportedProviders,
  SUPPORTED_PROVIDERS
};
