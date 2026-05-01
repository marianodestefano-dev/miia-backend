'use strict';

const FOLLOWUP_STATUSES = Object.freeze(['pending', 'sent', 'skipped', 'cancelled', 'completed']);
const FOLLOWUP_TYPES = Object.freeze([
  'initial_response', 'day1_check', 'day3_reminder',
  'week1_reconnect', 'month1_winback', 'custom',
]);

const DEFAULT_DELAY_MS = Object.freeze({
  initial_response: 0,
  day1_check:       1 * 24 * 60 * 60 * 1000,
  day3_reminder:    3 * 24 * 60 * 60 * 1000,
  week1_reconnect:  7 * 24 * 60 * 60 * 1000,
  month1_winback:   30 * 24 * 60 * 60 * 1000,
  custom:           0,
});

const MAX_FOLLOWUPS_PER_LEAD = 10;
const FOLLOWUP_COLLECTION = 'follow_ups';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidStatus(s) { return FOLLOWUP_STATUSES.includes(s); }
function isValidType(t) { return FOLLOWUP_TYPES.includes(t); }

function buildFollowUpRecord(uid, phone, type, scheduledAt, opts = {}) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!isValidType(type)) throw new Error('type invalido');
  if (typeof scheduledAt !== 'number' || isNaN(scheduledAt)) throw new Error('scheduledAt debe ser timestamp ms');
  const now = Date.now();
  const followUpId = uid.slice(0, 8) + '_' + phone.replace(/\D/g, '').slice(-8) + '_' + type + '_' + scheduledAt;
  return {
    followUpId,
    uid,
    phone,
    type,
    status: 'pending',
    scheduledAt,
    createdAt: opts.createdAt || now,
    message: opts.message || null,
    contactName: opts.contactName || null,
    businessName: opts.businessName || null,
    notes: opts.notes || null,
  };
}

function scheduleFollowUp(uid, phone, type, opts = {}) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!isValidType(type)) throw new Error('type invalido');
  const delayMs = typeof opts.delayMs === 'number' ? opts.delayMs : (DEFAULT_DELAY_MS[type] || 0);
  const scheduledAt = (opts.baseTime || Date.now()) + delayMs;
  return buildFollowUpRecord(uid, phone, type, scheduledAt, opts);
}

async function saveFollowUp(uid, record) {
  if (!uid) throw new Error('uid requerido');
  if (!record || !record.followUpId) throw new Error('record invalido');
  const existing = await db()
    .collection('owners').doc(uid)
    .collection(FOLLOWUP_COLLECTION)
    .where('phone', '==', record.phone)
    .where('status', '==', 'pending')
    .get();
  let pendingCount = 0;
  existing.forEach(() => pendingCount++);
  if (pendingCount >= MAX_FOLLOWUPS_PER_LEAD) {
    throw new Error('max follow-ups alcanzado para este lead');
  }
  await db()
    .collection('owners').doc(uid)
    .collection(FOLLOWUP_COLLECTION).doc(record.followUpId)
    .set(record, { merge: true });
  console.log('[FOLLOWUP] Agendado uid=' + uid + ' phone=' + record.phone + ' type=' + record.type);
  return record.followUpId;
}

async function updateFollowUpStatus(uid, followUpId, status, opts = {}) {
  if (!uid) throw new Error('uid requerido');
  if (!followUpId) throw new Error('followUpId requerido');
  if (!isValidStatus(status)) throw new Error('status invalido');
  const update = { status, updatedAt: Date.now() };
  if (status === 'sent') update.sentAt = opts.sentAt || Date.now();
  await db()
    .collection('owners').doc(uid)
    .collection(FOLLOWUP_COLLECTION).doc(followUpId)
    .set(update, { merge: true });
  console.log('[FOLLOWUP] Status uid=' + uid + ' id=' + followUpId + ' -> ' + status);
  return followUpId;
}

async function getNextFollowUp(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    const snap = await db()
      .collection('owners').doc(uid)
      .collection(FOLLOWUP_COLLECTION)
      .where('phone', '==', phone)
      .where('status', '==', 'pending')
      .get();
    if (snap.empty) return null;
    const docs = [];
    snap.forEach(d => docs.push(d.data()));
    docs.sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
    return docs[0] || null;
  } catch (e) {
    console.error('[FOLLOWUP] Error getNextFollowUp: ' + e.message);
    return null;
  }
}

async function getPendingFollowUps(uid, opts = {}) {
  if (!uid) throw new Error('uid requerido');
  const { phone, type, before, after, limit = 100 } = opts;
  try {
    const snap = await db()
      .collection('owners').doc(uid)
      .collection(FOLLOWUP_COLLECTION)
      .where('status', '==', 'pending')
      .get();
    const docs = [];
    snap.forEach(d => docs.push(d.data()));
    let filtered = docs;
    if (phone) filtered = filtered.filter(d => d.phone === phone);
    if (type && isValidType(type)) filtered = filtered.filter(d => d.type === type);
    if (typeof before === 'number') filtered = filtered.filter(d => d.scheduledAt <= before);
    if (typeof after === 'number') filtered = filtered.filter(d => d.scheduledAt >= after);
    filtered.sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
    return filtered.slice(0, limit);
  } catch (e) {
    console.error('[FOLLOWUP] Error getPendingFollowUps: ' + e.message);
    return [];
  }
}

function buildFollowUpMessage(type, contactName, businessName) {
  const name = contactName || 'ahi';
  const biz = businessName || 'nosotros';
  const templates = {
    initial_response:
      'Hola! Gracias por contactarte con ' + biz + '. En breve te atendemos. \u{1F44B}',
    day1_check:
      'Hola ' + name + ', te escribimos de ' + biz + '. \u00bfPodemos ayudarte con algo? \u{1F60A}',
    day3_reminder:
      'Hola ' + name + '! Quisimos saber si pudimos darte la info que necesitabas. Estamos aqui. \u{1F64C}',
    week1_reconnect:
      'Hola ' + name + ', es ' + biz + '. Pasamos a saludarte y ver si tenes alguna consulta. \u{1F31F}',
    month1_winback:
      'Hola ' + name + '! Ha pasado un tiempo. Tenemos novedades en ' + biz + ' que te pueden interesar. \u{1F4E3}',
    custom: '',
  };
  return templates[type] || '';
}

function buildFollowUpSummaryText(records) {
  if (!Array.isArray(records) || records.length === 0) return 'No hay follow-ups pendientes.';
  const lines = ['\u{1F4E8} *Follow-ups pendientes: ' + records.length + '*'];
  for (const r of records.slice(0, 5)) {
    const date = new Date(r.scheduledAt).toISOString().slice(0, 10);
    lines.push('- ' + r.phone + ' | ' + r.type + ' | ' + date);
  }
  if (records.length > 5) lines.push('... y ' + (records.length - 5) + ' mas');
  return lines.join('\n');
}

module.exports = {
  scheduleFollowUp, buildFollowUpRecord, saveFollowUp,
  updateFollowUpStatus, getNextFollowUp, getPendingFollowUps,
  buildFollowUpMessage, buildFollowUpSummaryText,
  isValidStatus, isValidType,
  FOLLOWUP_STATUSES, FOLLOWUP_TYPES, DEFAULT_DELAY_MS,
  MAX_FOLLOWUPS_PER_LEAD,
  __setFirestoreForTests,
};
