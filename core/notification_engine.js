'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const NOTIFICATION_TYPES = Object.freeze([
  'appointment_reminder', 'appointment_confirmation', 'appointment_cancellation',
  'payment_received', 'payment_failed', 'new_lead', 'follow_up_due',
  'broadcast_complete', 'system_alert', 'custom',
]);

const NOTIFICATION_CHANNELS = Object.freeze(['whatsapp', 'email', 'push', 'sms', 'in_app']);

const NOTIFICATION_STATUSES = Object.freeze(['pending', 'scheduled', 'sent', 'failed', 'cancelled', 'read']);

const NOTIFICATION_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);

const MAX_NOTIFICATION_BODY_LENGTH = 2000;
const MAX_NOTIFICATION_TITLE_LENGTH = 120;
const MAX_PENDING_PER_OWNER = 500;

function isValidType(t) { return NOTIFICATION_TYPES.includes(t); }
function isValidChannel(c) { return NOTIFICATION_CHANNELS.includes(c); }
function isValidStatus(s) { return NOTIFICATION_STATUSES.includes(s); }
function isValidPriority(p) { return NOTIFICATION_PRIORITIES.includes(p); }

function buildNotificationId(uid, type) {
  const ts = Date.now().toString(36);
  const typeSlug = type.replace(/_/g, '').slice(0, 10);
  return uid.slice(0, 8) + '_notif_' + typeSlug + '_' + ts;
}

function buildNotificationRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const notificationId = data.notificationId || buildNotificationId(uid, data.type || 'custom');
  const title = typeof data.title === 'string' ? data.title.trim().slice(0, MAX_NOTIFICATION_TITLE_LENGTH) : '';
  const body = typeof data.body === 'string' ? data.body.slice(0, MAX_NOTIFICATION_BODY_LENGTH) : '';
  return {
    notificationId,
    uid,
    type: isValidType(data.type) ? data.type : 'custom',
    channel: isValidChannel(data.channel) ? data.channel : 'whatsapp',
    status: isValidStatus(data.status) ? data.status : 'pending',
    priority: isValidPriority(data.priority) ? data.priority : 'normal',
    title,
    body,
    recipientPhone: typeof data.recipientPhone === 'string' ? data.recipientPhone.trim() : null,
    recipientEmail: typeof data.recipientEmail === 'string' ? data.recipientEmail.trim() : null,
    scheduledAt: typeof data.scheduledAt === 'number' ? data.scheduledAt : null,
    sentAt: null,
    readAt: null,
    metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

function buildNotificationBody(type, params) {
  params = params || {};
  const name = params.contactName || params.name || '';
  const biz = params.businessName || params.biz || 'tu negocio';
  const dt = params.datetime || params.date || '';
  const amount = params.amount || '';
  const currency = params.currency || 'ARS';

  switch (type) {
    case 'appointment_reminder':
      return (name ? 'Hola ' + name + '! ' : 'Hola! ') +
        'Te recordamos tu turno' + (dt ? ' el ' + dt : '') + ' en ' + biz + '. \u{1F4C5}';
    case 'appointment_confirmation':
      return (name ? 'Hola ' + name + '! ' : 'Hola! ') +
        'Tu turno' + (dt ? ' para el ' + dt : '') + ' fue confirmado. \u{2705}';
    case 'appointment_cancellation':
      return (name ? 'Hola ' + name + ', ' : '') +
        'lamentamos informarte que tu turno' + (dt ? ' del ' + dt : '') + ' fue cancelado. \u{274C}';
    case 'payment_received':
      return '\u{1F4B0} Pago recibido: ' + amount + ' ' + currency +
        (name ? ' de ' + name : '') + '. Gracias!';
    case 'payment_failed':
      return '\u{26A0}\uFE0F Hubo un problema con tu pago' + (amount ? ' de ' + amount + ' ' + currency : '') + '.' +
        ' Por favor contáctanos.';
    case 'new_lead':
      return '\u{1F4F2} Nuevo contacto' + (name ? ': ' + name : '') + ' se comunicó con ' + biz + '.';
    case 'follow_up_due':
      return '\u{23F0} Recordatorio: es momento de hacer seguimiento' + (name ? ' con ' + name : '') + '.';
    case 'broadcast_complete':
      return '\u{1F4E2} El envío masivo' + (params.broadcastName ? ' "' + params.broadcastName + '"' : '') + ' fue completado.';
    case 'system_alert':
      return '\u{26A0}\uFE0F Alerta del sistema: ' + (params.message || 'Revisa la configuración.');
    default:
      return params.body || params.message || 'Notificación de ' + biz + '.';
  }
}

function scheduleNotification(notification, scheduledAt) {
  if (typeof scheduledAt !== 'number' || scheduledAt <= Date.now()) {
    throw new Error('scheduledAt debe ser timestamp futuro');
  }
  if (notification.status !== 'pending') {
    throw new Error('solo se puede agendar notificacion en estado pending');
  }
  return {
    ...notification,
    scheduledAt,
    status: 'scheduled',
    updatedAt: Date.now(),
  };
}

async function saveNotification(uid, notification) {
  console.log('[NOTIF] Guardando uid=' + uid + ' id=' + notification.notificationId + ' type=' + notification.type);
  try {
    await db().collection('owners').doc(uid)
      .collection('notifications').doc(notification.notificationId)
      .set(notification, { merge: false });
    return notification.notificationId;
  } catch (err) {
    console.error('[NOTIF] Error guardando:', err.message);
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
    console.error('[NOTIF] Error obteniendo:', err.message);
    return null;
  }
}

async function updateNotificationStatus(uid, notificationId, status) {
  if (!isValidStatus(status)) throw new Error('status invalido: ' + status);
  const update = { status, updatedAt: Date.now() };
  if (status === 'sent') update.sentAt = Date.now();
  if (status === 'read') update.readAt = Date.now();
  console.log('[NOTIF] Actualizando status uid=' + uid + ' id=' + notificationId + ' -> ' + status);
  try {
    await db().collection('owners').doc(uid)
      .collection('notifications').doc(notificationId)
      .set(update, { merge: true });
    return notificationId;
  } catch (err) {
    console.error('[NOTIF] Error actualizando status:', err.message);
    throw err;
  }
}

async function getPendingNotifications(uid, opts) {
  opts = opts || {};
  try {
    const now = Date.now();
    const snap = await db().collection('owners').doc(uid)
      .collection('notifications').where('status', '==', 'pending').get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      if (opts.before !== undefined) {
        if (rec.scheduledAt !== null && rec.scheduledAt > opts.before) return;
      }
      results.push(rec);
    });
    if (opts.priority) {
      results.sort((a, b) => {
        const order = { urgent: 0, high: 1, normal: 2, low: 3 };
        return (order[a.priority] || 2) - (order[b.priority] || 2);
      });
    }
    return results;
  } catch (err) {
    console.error('[NOTIF] Error obteniendo pendientes:', err.message);
    return [];
  }
}

async function getScheduledNotifications(uid, opts) {
  opts = opts || {};
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('notifications').where('status', '==', 'scheduled').get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      if (opts.before !== undefined && rec.scheduledAt > opts.before) return;
      results.push(rec);
    });
    return results;
  } catch (err) {
    console.error('[NOTIF] Error obteniendo agendadas:', err.message);
    return [];
  }
}

function buildNotificationSummaryText(notification) {
  if (!notification) return 'Notificacion no encontrada.';
  const parts = [];
  const priorityIcon = { urgent: '\u{1F6A8}', high: '\u{26A0}\uFE0F', normal: '\u{1F514}', low: '\u{1F515}' };
  const icon = priorityIcon[notification.priority] || '\u{1F514}';
  parts.push(icon + ' *' + (notification.title || notification.type) + '*');
  parts.push('Tipo: ' + notification.type);
  parts.push('Canal: ' + notification.channel);
  parts.push('Estado: ' + notification.status);
  parts.push('Prioridad: ' + notification.priority);
  if (notification.body) parts.push(notification.body);
  if (notification.scheduledAt) {
    parts.push('Agendada: ' + new Date(notification.scheduledAt).toISOString().slice(0, 16).replace('T', ' '));
  }
  return parts.join('\n');
}

module.exports = {
  buildNotificationRecord,
  buildNotificationBody,
  scheduleNotification,
  saveNotification,
  getNotification,
  updateNotificationStatus,
  getPendingNotifications,
  getScheduledNotifications,
  buildNotificationSummaryText,
  NOTIFICATION_TYPES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_PRIORITIES,
  MAX_NOTIFICATION_BODY_LENGTH,
  MAX_NOTIFICATION_TITLE_LENGTH,
  MAX_PENDING_PER_OWNER,
  __setFirestoreForTests,
};
