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
// CHECK SLOT AVAILABILITY — Verificación inteligente de disponibilidad
// ═══════════════════════════════════════════════════════════════

/**
 * BREATHING_RULES — Minutos de respiro antes/después según contexto.
 * Aprobados por Mariano (sesión 12-abril-2026).
 */
const BREATHING_RULES = {
  medical:  { before: 10, after: 10 },  // Cita médica / legal
  business: { before: 15, after: 15 },  // Reunión negocio
  lead:     { before: 30, after: 30 },  // Lead / demo
  personal: { before: 0,  after: 15 },  // Familia / personal
  owner:    { before: 0,  after: 0  },  // Self-chat (owner decide)
};

/**
 * detectEventCategory — Detecta la categoría de un evento por su razón/hint.
 * @param {string} reason - Razón del evento
 * @param {string} chatType - Tipo de chat: 'owner', 'lead', 'miia_lead', 'family', 'team', etc.
 * @returns {string} Categoría: 'medical', 'business', 'lead', 'personal', 'owner'
 */
function detectEventCategory(reason, chatType) {
  const r = (reason || '').toLowerCase();

  // Owner self-chat siempre = 'owner' (sin respiro forzado)
  if (chatType === 'owner' || chatType === 'self') return 'owner';

  // Médico/legal por contenido
  if (/m[eé]dic|doctor|hospital|cl[ií]nica|dentist|odont|abogad|legal|juzgad|tribunal|urgencia|emergencia/i.test(r)) return 'medical';

  // Lead / demo
  if (chatType === 'lead' || chatType === 'miia_lead' || chatType === 'client') return 'lead';
  if (/demo|presentaci[oó]n|propuesta|cotizaci[oó]n|venta/i.test(r)) return 'lead';

  // Negocio por contenido
  if (/reuni[oó]n|meeting|junta|comit[eé]|trabajo|oficina|proyecto|deadline/i.test(r)) return 'business';

  // Familia / personal
  if (chatType === 'family' || chatType === 'team' || chatType === 'group') return 'personal';
  if (/cumplea[ñn]|almuerz|cena|fiesta|partido|deporte|amig/i.test(r)) return 'personal';

  // Default según chatType
  if (chatType === 'lead' || chatType === 'miia_lead') return 'lead';
  return 'personal';
}

/**
 * checkSlotAvailability — Verifica si un bloque de tiempo cabe en la agenda,
 * considerando respiro antes y después.
 *
 * @param {string} uid - UID del owner
 * @param {string} dateStr - Fecha ISO "2026-04-13"
 * @param {number} startHour - Hora de inicio (0-23)
 * @param {number} startMinute - Minuto de inicio (0-59)
 * @param {number} durationMin - Duración del evento en minutos
 * @param {string} eventCategory - 'medical', 'business', 'lead', 'personal', 'owner'
 * @returns {Promise<{
 *   available: boolean,
 *   conflicts: Array<{title: string, start: Date, end: Date}>,
 *   nearestSlot: {startH: number, startM: number, endH: number, endM: number, gapMinutes: number} | null,
 *   breathingBefore: number,
 *   breathingAfter: number,
 *   requestedStart: string,
 *   requestedEnd: string
 * }>}
 */
async function checkSlotAvailability(uid, dateStr, startHour, startMinute, durationMin, eventCategory = 'personal') {
  const breathing = BREATHING_RULES[eventCategory] || BREATHING_RULES.personal;
  const result = {
    available: false,
    conflicts: [],
    nearestSlot: null,
    breathingBefore: breathing.before,
    breathingAfter: breathing.after,
    requestedStart: `${String(startHour).padStart(2, '0')}:${String(startMinute).padStart(2, '0')}`,
    requestedEnd: '',
  };

  // Calcular bloque completo: respiro_antes + evento + respiro_después
  const totalBlockMin = breathing.before + durationMin + breathing.after;
  const eventEndTotal = startHour * 60 + startMinute + durationMin;
  const eventEndH = Math.floor(eventEndTotal / 60);
  const eventEndM = eventEndTotal % 60;
  result.requestedEnd = `${String(eventEndH).padStart(2, '0')}:${String(eventEndM).padStart(2, '0')}`;

  // Bloque con respiro (para verificar conflictos)
  const blockStartMin = Math.max(0, startHour * 60 + startMinute - breathing.before);
  const blockEndMin = startHour * 60 + startMinute + durationMin + breathing.after;

  try {
    const { cal, calId } = await getCalendarClient(uid);

    // Buscar eventos del día completo (6am a 23pm para cubrir edge cases)
    const dayStart = new Date(dateStr + 'T06:00:00');
    const dayEnd = new Date(dateStr + 'T23:00:00');

    const response = await cal.events.list({
      calendarId: calId,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = (response.data.items || [])
      .filter(e => e.status !== 'cancelled')
      .map(e => ({
        title: e.summary || '(sin título)',
        start: new Date(e.start.dateTime || e.start.date),
        end: new Date(e.end.dateTime || e.end.date),
        startMin: null, endMin: null
      }));

    // Convertir a minutos del día para fácil comparación
    for (const evt of events) {
      evt.startMin = evt.start.getHours() * 60 + evt.start.getMinutes();
      evt.endMin = evt.end.getHours() * 60 + evt.end.getMinutes();
    }

    // Verificar conflictos (incluyendo respiro)
    for (const evt of events) {
      if (evt.startMin < blockEndMin && evt.endMin > blockStartMin) {
        result.conflicts.push({ title: evt.title, start: evt.start, end: evt.end, startMin: evt.startMin, endMin: evt.endMin });
      }
    }

    result.available = result.conflicts.length === 0;

    // Si no está disponible, buscar el hueco más cercano
    if (!result.available) {
      const schedCfg = await getScheduleConfig(uid);
      const workStart = (schedCfg?.workStartHour || 9) * 60;
      const workEnd = (schedCfg?.workEndHour || 18) * 60;

      // Ordenar todos los eventos por inicio
      const sorted = events.sort((a, b) => a.startMin - b.startMin);

      // Buscar huecos entre eventos (y antes del primer evento / después del último)
      const gaps = [];

      // Hueco antes del primer evento
      if (sorted.length === 0 || sorted[0].startMin > workStart) {
        const gapEnd = sorted.length > 0 ? sorted[0].startMin : workEnd;
        gaps.push({ startMin: workStart, endMin: gapEnd });
      }

      // Huecos entre eventos
      for (let i = 0; i < sorted.length - 1; i++) {
        const gapStart = sorted[i].endMin;
        const gapEnd = sorted[i + 1].startMin;
        if (gapEnd - gapStart >= totalBlockMin) {
          gaps.push({ startMin: gapStart, endMin: gapEnd });
        }
      }

      // Hueco después del último evento
      if (sorted.length > 0) {
        const lastEnd = sorted[sorted.length - 1].endMin;
        if (lastEnd < workEnd) {
          gaps.push({ startMin: lastEnd, endMin: workEnd });
        }
      }

      // Encontrar el hueco más cercano a la hora solicitada
      const requestedMin = startHour * 60 + startMinute;
      let bestGap = null;
      let bestDistance = Infinity;

      for (const gap of gaps) {
        // El evento empieza después del respiro_antes dentro del hueco
        const possibleStart = Math.max(gap.startMin + breathing.before, gap.startMin);
        const possibleEnd = possibleStart + durationMin + breathing.after;

        if (possibleEnd <= gap.endMin && possibleStart + durationMin <= workEnd) {
          const distance = Math.abs(possibleStart - requestedMin);
          if (distance < bestDistance) {
            bestDistance = distance;
            const sH = Math.floor(possibleStart / 60);
            const sM = possibleStart % 60;
            const eTotal = possibleStart + durationMin;
            const eH = Math.floor(eTotal / 60);
            const eM = eTotal % 60;
            bestGap = {
              startH: sH, startM: sM,
              endH: eH, endM: eM,
              gapMinutes: gap.endMin - gap.startMin
            };
          }
        }
      }

      result.nearestSlot = bestGap;
    }

    console.log(`[AVAILABILITY] 📅 ${dateStr} ${result.requestedStart}-${result.requestedEnd} (${durationMin}min, cat=${eventCategory}, respiro=${breathing.before}+${breathing.after}): ${result.available ? '✅ LIBRE' : `❌ ${result.conflicts.length} conflicto(s)`}${result.nearestSlot ? ` → alternativa ${result.nearestSlot.startH}:${String(result.nearestSlot.startM).padStart(2,'0')}` : ''}`);

  } catch (calErr) {
    // Si Calendar no está conectado, asumir disponible (mejor agendar que perder el evento)
    console.warn(`[AVAILABILITY] ⚠️ Calendar no disponible para uid=${uid.substring(0, 8)}: ${calErr.message} — asumiendo LIBRE`);
    result.available = true;
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
  checkSlotAvailability,
  detectEventCategory,
  BREATHING_RULES,
  diagnoseCalendar
};
