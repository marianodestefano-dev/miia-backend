'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const IOT_DEVICE_TYPES = Object.freeze(['light', 'lock', 'thermostat', 'camera', 'display', 'speaker', 'alarm']);
const DEVICE_STATUS = Object.freeze(['online', 'offline', 'error', 'standby']);
const SCHEDULE_ACTIONS = Object.freeze(['open', 'close', 'lights_on', 'lights_off', 'alarm_on', 'alarm_off']);

async function registerDevice(uid, opts) {
  if (!IOT_DEVICE_TYPES.includes(opts.type)) throw new Error('Invalid device type: ' + opts.type);
  const device = { id: randomUUID(), uid, name: opts.name, type: opts.type, deviceId: opts.deviceId, provider: opts.provider || 'generic', status: 'online', registeredAt: new Date().toISOString() };
  await getDb().collection('iot_devices').doc(device.id).set(device);
  return device;
}

async function sendDeviceCommand(uid, deviceId, command, payload) {
  const cmd = { id: randomUUID(), uid, deviceId, command, payload: payload || {}, status: 'sent', sentAt: new Date().toISOString() };
  await getDb().collection('device_commands').doc(cmd.id).set(cmd);
  return cmd;
}

async function scheduleBusinessHours(uid, opts) {
  const { openTime, closeTime, timezone, daysOfWeek } = opts;
  if (!openTime || !closeTime) throw new Error('openTime and closeTime required');
  const schedule = { id: randomUUID(), uid, openTime, closeTime, timezone: timezone || 'America/Bogota', daysOfWeek: daysOfWeek || [1,2,3,4,5], actions: { onOpen: ['lights_on', 'alarm_off'], onClose: ['lights_off', 'alarm_on'] }, status: 'active', createdAt: new Date().toISOString() };
  await getDb().collection('business_schedules').doc(uid).set(schedule, { merge: true });
  return schedule;
}

async function getDevices(uid) {
  const snap = await getDb().collection('iot_devices').where('uid', '==', uid).get();
  const devices = [];
  snap.forEach(doc => devices.push(doc.data()));
  return devices;
}

function buildAutoScheduleMessage(schedule) {
  return 'Horario configurado: ' + schedule.openTime + ' - ' + schedule.closeTime + ' (' + schedule.timezone + '). Dias activos: ' + (schedule.daysOfWeek || []).join(',') + '.';
}

async function recordBusinessOpen(uid, timestamp) {
  const entry = { uid, openedAt: timestamp || new Date().toISOString(), type: 'open' };
  await getDb().collection('business_events').doc(uid + '_' + Date.now()).set(entry);
  return entry;
}

module.exports = { __setFirestoreForTests, IOT_DEVICE_TYPES, DEVICE_STATUS, SCHEDULE_ACTIONS,
  registerDevice, sendDeviceCommand, scheduleBusinessHours, getDevices, buildAutoScheduleMessage, recordBusinessOpen };