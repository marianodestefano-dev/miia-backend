'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const BROADCAST_STATUSES = Object.freeze(['draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed']);
const BROADCAST_TYPES = Object.freeze(['promotional', 'reminder', 'announcement', 'follow_up', 'reactivation', 'custom']);
const RECIPIENT_STATUSES = Object.freeze(['pending', 'sent', 'failed', 'bounced', 'opted_out']);

const MAX_RECIPIENTS_PER_BROADCAST = 1000;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_BROADCAST_NAME_LENGTH = 120;
const MIN_INTERVAL_BETWEEN_SENDS_MS = 1500;
const BROADCAST_VERSION = '1.0';

function isValidStatus(s) { return BROADCAST_STATUSES.includes(s); }
function isValidType(t) { return BROADCAST_TYPES.includes(t); }
function isValidRecipientStatus(s) { return RECIPIENT_STATUSES.includes(s); }

function isValidPhone(phone) {
  return typeof phone === 'string' && /^\+[1-9]\d{6,14}$/.test(phone.trim());
}

function buildBroadcastId(uid, name) {
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 20);
  const ts = Date.now().toString(36);
  return uid.slice(0, 8) + '_bc_' + slug + '_' + ts;
}

function buildBroadcastRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const name = typeof data.name === 'string' ? data.name.trim().slice(0, MAX_BROADCAST_NAME_LENGTH) : '';
  const broadcastId = data.broadcastId || buildBroadcastId(uid, name);
  const message = typeof data.message === 'string' ? data.message.slice(0, MAX_MESSAGE_LENGTH) : '';
  const recipients = Array.isArray(data.recipients)
    ? [...new Set(data.recipients.filter(isValidPhone))]
    : [];
  return {
    broadcastId,
    uid,
    version: BROADCAST_VERSION,
    name,
    message,
    type: isValidType(data.type) ? data.type : 'custom',
    status: isValidStatus(data.status) ? data.status : 'draft',
    recipients,
    recipientCount: recipients.length,
    scheduledAt: typeof data.scheduledAt === 'number' ? data.scheduledAt : null,
    sentCount: 0,
    failedCount: 0,
    optedOutCount: 0,
    results: {},
    metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
    createdAt: data.createdAt || now,
    updatedAt: now,
    sentAt: null,
  };
}

function validateBroadcastContent(data) {
  const errors = [];
  if (!data.name || (typeof data.name === 'string' && data.name.trim().length === 0)) {
    errors.push('name es requerido');
  }
  if (!data.message || (typeof data.message === 'string' && data.message.trim().length === 0)) {
    errors.push('message es requerido');
  }
  if (data.message && data.message.length > MAX_MESSAGE_LENGTH) {
    errors.push('message excede MAX_MESSAGE_LENGTH (' + MAX_MESSAGE_LENGTH + ')');
  }
  if (!data.recipients || !Array.isArray(data.recipients) || data.recipients.length === 0) {
    errors.push('recipients no puede estar vacio');
  }
  if (data.recipients && data.recipients.length > MAX_RECIPIENTS_PER_BROADCAST) {
    errors.push('recipients excede MAX_RECIPIENTS_PER_BROADCAST (' + MAX_RECIPIENTS_PER_BROADCAST + ')');
  }
  return { valid: errors.length === 0, errors };
}

function addRecipients(broadcast, phones) {
  if (!Array.isArray(phones)) return broadcast;
  const validPhones = phones.filter(isValidPhone);
  const existing = new Set(broadcast.recipients);
  validPhones.forEach(p => existing.add(p));
  const newRecipients = [...existing];
  if (newRecipients.length > MAX_RECIPIENTS_PER_BROADCAST) {
    throw new Error('recipients excede MAX_RECIPIENTS_PER_BROADCAST (' + MAX_RECIPIENTS_PER_BROADCAST + ')');
  }
  return {
    ...broadcast,
    recipients: newRecipients,
    recipientCount: newRecipients.length,
    updatedAt: Date.now(),
  };
}

function removeRecipient(broadcast, phone) {
  const filtered = broadcast.recipients.filter(p => p !== phone);
  return {
    ...broadcast,
    recipients: filtered,
    recipientCount: filtered.length,
    updatedAt: Date.now(),
  };
}

function scheduleBroadcast(broadcast, scheduledAt) {
  if (typeof scheduledAt !== 'number' || scheduledAt <= Date.now()) {
    throw new Error('scheduledAt debe ser timestamp futuro');
  }
  if (broadcast.status !== 'draft') {
    throw new Error('solo se puede agendar un broadcast en estado draft');
  }
  return {
    ...broadcast,
    scheduledAt,
    status: 'scheduled',
    updatedAt: Date.now(),
  };
}

function computeBroadcastStats(results) {
  if (!results || typeof results !== 'object') {
    return { sentCount: 0, failedCount: 0, optedOutCount: 0, pendingCount: 0, deliveryRate: 0 };
  }
  const values = Object.values(results);
  const sentCount = values.filter(r => r === 'sent').length;
  const failedCount = values.filter(r => r === 'failed' || r === 'bounced').length;
  const optedOutCount = values.filter(r => r === 'opted_out').length;
  const pendingCount = values.filter(r => r === 'pending').length;
  const total = values.length;
  const deliveryRate = total > 0 ? Math.round((sentCount / total) * 100) : 0;
  return { sentCount, failedCount, optedOutCount, pendingCount, deliveryRate };
}

function buildBroadcastSummaryText(broadcast) {
  if (!broadcast) return 'Broadcast no encontrado.';
  const stats = computeBroadcastStats(broadcast.results);
  const parts = [];
  parts.push('\u{1F4E2} *Broadcast: ' + (broadcast.name || 'Sin nombre') + '*');
  parts.push('Estado: ' + broadcast.status);
  parts.push('Tipo: ' + broadcast.type);
  parts.push('Destinatarios: ' + broadcast.recipientCount);
  if (broadcast.scheduledAt) {
    parts.push('Agendado: ' + new Date(broadcast.scheduledAt).toISOString().slice(0, 16).replace('T', ' '));
  }
  if (broadcast.status === 'sent' || broadcast.status === 'sending') {
    parts.push('Enviados: ' + stats.sentCount + ' / Fallidos: ' + stats.failedCount);
    parts.push('Tasa de entrega: ' + stats.deliveryRate + '%');
  }
  return parts.join('\n');
}

async function saveBroadcast(uid, broadcast) {
  console.log('[BROADCAST] Guardando uid=' + uid + ' id=' + broadcast.broadcastId + ' status=' + broadcast.status);
  try {
    await db().collection('owners').doc(uid)
      .collection('broadcasts').doc(broadcast.broadcastId)
      .set(broadcast, { merge: false });
    return broadcast.broadcastId;
  } catch (err) {
    console.error('[BROADCAST] Error guardando:', err.message);
    throw err;
  }
}

async function getBroadcast(uid, broadcastId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('broadcasts').doc(broadcastId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[BROADCAST] Error obteniendo:', err.message);
    return null;
  }
}

async function updateBroadcastStatus(uid, broadcastId, status, extraFields) {
  if (!isValidStatus(status)) throw new Error('status invalido: ' + status);
  const update = { status, updatedAt: Date.now(), ...(extraFields || {}) };
  if (status === 'sent') update.sentAt = Date.now();
  console.log('[BROADCAST] Actualizando status uid=' + uid + ' id=' + broadcastId + ' -> ' + status);
  try {
    await db().collection('owners').doc(uid)
      .collection('broadcasts').doc(broadcastId)
      .set(update, { merge: true });
    return broadcastId;
  } catch (err) {
    console.error('[BROADCAST] Error actualizando status:', err.message);
    throw err;
  }
}

async function recordRecipientResult(uid, broadcastId, phone, result) {
  if (!isValidRecipientStatus(result)) throw new Error('result invalido: ' + result);
  const update = {
    ['results.' + phone.replace(/\+/g, '_plus_')]: result,
    updatedAt: Date.now(),
  };
  try {
    await db().collection('owners').doc(uid)
      .collection('broadcasts').doc(broadcastId)
      .set(update, { merge: true });
    return true;
  } catch (err) {
    console.error('[BROADCAST] Error guardando resultado:', err.message);
    return false;
  }
}

async function listBroadcasts(uid, opts) {
  opts = opts || {};
  try {
    let q = db().collection('owners').doc(uid).collection('broadcasts');
    if (opts.status && isValidStatus(opts.status)) {
      q = q.where('status', '==', opts.status);
    }
    const snap = await q.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;
    return results.slice(0, limit);
  } catch (err) {
    console.error('[BROADCAST] Error listando:', err.message);
    return [];
  }
}

module.exports = {
  buildBroadcastRecord,
  validateBroadcastContent,
  addRecipients,
  removeRecipient,
  scheduleBroadcast,
  computeBroadcastStats,
  buildBroadcastSummaryText,
  saveBroadcast,
  getBroadcast,
  updateBroadcastStatus,
  recordRecipientResult,
  listBroadcasts,
  isValidPhone,
  BROADCAST_STATUSES,
  BROADCAST_TYPES,
  RECIPIENT_STATUSES,
  MAX_RECIPIENTS_PER_BROADCAST,
  MAX_MESSAGE_LENGTH,
  MIN_INTERVAL_BETWEEN_SENDS_MS,
  __setFirestoreForTests,
};
