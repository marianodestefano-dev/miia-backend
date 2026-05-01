'use strict';

/**
 * MIIA - Calendar V2 (T171/T172/T173)
 * Integracion Google Calendar V2: sincronizacion, propuesta de horarios, recordatorios.
 */

let _httpClient = null;
let _db = null;
function __setHttpClientForTests(c) { _httpClient = c; }
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }
function getHttp() { return _httpClient || { request: _defaultRequest }; }

const GCAL_API_BASE = 'https://www.googleapis.com/calendar/v3';
const DEFAULT_SLOT_DURATION_MINS = 30;
const REMINDER_OFFSET_MINS = 60;
const MAX_SLOTS_PER_DAY = 48;

async function getEvents(uid, calendarId, accessToken, timeMin, timeMax, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!calendarId) throw new Error('calendarId requerido');
  if (!accessToken) throw new Error('accessToken requerido');
  if (!timeMin || !timeMax) throw new Error('timeMin y timeMax requeridos');
  const url = GCAL_API_BASE + '/calendars/' + encodeURIComponent(calendarId) + '/events'
    + '?timeMin=' + encodeURIComponent(timeMin) + '&timeMax=' + encodeURIComponent(timeMax)
    + '&singleEvents=true&orderBy=startTime';
  try {
    const resp = await getHttp().request(url, { method: 'GET', accessToken, timeout: (opts && opts.timeout) || 10000 });
    const events = (resp.items || []).map(ev => ({
      id: ev.id, title: ev.summary || '',
      start: ev.start && (ev.start.dateTime || ev.start.date),
      end: ev.end && (ev.end.dateTime || ev.end.date),
      allDay: !!(ev.start && ev.start.date),
    }));
    console.log('[CAL_V2] getEvents uid=' + uid.substring(0, 8) + ' count=' + events.length);
    return events;
  } catch (e) {
    console.error('[CAL_V2] Error getEvents: ' + e.message);
    throw e;
  }
}

async function createEvent(uid, calendarId, accessToken, event, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!calendarId) throw new Error('calendarId requerido');
  if (!accessToken) throw new Error('accessToken requerido');
  if (!event || !event.title) throw new Error('event.title requerido');
  if (!event.start || !event.end) throw new Error('event.start y event.end requeridos');
  const url = GCAL_API_BASE + '/calendars/' + encodeURIComponent(calendarId) + '/events';
  const body = {
    summary: event.title,
    start: { dateTime: event.start, timeZone: event.timezone || 'UTC' },
    end: { dateTime: event.end, timeZone: event.timezone || 'UTC' },
    description: event.description || '',
    attendees: event.attendees ? event.attendees.map(email => ({ email })) : [],
    reminders: { useDefault: false, overrides: [{ method: 'email', minutes: REMINDER_OFFSET_MINS }] },
  };
  try {
    const resp = await getHttp().request(url, { method: 'POST', accessToken, body, timeout: (opts && opts.timeout) || 10000 });
    console.log('[CAL_V2] createEvent uid=' + uid.substring(0, 8) + ' id=' + resp.id);
    return { id: resp.id, ...event, calendarEventId: resp.id };
  } catch (e) {
    console.error('[CAL_V2] Error createEvent: ' + e.message);
    throw e;
  }
}

function proposeAvailableSlots(events, date, opts) {
  if (!Array.isArray(events)) throw new Error('events debe ser array');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date invalida (YYYY-MM-DD)');
  const slotMins = (opts && opts.slotDurationMins) || DEFAULT_SLOT_DURATION_MINS;
  const workStart = (opts && opts.workStart) || '09:00';
  const workEnd = (opts && opts.workEnd) || '18:00';
  const startH = parseInt(workStart.split(':')[0]);
  const startM = parseInt(workStart.split(':')[1]);
  const endH = parseInt(workEnd.split(':')[0]);
  const endM = parseInt(workEnd.split(':')[1]);
  const dayEvents = events.filter(ev => ev.start && ev.start.substring(0, 10) === date && !ev.allDay);
  const slots = [];
  let currentMins = startH * 60 + startM;
  const endMins = endH * 60 + endM;
  while (currentMins + slotMins <= endMins && slots.length < MAX_SLOTS_PER_DAY) {
    const slotStart = date + 'T' + _minsToTime(currentMins) + ':00';
    const slotEnd = date + 'T' + _minsToTime(currentMins + slotMins) + ':00';
    const conflict = dayEvents.some(ev => _eventsOverlap(ev.start, ev.end, slotStart, slotEnd));
    slots.push({ start: slotStart, end: slotEnd, available: !conflict });
    currentMins += slotMins;
  }
  return slots;
}

async function scheduleReminder(uid, event) {
  if (!uid) throw new Error('uid requerido');
  if (!event || !event.id) throw new Error('event.id requerido');
  if (!event.start) throw new Error('event.start requerido');
  if (!event.phone) throw new Error('event.phone requerido');
  const eventTime = new Date(event.start);
  const reminderTime = new Date(eventTime.getTime() - REMINDER_OFFSET_MINS * 60 * 1000);
  const payload = {
    uid, eventId: event.id, phone: event.phone,
    title: event.title || 'Turno', eventStart: event.start,
    reminderAt: reminderTime.toISOString(), sent: false, createdAt: new Date().toISOString(),
  };
  try {
    await db().collection('calendar_reminders').doc(uid).collection('reminders')
      .doc(event.id).set(payload);
    console.log('[CAL_V2] reminder programado uid=' + uid.substring(0, 8) + ' at=' + reminderTime.toISOString());
    return payload;
  } catch (e) {
    console.error('[CAL_V2] Error scheduleReminder: ' + e.message);
    throw e;
  }
}

async function getDueReminders(uid, nowMs) {
  if (!uid) throw new Error('uid requerido');
  const now = new Date(nowMs || Date.now()).toISOString();
  try {
    const snap = await db().collection('calendar_reminders').doc(uid)
      .collection('reminders').where('sent', '==', false).get();
    const due = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (d.reminderAt <= now) due.push({ id: doc.id, ...d });
    });
    return due;
  } catch (e) {
    console.error('[CAL_V2] Error getDueReminders: ' + e.message);
    return [];
  }
}

function _minsToTime(mins) {
  return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
}

function _eventsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

async function _defaultRequest(url, opts) {
  const controller = new AbortController();
  let timer;
  try {
    timer = setTimeout(() => controller.abort(), opts.timeout || 10000);
    const headers = { 'Authorization': 'Bearer ' + opts.accessToken };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const resp = await fetch(url, {
      method: opts.method || 'GET', headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error('Google Calendar API error ' + resp.status);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getEvents, createEvent, proposeAvailableSlots, scheduleReminder, getDueReminders,
  DEFAULT_SLOT_DURATION_MINS, REMINDER_OFFSET_MINS,
  __setHttpClientForTests, __setFirestoreForTests,
};
