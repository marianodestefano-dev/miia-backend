'use strict';

/**
 * MIIA — Notification Manager (T113)
 * Crea y gestiona notificaciones internas para el owner.
 * Firestore: users/{uid}/notifications/{notifId}
 */

const admin = require('firebase-admin');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || admin.firestore(); }

const NOTIF_TYPES = Object.freeze(['info', 'warning', 'error', 'success']);
const MAX_NOTIFICATIONS = 100;

async function createNotification(uid, { type, title, body, meta = {} }) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!NOTIF_TYPES.includes(type)) throw new Error(`type invalido: ${type}. Permitidos: ${NOTIF_TYPES.join(',')}`);
  if (!title || typeof title !== 'string') throw new Error('title requerido');
  if (!body || typeof body !== 'string') throw new Error('body requerido');
  const notifId = `n_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const payload = { notifId, uid, type, title, body, meta, createdAt: new Date().toISOString(), read: false };
  await db().collection('users').doc(uid).collection('notifications').doc(notifId).set(payload);
  console.log(`[NOTIF] Created uid=${uid.substring(0,8)} type=${type} title="${title.substring(0,40)}"`);
  return payload;
}

async function getNotifications(uid, { unreadOnly = false, limit = 20 } = {}) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  try {
    const snap = await db().collection('users').doc(uid).collection('notifications').get();
    let notifs = snap.docs.map(d => d.data());
    if (unreadOnly) notifs = notifs.filter(n => !n.read);
    notifs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return { uid, notifications: notifs.slice(0, limit), total: notifs.length };
  } catch (e) {
    console.warn(`[NOTIF] getNotifications error: ${e.message}`);
    return { uid, notifications: [], total: 0, error: e.message };
  }
}

async function markAsRead(uid, notifId) {
  if (!uid || !notifId) throw new Error('uid y notifId requeridos');
  await db().collection('users').doc(uid).collection('notifications').doc(notifId)
    .set({ read: true, readAt: new Date().toISOString() }, { merge: true });
  return { uid, notifId, read: true };
}

module.exports = { createNotification, getNotifications, markAsRead, NOTIF_TYPES, __setFirestoreForTests };
