'use strict';

/**
 * MIIA - Notification Builder (T241)
 * P3.3 ROADMAP: sistema de notificaciones al owner.
 * Construye y gestiona alertas, resúmenes y notificaciones push-like vía WhatsApp.
 */

const NOTIFICATION_TYPES = Object.freeze([
  'new_lead', 'lead_response', 'spam_detected', 'handoff_requested',
  'otp_requested', 'daily_summary', 'weekly_summary', 'system_alert',
  'broadcast_done', 'low_stock', 'catalog_updated', 'recovery_initiated',
]);

const NOTIFICATION_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'critical']);

const NOTIFICATION_STATUSES = Object.freeze(['pending', 'sent', 'failed', 'suppressed']);

const MAX_NOTIFICATIONS_STORED = 200;
const DIGEST_COOLDOWN_MS = 23 * 60 * 60 * 1000;
const SUPPRESSION_WINDOW_MS = 5 * 60 * 1000;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidType(type) {
  return NOTIFICATION_TYPES.includes(type);
}

function isValidPriority(priority) {
  return NOTIFICATION_PRIORITIES.includes(priority);
}

function getPriorityForType(type) {
  var criticalTypes = ['otp_requested', 'spam_detected', 'system_alert', 'recovery_initiated'];
  var highTypes = ['handoff_requested', 'new_lead'];
  var lowTypes = ['daily_summary', 'weekly_summary', 'broadcast_done'];
  if (criticalTypes.includes(type)) return 'critical';
  if (highTypes.includes(type)) return 'high';
  if (lowTypes.includes(type)) return 'low';
  return 'normal';
}

function buildNotificationRecord(uid, type, data, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!type || !isValidType(type)) throw new Error('type invalido: ' + type);
  var priority = (opts && opts.priority && isValidPriority(opts.priority))
    ? opts.priority
    : getPriorityForType(type);
  var notifId = 'notif_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  return {
    notifId,
    uid,
    type,
    priority,
    data: data || {},
    status: 'pending',
    createdAt: new Date().toISOString(),
    sentAt: null,
    readAt: null,
    suppressedReason: null,
  };
}

async function saveNotification(uid, record) {
  if (!uid) throw new Error('uid requerido');
  if (!record || !record.notifId) throw new Error('record invalido');
  await db().collection('tenants').doc(uid).collection('notifications').doc(record.notifId).set(record);
  console.log('[NOTIF] Guardado uid=' + uid + ' type=' + record.type + ' id=' + record.notifId);
  return record.notifId;
}

async function updateNotificationStatus(uid, notifId, status, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!notifId) throw new Error('notifId requerido');
  if (!NOTIFICATION_STATUSES.includes(status)) throw new Error('status invalido: ' + status);
  var update = { status, updatedAt: new Date().toISOString() };
  if (status === 'sent') update.sentAt = new Date().toISOString();
  if (opts && opts.suppressedReason) update.suppressedReason = opts.suppressedReason;
  await db().collection('tenants').doc(uid).collection('notifications').doc(notifId).set(update, { merge: true });
}

async function getRecentNotifications(uid, limitCount) {
  if (!uid) throw new Error('uid requerido');
  var limit = limitCount || 20;
  try {
    var snap = await db().collection('tenants').doc(uid).collection('notifications').get();
    var notifs = [];
    snap.forEach(function(doc) { notifs.push(doc.data()); });
    notifs.sort(function(a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
    return notifs.slice(0, limit);
  } catch (e) {
    console.error('[NOTIF] Error leyendo notificaciones: ' + e.message);
    return [];
  }
}

async function hasSentRecentNotification(uid, type, windowMs) {
  if (!uid) throw new Error('uid requerido');
  var window = windowMs || SUPPRESSION_WINDOW_MS;
  var cutoff = new Date(Date.now() - window).toISOString();
  try {
    var notifs = await getRecentNotifications(uid, 50);
    return notifs.some(function(n) {
      return n.type === type && n.status === 'sent' && (n.sentAt || '') > cutoff;
    });
  } catch (e) {
    return false;
  }
}

function buildNewLeadText(data) {
  var name = data.name || data.phone || 'Nuevo contacto';
  var text = data.text || '';
  var lines = ['🔔 *Nuevo lead*: ' + name];
  if (text) lines.push('Mensaje: ' + text.slice(0, 100) + (text.length > 100 ? '...' : ''));
  return lines.join('\n');
}

function buildSpamAlertText(data) {
  var phone = data.phone || 'Desconocido';
  var severity = data.severity || 'medium';
  var emoji = severity === 'high' ? '🚨' : '⚠️';
  return emoji + ' *SPAM detectado*: ' + phone + '\nSeveridad: ' + severity +
    (data.reason ? '\nRazón: ' + data.reason : '');
}

function buildHandoffText(data) {
  var phone = data.phone || 'Desconocido';
  var reason = data.reason || 'solicitud de cliente';
  return '👤 *Handoff solicitado*\nContacto: ' + phone + '\nMotivo: ' + reason;
}

function buildDailySummaryText(data) {
  var messages = data.messages || 0;
  var leads = data.leads || 0;
  var handoffs = data.handoffs || 0;
  var lines = [
    '📊 *Resumen del día*',
    'Mensajes procesados: ' + messages,
    'Leads nuevos: ' + leads,
    'Handoffs: ' + handoffs,
  ];
  if (data.topKeywords && data.topKeywords.length > 0) {
    lines.push('Temas más consultados: ' + data.topKeywords.join(', '));
  }
  return lines.join('\n');
}

function buildSystemAlertText(data) {
  var component = data.component || 'sistema';
  var message = data.message || 'Alerta detectada';
  var severity = data.severity || 'warning';
  var emoji = severity === 'critical' ? '🔴' : severity === 'warning' ? '🟡' : '🟢';
  return emoji + ' *Alerta de sistema*\nComponente: ' + component + '\nDetalle: ' + message;
}

function buildNotificationText(record) {
  if (!record) return '';
  var data = record.data || {};
  switch (record.type) {
    case 'new_lead': return buildNewLeadText(data);
    case 'lead_response': return '💬 *Respuesta de lead*: ' + (data.phone || '') + '\n' + (data.text || '').slice(0, 100);
    case 'spam_detected': return buildSpamAlertText(data);
    case 'handoff_requested': return buildHandoffText(data);
    case 'otp_requested': return '🔐 *OTP solicitado* para acción: ' + (data.action || 'desconocida');
    case 'daily_summary': return buildDailySummaryText(data);
    case 'weekly_summary': return '📈 *Resumen semanal*\nMensajes totales: ' + (data.messages || 0);
    case 'system_alert': return buildSystemAlertText(data);
    case 'broadcast_done': return '📢 *Broadcast completado*: ' + (data.sent || 0) + ' mensajes enviados';
    case 'low_stock': return '📦 *Stock bajo*: ' + (data.itemName || 'Producto') + ' — stock: ' + (data.stock || 0);
    case 'catalog_updated': return '📋 *Catálogo actualizado*: ' + (data.itemName || '') + ' modificado';
    case 'recovery_initiated': return '⚠️ *Recovery iniciado* por: ' + (data.phone || '') + '\nRevisa y confirma.';
    default: return 'Notificación: ' + record.type;
  }
}

module.exports = {
  buildNotificationRecord,
  saveNotification,
  updateNotificationStatus,
  getRecentNotifications,
  hasSentRecentNotification,
  buildNotificationText,
  buildNewLeadText,
  buildSpamAlertText,
  buildHandoffText,
  buildDailySummaryText,
  buildSystemAlertText,
  isValidType,
  isValidPriority,
  getPriorityForType,
  NOTIFICATION_TYPES,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_STATUSES,
  MAX_NOTIFICATIONS_STORED,
  DIGEST_COOLDOWN_MS,
  SUPPRESSION_WINDOW_MS,
  __setFirestoreForTests,
};
