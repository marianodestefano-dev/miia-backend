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
 * @param {number} opts.endHour - Hora fin (0-23)
 * @param {string} opts.attendeeEmail - Email del invitado (opcional)
 * @param {string} opts.description - Descripción del evento
 * @param {string} opts.uid - UID del owner en Firestore
 * @param {string} opts.timezone - Timezone IANA (ej: 'America/Bogota')
 * @param {string} opts.eventMode - 'presencial' | 'virtual' | 'telefono' (default: 'presencial')
 * @param {string} opts.location - Dirección física para presencial (opcional)
 * @param {string} opts.phoneNumber - Número de teléfono para modo telefónico (opcional)
 * @param {number} opts.reminderMinutes - Minutos antes para recordatorio (default: 10)
 */
async function createCalendarEvent({ summary, dateStr, startHour, endHour, attendeeEmail, description, uid, timezone, eventMode, location, phoneNumber, reminderMinutes }) {
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
  const year = targetDate.getUTCFullYear() || new Date().getFullYear();
  const month = String((targetDate.getUTCMonth() || new Date().getMonth()) + 1).padStart(2, '0');
  const day = String(targetDate.getUTCDate() || new Date().getDate()).padStart(2, '0');
  const sH = String(startHour || 10).padStart(2, '0');
  const eH = String(endHour || (startHour || 10) + 1).padStart(2, '0');

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
    start: { dateTime: `${year}-${month}-${day}T${sH}:00:00`, timeZone: tz },
    end: { dateTime: `${year}-${month}-${day}T${eH}:00:00`, timeZone: tz },
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

  console.log(`[GCAL] ✅ Evento creado: "${summary}" el ${dateStr} ${sH}:00 (${tz}) modo=${mode} reminder=${reminder}min uid=${uid}${meetLink ? ` meet=${meetLink}` : ''}`);
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
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  getOAuth2Client,
  getCalendarClient,
  getScheduleConfig,
  createCalendarEvent,
  checkCalendarAvailability
};
