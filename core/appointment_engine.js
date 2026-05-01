'use strict';

const APPOINTMENT_STATUSES = Object.freeze([
  'pending', 'confirmed', 'cancelled', 'completed', 'no_show', 'rescheduled',
]);
const APPOINTMENT_TYPES = Object.freeze(['in_person', 'remote', 'phone_call', 'home_visit']);

const SLOT_DURATION_MIN_DEFAULT = 30;
const MAX_APPOINTMENTS_PER_DAY = 20;
const APPOINTMENT_COLLECTION = 'appointments';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidStatus(s) { return APPOINTMENT_STATUSES.includes(s); }
function isValidType(t) { return APPOINTMENT_TYPES.includes(t); }

function isValidDatetime(dt) {
  if (!dt || typeof dt !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dt);
}

function datetimeToMs(dt) {
  if (!isValidDatetime(dt)) return null;
  const d = new Date(dt + ':00.000Z');
  return isNaN(d.getTime()) ? null : d.getTime();
}

function buildAppointmentRecord(uid, phone, datetime, opts = {}) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!isValidDatetime(datetime)) throw new Error('datetime invalido (formato YYYY-MM-DDTHH:MM)');
  const ts = datetimeToMs(datetime);
  if (!ts) throw new Error('datetime invalido');
  const type = isValidType(opts.type) ? opts.type : 'in_person';
  const durationMin = typeof opts.durationMin === 'number' && opts.durationMin > 0
    ? opts.durationMin
    : SLOT_DURATION_MIN_DEFAULT;
  const date = datetime.slice(0, 10);
  const appointmentId = uid.slice(0, 8) + '_' + phone.replace(/\D/g, '').slice(-8) + '_' + datetime.replace(/[^\d]/g, '');
  return {
    appointmentId,
    uid,
    phone,
    datetime,
    date,
    timestampMs: ts,
    endsAtMs: ts + durationMin * 60 * 1000,
    type,
    durationMin,
    status: 'pending',
    contactName: opts.contactName || null,
    notes: opts.notes || null,
    location: opts.location || null,
    price: typeof opts.price === 'number' ? opts.price : null,
    currency: opts.currency || null,
    createdAt: opts.createdAt || Date.now(),
  };
}

async function saveAppointment(uid, record) {
  if (!uid) throw new Error('uid requerido');
  if (!record || !record.appointmentId) throw new Error('record invalido');
  await db()
    .collection('owners').doc(uid)
    .collection(APPOINTMENT_COLLECTION).doc(record.appointmentId)
    .set(record, { merge: true });
  console.log('[APPT] Guardado uid=' + uid + ' phone=' + record.phone + ' datetime=' + record.datetime);
  return record.appointmentId;
}

async function getAppointmentsForDate(uid, date) {
  if (!uid) throw new Error('uid requerido');
  if (!date) throw new Error('date requerido');
  try {
    const snap = await db()
      .collection('owners').doc(uid)
      .collection(APPOINTMENT_COLLECTION)
      .where('date', '==', date)
      .get();
    const docs = [];
    snap.forEach(d => docs.push(d.data()));
    docs.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
    return docs;
  } catch (e) {
    console.error('[APPT] Error getAppointmentsForDate: ' + e.message);
    return [];
  }
}

async function getAppointmentsByPhone(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    const snap = await db()
      .collection('owners').doc(uid)
      .collection(APPOINTMENT_COLLECTION)
      .where('phone', '==', phone)
      .get();
    const docs = [];
    snap.forEach(d => docs.push(d.data()));
    docs.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
    return docs;
  } catch (e) {
    console.error('[APPT] Error getAppointmentsByPhone: ' + e.message);
    return [];
  }
}

function checkConflict(newRecord, existingAppointments) {
  if (!Array.isArray(existingAppointments) || existingAppointments.length === 0) return null;
  const active = existingAppointments.filter(a =>
    a.status !== 'cancelled' && a.status !== 'no_show',
  );
  for (const existing of active) {
    const newStart = newRecord.timestampMs;
    const newEnd = newRecord.endsAtMs;
    const exStart = existing.timestampMs;
    const exEnd = existing.endsAtMs;
    if (newStart < exEnd && newEnd > exStart) {
      return { conflict: true, conflictWith: existing.appointmentId };
    }
  }
  return null;
}

async function updateAppointmentStatus(uid, appointmentId, status, opts = {}) {
  if (!uid) throw new Error('uid requerido');
  if (!appointmentId) throw new Error('appointmentId requerido');
  if (!isValidStatus(status)) throw new Error('status invalido');
  const update = { status, updatedAt: Date.now() };
  if (status === 'confirmed') update.confirmedAt = opts.confirmedAt || Date.now();
  if (status === 'cancelled') update.cancelledAt = Date.now();
  if (status === 'completed') update.completedAt = Date.now();
  if (opts.cancelReason) update.cancelReason = opts.cancelReason;
  if (opts.rescheduleDate && isValidDatetime(opts.rescheduleDate)) {
    update.rescheduleDate = opts.rescheduleDate;
  }
  await db()
    .collection('owners').doc(uid)
    .collection(APPOINTMENT_COLLECTION).doc(appointmentId)
    .set(update, { merge: true });
  console.log('[APPT] Status uid=' + uid + ' id=' + appointmentId + ' -> ' + status);
  return appointmentId;
}

function buildAvailableSlots(date, existingAppointments, opts = {}) {
  const workStart = opts.workStartHour || 9;
  const workEnd = opts.workEndHour || 18;
  const durationMin = opts.durationMin || SLOT_DURATION_MIN_DEFAULT;
  const slots = [];
  const baseDate = new Date(date + 'T00:00:00.000Z');
  const active = (existingAppointments || []).filter(a =>
    a.status !== 'cancelled' && a.status !== 'no_show',
  );
  let hour = workStart;
  let min = 0;
  while (hour < workEnd) {
    const slotDt = date + 'T' + String(hour).padStart(2, '0') + ':' + String(min).padStart(2, '0');
    const slotMs = new Date(slotDt + ':00.000Z').getTime();
    const slotEndMs = slotMs + durationMin * 60 * 1000;
    const isBusy = active.some(a => slotMs < (a.endsAtMs || 0) && slotEndMs > (a.timestampMs || 0));
    if (!isBusy) slots.push({ datetime: slotDt, timestampMs: slotMs });
    min += durationMin;
    if (min >= 60) { hour += Math.floor(min / 60); min = min % 60; }
  }
  return slots;
}

function buildAppointmentText(record) {
  if (!record) return '';
  const statusEmoji = {
    pending: '\u23F3',
    confirmed: '\u2705',
    cancelled: '\u274C',
    completed: '\u{1F4AF}',
    no_show: '\u{1F614}',
    rescheduled: '\u{1F501}',
  };
  const typeLabel = {
    in_person: 'Presencial',
    remote: 'Online',
    phone_call: 'Llamada',
    home_visit: 'Visita a domicilio',
  };
  const emoji = statusEmoji[record.status] || '\u{1F4C5}';
  const lines = [
    emoji + ' *Turno ' + (typeLabel[record.type] || record.type) + '*',
    '\u{1F4C5} Fecha/Hora: ' + record.datetime,
    '\u{1F4DE} Contacto: ' + record.phone + (record.contactName ? ' (' + record.contactName + ')' : ''),
    '\u{1F552} Duracion: ' + record.durationMin + ' min',
    '\u{1F3F7}\uFE0F Estado: ' + record.status,
  ];
  if (record.location) lines.push('\u{1F4CD} Lugar: ' + record.location);
  if (record.price != null) lines.push('\u{1F4B0} Precio: ' + record.price + (record.currency ? ' ' + record.currency : ''));
  if (record.notes) lines.push('\u{1F4DD} Notas: ' + record.notes);
  return lines.join('\n');
}

function buildAvailabilityText(date, slots) {
  if (!Array.isArray(slots) || slots.length === 0) {
    return '\u274C No hay turnos disponibles para ' + date + '.';
  }
  const lines = ['\u{1F4C5} *Turnos disponibles para ' + date + ':*'];
  slots.slice(0, 10).forEach(s => {
    const time = s.datetime.slice(11);
    lines.push('\u23F0 ' + time);
  });
  if (slots.length > 10) lines.push('... y ' + (slots.length - 10) + ' mas');
  return lines.join('\n');
}

module.exports = {
  buildAppointmentRecord, saveAppointment,
  getAppointmentsForDate, getAppointmentsByPhone,
  checkConflict, updateAppointmentStatus,
  buildAvailableSlots, buildAppointmentText, buildAvailabilityText,
  isValidStatus, isValidType, isValidDatetime, datetimeToMs,
  APPOINTMENT_STATUSES, APPOINTMENT_TYPES,
  SLOT_DURATION_MIN_DEFAULT, MAX_APPOINTMENTS_PER_DAY,
  __setFirestoreForTests,
};
