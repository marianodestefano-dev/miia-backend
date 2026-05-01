'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const NOTIFICATION_CHANNELS = Object.freeze(['whatsapp', 'email', 'sms', 'push', 'webhook']);
const NOTIFICATION_STATUSES = Object.freeze(['pending', 'sent', 'delivered', 'failed', 'cancelled', 'scheduled']);
const NOTIFICATION_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);
const NOTIFICATION_TYPES = Object.freeze([
  'appointment_reminder', 'payment_confirmed', 'payment_overdue',
  'welcome', 'follow_up', 'broadcast', 'alert', 'coupon', 'custom',
]);

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2000;
const MAX_BATCH_SIZE = 100;
const MAX_BODY_LENGTH = 4096;

function isValidChannel(c) { return NOTIFICATION_CHANNELS.includes(c); }
function isValidStatus(s) { return NOTIFICATION_STATUSES.includes(s); }
function isValidPriority(p) { return NOTIFICATION_PRIORITIES.includes(p); }
function isValidType(t) { return NOTIFICATION_TYPES.includes(t); }

function buildNotificationId(uid, channel) {
  return uid.slice(0, 8) + '_notif_' + channel.slice(0, 4) + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
}

function buildNotificationRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const channel = isValidChannel(data.channel) ? data.channel : 'whatsapp';
  const notificationId = data.notificationId || buildNotificationId(uid, channel);
  const scheduledAt = typeof data.scheduledAt === 'number' && data.scheduledAt > now
    ? data.scheduledAt : null;
  const status = scheduledAt ? 'scheduled' : 'pending';
  return {
    notificationId,
    uid,
    channel,
    type: isValidType(data.type) ? data.type : 'custom',
    priority: isValidPriority(data.priority) ? data.priority : 'normal',
    status,
    recipientPhone: typeof data.recipientPhone === 'string' ? data.recipientPhone.trim() : null,
    recipientEmail: typeof data.recipientEmail === 'string' ? data.recipientEmail.trim() : null,
    recipientName: typeof data.recipientName === 'string' ? data.recipientName.trim().slice(0, 100) : '',
    subject: typeof data.subject === 'string' ? data.subject.trim().slice(0, 150) : '',
    body: typeof data.body === 'string' ? data.body.slice(0, MAX_BODY_LENGTH) : '',
    templateId: data.templateId || null,
    templateVars: data.templateVars && typeof data.templateVars === 'object' ? { ...data.templateVars } : {},
    attempts: 0,
    maxAttempts: MAX_RETRY_ATTEMPTS,
    lastError: null,
    scheduledAt,
    sentAt: null,
    deliveredAt: null,
    failedAt: null,
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

function buildBatchNotifications(uid, recipients, sharedData) {
  sharedData = sharedData || {};
  if (!Array.isArray(recipients) || recipients.length === 0) return [];
  const batch = recipients.slice(0, MAX_BATCH_SIZE);
  return batch.map(recipient => buildNotificationRecord(uid, {
    ...sharedData,
    recipientPhone: recipient.phone || sharedData.recipientPhone,
    recipientEmail: recipient.email || sharedData.recipientEmail,
    recipientName: recipient.name || sharedData.recipientName,
    templateVars: { ...(sharedData.templateVars || {}), ...(recipient.templateVars || {}) },
  }));
}

function applyDispatchResult(notification, result) {
  const now = Date.now();
  const attempts = (notification.attempts || 0) + 1;
  if (result.success) {
    return {
      ...notification,
      status: 'sent',
      attempts,
      sentAt: now,
      lastError: null,
      updatedAt: now,
    };
  }
  const failed = attempts >= notification.maxAttempts;
  return {
    ...notification,
    status: failed ? 'failed' : 'pending',
    attempts,
    lastError: typeof result.error === 'string' ? result.error.slice(0, 200) : 'unknown error',
    failedAt: failed ? now : null,
    updatedAt: now,
  };
}

function markDelivered(notification) {
  if (notification.status !== 'sent') {
    throw new Error('Solo se puede marcar como entregada una notificacion enviada');
  }
  const now = Date.now();
  return { ...notification, status: 'delivered', deliveredAt: now, updatedAt: now };
}

function cancelNotification(notification) {
  if (notification.status === 'sent' || notification.status === 'delivered') {
    throw new Error('No se puede cancelar una notificacion ya enviada o entregada');
  }
  if (notification.status === 'cancelled') {
    throw new Error('La notificacion ya esta cancelada');
  }
  const now = Date.now();
  return { ...notification, status: 'cancelled', updatedAt: now };
}

function shouldRetry(notification) {
  if (!notification) return false;
  if (notification.status !== 'pending') return false;
  if (notification.attempts >= notification.maxAttempts) return false;
  return true;
}

function computeNextRetryMs(attempts) {
  return Math.min(RETRY_BACKOFF_MS * Math.pow(2, attempts), 30000);
}

function buildNotificationSummaryText(notification) {
  if (!notification) return 'Notificacion no encontrada.';
  const icons = {
    pending: '\u{23F3}', sent: '\u{2705}', delivered: '\u{1F4EC}',
    failed: '\u{274C}', cancelled: '\u{26D4}', scheduled: '\u{1F4C5}',
  };
  const icon = icons[notification.status] || '\u{1F514}';
  const lines = [
    icon + ' *Notificacion ' + notification.channel.toUpperCase() + '*',
    'Tipo: ' + notification.type + ' | Prioridad: ' + notification.priority,
    'Estado: ' + notification.status,
  ];
  if (notification.recipientName) lines.push('Destinatario: ' + notification.recipientName);
  if (notification.recipientPhone) lines.push('Telefono: ' + notification.recipientPhone);
  if (notification.recipientEmail) lines.push('Email: ' + notification.recipientEmail);
  if (notification.subject) lines.push('Asunto: ' + notification.subject);
  if (notification.attempts > 0) lines.push('Intentos: ' + notification.attempts + '/' + notification.maxAttempts);
  if (notification.lastError) lines.push('Ultimo error: ' + notification.lastError.slice(0, 80));
  if (notification.scheduledAt) lines.push('Programada: ' + new Date(notification.scheduledAt).toISOString().slice(0, 16));
  return lines.join('\n');
}

async function saveNotification(uid, notification) {
  console.log('[NOTIF] Guardando uid=' + uid + ' id=' + notification.notificationId + ' channel=' + notification.channel + ' status=' + notification.status);
  try {
    await db().collection('owners').doc(uid)
      .collection('notifications').doc(notification.notificationId)
      .set(notification, { merge: false });
    return notification.notificationId;
  } catch (err) {
    console.error('[NOTIF] Error guardando notificacion:', err.message);
    throw err;
  }
}

async function getNotification(uid, notificationId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('notifications').doc(notificationId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[NOTIF] Error obteniendo notificacion:', err.message);
    return null;
  }
}

async function updateNotification(uid, notificationId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  try {
    await db().collection('owners').doc(uid)
      .collection('notifications').doc(notificationId)
      .set(update, { merge: true });
    return notificationId;
  } catch (err) {
    console.error('[NOTIF] Error actualizando notificacion:', err.message);
    throw err;
  }
}

async function listPendingNotifications(uid, opts) {
  opts = opts || {};
  try {
    let q = db().collection('owners').doc(uid).collection('notifications')
      .where('status', '==', 'pending');
    const snap = await q.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      if (opts.channel && rec.channel !== opts.channel) return;
      if (opts.priority && rec.priority !== opts.priority) return;
      results.push(rec);
    });
    results.sort((a, b) => {
      const pOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
      return (pOrder[a.priority] || 2) - (pOrder[b.priority] || 2);
    });
    return results.slice(0, opts.limit || 50);
  } catch (err) {
    console.error('[NOTIF] Error listando notificaciones pendientes:', err.message);
    return [];
  }
}

async function listScheduledNotifications(uid, beforeTs) {
  try {
    let q = db().collection('owners').doc(uid).collection('notifications')
      .where('status', '==', 'scheduled');
    if (typeof beforeTs === 'number') {
      q = q.where('scheduledAt', '<=', beforeTs);
    }
    const snap = await q.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results;
  } catch (err) {
    console.error('[NOTIF] Error listando notificaciones programadas:', err.message);
    return [];
  }
}

module.exports = {
  buildNotificationRecord,
  buildBatchNotifications,
  applyDispatchResult,
  markDelivered,
  cancelNotification,
  shouldRetry,
  computeNextRetryMs,
  buildNotificationSummaryText,
  saveNotification,
  getNotification,
  updateNotification,
  listPendingNotifications,
  listScheduledNotifications,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_TYPES,
  MAX_RETRY_ATTEMPTS,
  MAX_BATCH_SIZE,
  MAX_BODY_LENGTH,
  __setFirestoreForTests,
};
