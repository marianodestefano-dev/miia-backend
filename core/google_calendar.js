/**
 * GOOGLE_CALENDAR.JS — Módulo compartido de Google Calendar
 *
 * STANDARD: Google + Amazon + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * Extraído de server.js para que tanto el path admin como el path tenant puedan
 * crear eventos en Google Calendar. Antes, solo el admin (server.js) llamaba
 * createCalendarEvent; los tenants (tenant_message_handler.js) solo guardaban en Firestore.
 *
 * DEPENDENCIAS:
 *   - googleapis (OAuth2 + Calendar API v3)
 *   - firebase-admin (Firestore para tokens y schedule config)
 */

const { google } = require('googleapis');
const admin = require('firebase-admin');

// ═══════════════════════════════════════════════════════════════
// OAUTH2 CLIENT
// ═══════════════════════════════════════════════════════════════

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'https://api.miia-app.com/api/auth/google/callback'
  );
}

// ═══════════════════════════════════════════════════════════════
// GET CALENDAR CLIENT — Obtiene cliente autenticado de Calendar
// ═══════════════════════════════════════════════════════════════

/**
 * Obtiene un cliente de Google Calendar autenticado para un usuario.
 * Auto-refresca tokens expirados y los guarda en Firestore.
 * @param {string} uid - UID del owner en Firestore
 * @returns {Promise<{cal: object, calId: string}>} Cliente de Calendar + calendarId
 * @throws {Error} Si el usuario no tiene googleTokens configurados
 */
async function getCalendarClient(uid) {
  const doc = await admin.firestore().collection('users').doc(uid).get();
  const data = doc.exists ? doc.data() : {};
  if (!data.googleTokens) throw new Error('Google Calendar no conectado para este usuario');
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(data.googleTokens);
  // Auto-refresh token si expiró
  oauth2Client.on('tokens', async (tokens) => {
    const updated = { ...data.googleTokens, ...tokens };
    await admin.firestore().collection('users').doc(uid).set({ googleTokens: updated }, { merge: true });
  });
  return { cal: google.calendar({ version: 'v3', auth: oauth2Client }), calId: data.googleCalendarId || 'primary' };
}

// ═══════════════════════════════════════════════════════════════
// SCHEDULE CONFIG — Carga timezone y horarios del owner
// ═══════════════════════════════════════════════════════════════

const _scheduleCache = {};

async function getScheduleConfig(uid) {
  const cached = _scheduleCache[uid];
  if (cached && Date.now() - cached.ts < 300000) return cached.data;
  try {
    const doc = await admin.firestore().collection('users').doc(uid).collection('settings').doc('schedule').get();
    const data = doc.exists ? doc.data() : null;
    _scheduleCache[uid] = { data, ts: Date.now() };
    return data;
  } catch (e) {
    console.error(`[GCAL] ❌ Error cargando scheduleConfig para ${uid}:`, e.message);
    return cached?.data || null;
  }
}

// ═══════════════════════════════════════════════════════════════
// CREATE CALENDAR EVENT — Crea evento en Google Calendar
// ═══════════════════════════════════════════════════════════════

/**
 * createCalendarEvent — Crea evento en Google Calendar
 * @param {Object} opts
 * @param {string} opts.summary - Título del evento
 * @param {string} opts.dateStr - Fecha 'YYYY-MM-DD' o 'YYYY-MM-DDTHH:mm'
 * @param {number} opts.startHour - Hora inicio (0-23)
 * @param {number} opts.startMinute - Minuto inicio (0-59, default: 0)
 * @param {number} opts.endHour - Hora fin (0-23)
 * @param {number} opts.endMinute - Minuto fin (0-59, default: 0)
 * @param {string} opts.attendeeEmail - Email del invitado (opcional)
 * @param {string} opts.description - Descripción del evento
 * @param {string} opts.uid - UID del owner en Firestore
 * @param {string} opts.timezone - Timezone IANA (ej: 'America/Bogota')
 * @param {string} opts.eventMode - 'presencial' | 'virtual' | 'telefono' (default: 'presencial')
 * @param {string} opts.location - Dirección física para presencial (opcional)
 * @param {string} opts.phoneNumber - Número de teléfono para modo telefónico (opcional)
 * @param {number} opts.reminderMinutes - Minutos antes para recordatorio (default: 10)
 */
async function createCalendarEvent({ summary, dateStr, startHour, endHour, startMinute, endMinute, attendeeEmail, description, uid, timezone, eventMode, location, phoneNumber, reminderMinutes }) {
  const { cal, calId } = await getCalendarClient(uid);

  // Determinar timezone: parámetro explícito > scheduleConfig del user > default Bogotá
  let tz = timezone;
  if (!tz) {
    try {
      const schedCfg = await getScheduleConfig(uid);
      tz = schedCfg?.timezone || 'America/Bogota';
    } catch { tz = 'America/Bogota'; }
  }

  // Construir fecha/hora en timezone local del usuario
  const targetDate = new Date(dateStr);
  // FIX Sesión 34: getUTCMonth() devuelve 0 para Enero → 0 es falsy → usaba mes actual.
  // Ahora: verificar isNaN explícitamente en vez de usar || como fallback.
  const isValidDate = !isNaN(targetDate.getTime());
  const now = new Date();
  const year = isValidDate ? targetDate.getUTCFullYear() : now.getFullYear();
  const month = String((isValidDate ? targetDate.getUTCMonth() : now.getMonth()) + 1).padStart(2, '0');
  const day = String(isValidDate ? targetDate.getUTCDate() : now.getDate()).padStart(2, '0');
  const sH = String(startHour || 10).padStart(2, '0');
  const sM = String(startMinute || 0).padStart(2, '0');
  const eH = String(endHour || (startHour || 10) + 1).padStart(2, '0');
  const eM = String(endMinute || 0).padStart(2, '0');
  if (!isValidDate) {
    console.warn(`[GCAL] ⚠️ dateStr inválido: "${dateStr}" — usando fecha actual ${year}-${month}-${day}`);
  }

  // ═══ MODO DEL EVENTO: presencial / virtual / teléfono ═══
  const mode = (eventMode || 'presencial').toLowerCase().trim();
  let eventDescription = description || 'Agendado automáticamente por MIIA';
  let eventLocation = '';
  let conferenceData = null;

  if (mode === 'virtual') {
    conferenceData = {
      createRequest: {
        requestId: `miia-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    };
    eventDescription += '\n\n📹 Reunión virtual — el link de Google Meet se adjunta automáticamente.';
    console.log(`[GCAL] 📹 Modo VIRTUAL: se generará link de Google Meet`);
  } else if (mode === 'telefono' || mode === 'telefónico') {
    const phone = phoneNumber || '';
    eventLocation = phone ? `Llamada telefónica: ${phone}` : 'Llamada telefónica';
    eventDescription += phone
      ? `\n\n📞 Llamada telefónica al: ${phone}`
      : '\n\n📞 Llamada telefónica (número pendiente de confirmar)';
    console.log(`[GCAL] 📞 Modo TELÉFONO: ${phone || 'sin número especificado'}`);
  } else {
    if (location) {
      eventLocation = location;
      eventDescription += `\n\n📍 Ubicación: ${location}`;
    }
    console.log(`[GCAL] 📍 Modo PRESENCIAL: ${location || 'sin dirección especificada'}`);
  }

  // ═══ RECORDATORIO ═══
  const reminder = reminderMinutes ?? 10;

  const event = {
    summary: summary || 'Reunión con MIIA',
    description: eventDescription,
    start: { dateTime: `${year}-${month}-${day}T${sH}:${sM}:00`, timeZone: tz },
    end: { dateTime: `${year}-${month}-${day}T${eH}:${eM}:00`, timeZone: tz },
    attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: reminder }
      ]
    }
  };

  if (eventLocation) event.location = eventLocation;
  if (conferenceData) event.conferenceData = conferenceData;

  const insertParams = { calendarId: calId, resource: event, sendUpdates: 'all' };
  if (conferenceData) insertParams.conferenceDataVersion = 1;

  const response = await cal.events.insert(insertParams);

  const meetLink = response.data?.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri || null;

  console.log(`[GCAL] ✅ Evento creado: "${summary}" el ${dateStr} ${sH}:${sM} (${tz}) modo=${mode} reminder=${reminder}min uid=${uid}${meetLink ? ` meet=${meetLink}` : ''}`);
  return { ok: true, eventId: response.data.id, htmlLink: response.data.htmlLink, meetLink, mode };
}

// ═══════════════════════════════════════════════════════════════
// CHECK CALENDAR AVAILABILITY
// ═══════════════════════════════════════════════════════════════

async function checkCalendarAvailability(dateStr, uid) {
  const { cal, calId } = await getCalendarClient(uid);
  let targetDate = new Date(dateStr);
  if (isNaN(targetDate)) targetDate = new Date();

  const timeMin = new Date(targetDate);
  timeMin.setHours(9, 0, 0, 0);
  const timeMax = new Date(targetDate);
  timeMax.setHours(18, 0, 0, 0);

  const response = await cal.events.list({
    calendarId: calId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  });

  const events = response.data.items || [];
  const busySlots = events.map(e => ({
    start: new Date(e.start.dateTime || e.start.date),
    end: new Date(e.end.dateTime || e.end.date),
    title: e.summary
  }));

  const freeSlots = [];
  for (let h = 9; h < 18; h++) {
    const slotStart = new Date(targetDate);
    slotStart.setHours(h, 0, 0, 0);
    const slotEnd = new Date(targetDate);
    slotEnd.setHours(h + 1, 0, 0, 0);
    const overlap = busySlots.some(b => b.start < slotEnd && b.end > slotStart);
    if (!overlap) freeSlots.push(`${h}:00 - ${h + 1}:00`);
  }

  return { date: targetDate.toLocaleDateString('es-ES'), busySlots: busySlots.length, freeSlots };
}

// ═══════════════════════════════════════════════════════════════
// DIAGNÓSTICO DE CALENDAR — Para debug de "eventos no aparecen"
// ═══════════════════════════════════════════════════════════════

/**
 * diagnoseCalendar — Verifica salud completa de Google Calendar para un usuario.
 * Retorna: tokens status, calendar list, test event creation.
 * @param {string} uid - UID del owner
 */
async function diagnoseCalendar(uid) {
  const result = { uid, steps: [], ok: false };

  // PASO 1: Verificar tokens en Firestore
  try {
    const doc = await admin.firestore().collection('users').doc(uid).get();
    const data = doc.exists ? doc.data() : {};
    if (!data.googleTokens) {
      result.steps.push({ step: 'tokens', ok: false, error: 'No hay googleTokens en Firestore' });
      return result;
    }
    const tokens = data.googleTokens;
    const hasRefresh = !!tokens.refresh_token;
    const hasAccess = !!tokens.access_token;
    const expiry = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
    const isExpired = expiry ? expiry < new Date() : 'unknown';
    result.steps.push({
      step: 'tokens',
      ok: hasRefresh && hasAccess,
      hasRefreshToken: hasRefresh,
      hasAccessToken: hasAccess,
      expiryDate: expiry?.toISOString() || 'N/A',
      isExpired,
      calendarId: data.googleCalendarId || 'primary',
      calendarEnabled: !!data.calendarEnabled
    });
    if (!hasRefresh) {
      result.steps.push({ step: 'warning', message: 'SIN refresh_token — reconectar Google Calendar desde el dashboard (revocar acceso en myaccount.google.com primero)' });
    }
  } catch (e) {
    result.steps.push({ step: 'tokens', ok: false, error: e.message });
    return result;
  }

  // PASO 2: Obtener cliente autenticado
  try {
    const { cal, calId } = await getCalendarClient(uid);
    result.steps.push({ step: 'auth', ok: true, calendarId: calId });

    // PASO 3: Listar calendarios disponibles
    try {
      const calList = await cal.calendarList.list();
      const calendars = (calList.data.items || []).map(c => ({
        id: c.id,
        summary: c.summary,
        primary: c.primary || false,
        accessRole: c.accessRole
      }));
      result.steps.push({ step: 'calendars', ok: true, count: calendars.length, list: calendars });
    } catch (e) {
      result.steps.push({ step: 'calendars', ok: false, error: e.message });
    }

    // PASO 4: Listar eventos de hoy
    try {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      const eventsRes = await cal.events.list({
        calendarId: calId,
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 20
      });
      const events = (eventsRes.data.items || []).map(e => ({
        id: e.id,
        summary: e.summary,
        start: e.start?.dateTime || e.start?.date,
        status: e.status,
        creator: e.creator?.email
      }));
      result.steps.push({ step: 'events_today', ok: true, count: events.length, events });
    } catch (e) {
      result.steps.push({ step: 'events_today', ok: false, error: e.message });
    }

    // PASO 5: Crear evento de prueba y eliminarlo
    try {
      const testEvent = {
        summary: '[TEST] MIIA Calendar Diagnostic',
        description: 'Evento de prueba creado por MIIA para verificar Calendar. Se elimina automáticamente.',
        start: { dateTime: new Date(Date.now() + 86400000).toISOString(), timeZone: 'America/Bogota' },
        end: { dateTime: new Date(Date.now() + 86400000 + 3600000).toISOString(), timeZone: 'America/Bogota' }
      };
      const created = await cal.events.insert({ calendarId: calId, resource: testEvent });
      const eventId = created.data.id;
      result.steps.push({ step: 'test_create', ok: true, eventId, htmlLink: created.data.htmlLink });

      // Eliminar inmediatamente
      await cal.events.delete({ calendarId: calId, eventId });
      result.steps.push({ step: 'test_delete', ok: true });
    } catch (e) {
      result.steps.push({ step: 'test_create', ok: false, error: e.message });
    }

    result.ok = result.steps.every(s => s.ok !== false);
  } catch (e) {
    result.steps.push({ step: 'auth', ok: false, error: e.message });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  getOAuth2Client,
  getCalendarClient,
  getScheduleConfig,
  createCalendarEvent,
  checkCalendarAvailability,
  diagnoseCalendar
};
