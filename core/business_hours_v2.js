'use strict';

/**
 * MIIA - Business Hours V2 (T160)
 * Soporte de horarios de atencion con feriados, dias especiales y zonas horarias.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

const DAYS_OF_WEEK = Object.freeze(['sunday','monday','tuesday','wednesday','thursday','friday','saturday']);
const DAY_INDEX = Object.freeze(DAYS_OF_WEEK.reduce((acc,d,i) => { acc[d]=i; return acc; }, {}));

const DEFAULT_SCHEDULE = Object.freeze({
  monday: [{ open: '09:00', close: '18:00' }],
  tuesday: [{ open: '09:00', close: '18:00' }],
  wednesday: [{ open: '09:00', close: '18:00' }],
  thursday: [{ open: '09:00', close: '18:00' }],
  friday: [{ open: '09:00', close: '17:00' }],
  saturday: [],
  sunday: [],
});

function isBusinessOpen(schedule, nowMs) {
  if (!schedule || typeof schedule !== 'object') throw new Error('schedule requerido');
  const now = nowMs ? new Date(nowMs) : new Date();
  const tz = schedule.timezone || 'UTC';
  const localStr = now.toLocaleString('en-US', { timeZone: tz });
  const local = new Date(localStr);
  const dayName = DAYS_OF_WEEK[local.getDay()];
  const dateKey = _dateKey(local);
  const timeMinutes = local.getHours() * 60 + local.getMinutes();

  const holidays = schedule.holidays || [];
  if (holidays.includes(dateKey)) {
    return { isOpen: false, reason: 'holiday', nextOpen: _findNextOpen(schedule, local) };
  }

  const specialDays = schedule.specialDays || [];
  const special = specialDays.find(sd => sd.date === dateKey);
  if (special) {
    const slots = special.slots || [];
    if (slots.length === 0) return { isOpen: false, reason: 'special_closed', nextOpen: _findNextOpen(schedule, local) };
    const open = slots.some(s => _inSlot(timeMinutes, s));
    return { isOpen: open, reason: open ? 'special_open' : 'special_outside_hours', nextOpen: open ? null : _findNextOpen(schedule, local) };
  }

  const daySlots = schedule[dayName] || [];
  if (daySlots.length === 0) return { isOpen: false, reason: 'closed_day', nextOpen: _findNextOpen(schedule, local) };
  const open = daySlots.some(s => _inSlot(timeMinutes, s));
  return { isOpen: open, reason: open ? 'open' : 'outside_hours', nextOpen: open ? null : _findNextOpen(schedule, local) };
}

async function getSchedule(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('business_hours').doc(uid).get();
    if (!snap.exists) return { ...DEFAULT_SCHEDULE, holidays: [], specialDays: [], timezone: 'UTC' };
    return snap.data();
  } catch (e) {
    console.error('[BH_V2] Error leyendo schedule uid=' + uid.substring(0,8) + ': ' + e.message);
    return { ...DEFAULT_SCHEDULE, holidays: [], specialDays: [], timezone: 'UTC' };
  }
}

async function saveSchedule(uid, schedule) {
  if (!uid) throw new Error('uid requerido');
  if (!schedule || typeof schedule !== 'object') throw new Error('schedule requerido');
  const errors = validateSchedule(schedule);
  if (errors.length > 0) throw new Error('schedule invalido: ' + errors.join(', '));
  try {
    await db().collection('business_hours').doc(uid).set(schedule);
    console.log('[BH_V2] schedule guardado uid=' + uid.substring(0,8));
  } catch (e) {
    console.error('[BH_V2] Error guardando uid=' + uid.substring(0,8) + ': ' + e.message);
    throw e;
  }
}

function validateSchedule(schedule) {
  const errors = [];
  if (!schedule || typeof schedule !== 'object') return ['schedule requerido'];
  for (const day of DAYS_OF_WEEK) {
    const slots = schedule[day];
    if (slots === undefined) continue;
    if (!Array.isArray(slots)) { errors.push(day + ' debe ser array'); continue; }
    for (const slot of slots) {
      if (!_isValidTimeStr(slot.open)) errors.push(day + ': open invalido (' + slot.open + ')');
      if (!_isValidTimeStr(slot.close)) errors.push(day + ': close invalido (' + slot.close + ')');
      if (_isValidTimeStr(slot.open) && _isValidTimeStr(slot.close)) {
        if (_timeToMinutes(slot.open) >= _timeToMinutes(slot.close))
          errors.push(day + ': open debe ser antes de close');
      }
    }
  }
  if (schedule.holidays !== undefined && !Array.isArray(schedule.holidays)) errors.push('holidays debe ser array');
  if (schedule.specialDays !== undefined && !Array.isArray(schedule.specialDays)) errors.push('specialDays debe ser array');
  return errors;
}

function addHoliday(schedule, dateStr) {
  if (!schedule) throw new Error('schedule requerido');
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('fecha invalida (YYYY-MM-DD)');
  const holidays = schedule.holidays ? [...schedule.holidays] : [];
  if (!holidays.includes(dateStr)) holidays.push(dateStr);
  return { ...schedule, holidays };
}

function addSpecialDay(schedule, dateStr, slots) {
  if (!schedule) throw new Error('schedule requerido');
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('fecha invalida (YYYY-MM-DD)');
  if (!Array.isArray(slots)) throw new Error('slots debe ser array');
  const specialDays = (schedule.specialDays || []).filter(sd => sd.date !== dateStr);
  specialDays.push({ date: dateStr, slots });
  return { ...schedule, specialDays };
}

function _inSlot(timeMinutes, slot) {
  return timeMinutes >= _timeToMinutes(slot.open) && timeMinutes < _timeToMinutes(slot.close);
}

function _timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function _isValidTimeStr(str) {
  return typeof str === 'string' && /^\d{2}:\d{2}$/.test(str);
}

function _dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function _findNextOpen(schedule, localNow) {
  for (let i = 1; i <= 7; i++) {
    const next = new Date(localNow);
    next.setDate(next.getDate() + i);
    const nextDateKey = _dateKey(next);
    const nextDay = DAYS_OF_WEEK[next.getDay()];
    if ((schedule.holidays || []).includes(nextDateKey)) continue;
    const special = (schedule.specialDays || []).find(sd => sd.date === nextDateKey);
    if (special) {
      if (special.slots && special.slots.length > 0) return nextDateKey + 'T' + special.slots[0].open;
      continue;
    }
    const slots = schedule[nextDay] || [];
    if (slots.length > 0) return nextDateKey + 'T' + slots[0].open;
  }
  return null;
}

module.exports = {
  isBusinessOpen, getSchedule, saveSchedule, validateSchedule,
  addHoliday, addSpecialDay,
  DAYS_OF_WEEK, DAY_INDEX, DEFAULT_SCHEDULE,
  __setFirestoreForTests,
};
