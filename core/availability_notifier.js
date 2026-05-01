'use strict';

/**
 * MIIA - Availability Notifier (T161)
 * Registra leads que escriben fuera de horario y los notifica cuando el negocio reabre.
 * Integra con business_hours_v2 para calcular proximo horario de apertura.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

const NOTIFICATION_COLLECTION = 'availability_notifications';
const DEFAULT_MESSAGE_ES = 'Hola! Ahora estamos disponibles. En que puedo ayudarte?';
const DEFAULT_MESSAGE_EN = 'Hello! We are now available. How can I help you?';
const MAX_PENDING_PER_TENANT = 500;

/**
 * Registra que un lead escribio fuera de horario y debe ser notificado al reabrir.
 * @param {string} uid - tenant
 * @param {string} phone - telefono del lead
 * @param {string} nextOpenAt - ISO-like string 'YYYY-MM-DDThh:mm' del proximo apertura
 * @param {object} [opts] - { customMessage, nowMs }
 * @returns {Promise<{notificationId, scheduledFor}>}
 */
async function scheduleNotification(uid, phone, nextOpenAt, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!nextOpenAt || typeof nextOpenAt !== 'string') throw new Error('nextOpenAt requerido');

  const nowMs = (opts && opts.nowMs) ? opts.nowMs : Date.now();
  const message = (opts && opts.customMessage) || DEFAULT_MESSAGE_ES;
  const notificationId = uid.substring(0, 8) + '_' + phone.replace(/\D/g, '').slice(-10) + '_' + Date.now();

  const payload = {
    uid, phone, nextOpenAt, message,
    scheduledAt: new Date(nowMs).toISOString(),
    sent: false,
    sentAt: null,
  };

  try {
    await db().collection(NOTIFICATION_COLLECTION).doc(uid)
      .collection('pending').doc(notificationId).set(payload);
    console.log('[AVAIL_NOTIF] registrado phone=' + phone.slice(-4) + ' nextOpen=' + nextOpenAt);
    return { notificationId, scheduledFor: nextOpenAt };
  } catch (e) {
    console.error('[AVAIL_NOTIF] Error registrando uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  }
}

/**
 * Obtiene notificaciones pendientes para un tenant.
 * @param {string} uid
 * @returns {Promise<Array<object>>}
 */
async function getPendingNotifications(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection(NOTIFICATION_COLLECTION).doc(uid)
      .collection('pending').where('sent', '==', false).get();
    const items = [];
    snap.forEach(doc => items.push({ id: doc.id, ...doc.data() }));
    return items;
  } catch (e) {
    console.error('[AVAIL_NOTIF] Error leyendo pendientes uid=' + uid.substring(0, 8) + ': ' + e.message);
    return [];
  }
}

/**
 * Marca una notificacion como enviada.
 * @param {string} uid
 * @param {string} notificationId
 */
async function markAsSent(uid, notificationId) {
  if (!uid) throw new Error('uid requerido');
  if (!notificationId) throw new Error('notificationId requerido');
  try {
    await db().collection(NOTIFICATION_COLLECTION).doc(uid)
      .collection('pending').doc(notificationId)
      .set({ sent: true, sentAt: new Date().toISOString() }, { merge: true });
    console.log('[AVAIL_NOTIF] marcado enviado id=' + notificationId.slice(-8));
  } catch (e) {
    console.error('[AVAIL_NOTIF] Error marcando enviado id=' + notificationId.slice(-8) + ': ' + e.message);
    throw e;
  }
}

/**
 * Filtra las notificaciones que ya deben enviarse (nextOpenAt <= ahora).
 * @param {Array<object>} pending - lista de notificaciones pendientes
 * @param {number} [nowMs]
 * @returns {Array<object>} notificaciones listas para enviar
 */
function filterDueNotifications(pending, nowMs) {
  if (!Array.isArray(pending)) throw new Error('pending debe ser array');
  const now = nowMs ? new Date(nowMs) : new Date();
  return pending.filter(n => {
    if (!n.nextOpenAt) return false;
    const parts = n.nextOpenAt.split('T');
    if (parts.length < 2) return false;
    try {
      const scheduled = new Date(parts[0] + 'T' + parts[1] + ':00.000Z');
      return scheduled <= now;
    } catch (_) {
      return false;
    }
  });
}

/**
 * Genera el mensaje de notificacion segun idioma.
 * @param {string} [language]
 * @returns {string}
 */
function getNotificationMessage(language) {
  if (language === 'en') return DEFAULT_MESSAGE_EN;
  return DEFAULT_MESSAGE_ES;
}

module.exports = {
  scheduleNotification, getPendingNotifications, markAsSent,
  filterDueNotifications, getNotificationMessage,
  DEFAULT_MESSAGE_ES, DEFAULT_MESSAGE_EN, MAX_PENDING_PER_TENANT,
  __setFirestoreForTests,
};
