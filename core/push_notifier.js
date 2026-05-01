'use strict';

/**
 * MIIA — Push Notifier (T176)
 * Notificaciones push al owner cuando lead de alto score escribe.
 * Provider: FCM (Firebase Cloud Messaging).
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

let _httpClient = null;
function __setHttpClientForTests(fn) { _httpClient = fn; }

const FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send';
const MAX_TOKENS_PER_OWNER = 10;
const NOTIFICATION_TITLE_DEFAULT = 'MIIA — Lead activo';
const NOTIFICATION_BODY_DEFAULT = 'Un lead de alto score te escribió';

const NOTIFICATION_TYPES = Object.freeze([
  'high_score_lead',
  'new_lead',
  'appointment_request',
  'payment_initiated',
  'catalog_purchase',
]);

/**
 * Registra un token FCM para el owner.
 * @param {string} uid
 * @param {string} token - FCM device token
 * @param {string} [platform] - 'android'|'ios'|'web'
 */
async function registerToken(uid, token, platform) {
  if (!uid) throw new Error('uid requerido');
  if (!token || typeof token !== 'string') throw new Error('token requerido');
  const validPlatforms = ['android', 'ios', 'web'];
  const plat = platform && validPlatforms.includes(platform) ? platform : 'web';

  const tokenDoc = {
    uid,
    token,
    platform: plat,
    active: true,
    registeredAt: new Date().toISOString(),
  };

  try {
    const ref = db().collection('push_tokens').doc(uid).collection('tokens').doc(token.slice(-20));
    await ref.set(tokenDoc, { merge: true });
    console.log('[PUSH] token registrado uid=' + uid.substring(0, 8) + ' platform=' + plat);
  } catch (e) {
    console.error('[PUSH] Error registrando token uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  }
}

/**
 * Obtiene tokens FCM activos del owner.
 * @param {string} uid
 * @returns {Promise<string[]>}
 */
async function getOwnerTokens(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db()
      .collection('push_tokens')
      .doc(uid)
      .collection('tokens')
      .where('active', '==', true)
      .get();
    const tokens = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (d.token) tokens.push(d.token);
    });
    return tokens.slice(0, MAX_TOKENS_PER_OWNER);
  } catch (e) {
    console.error('[PUSH] Error leyendo tokens uid=' + uid.substring(0, 8) + ': ' + e.message);
    return [];
  }
}

/**
 * Desactiva un token FCM (ej: al recibir error 404/410 de FCM).
 * @param {string} uid
 * @param {string} token
 */
async function deactivateToken(uid, token) {
  if (!uid) throw new Error('uid requerido');
  if (!token) throw new Error('token requerido');
  try {
    await db()
      .collection('push_tokens')
      .doc(uid)
      .collection('tokens')
      .doc(token.slice(-20))
      .set({ active: false, deactivatedAt: new Date().toISOString() }, { merge: true });
    console.log('[PUSH] token desactivado uid=' + uid.substring(0, 8));
  } catch (e) {
    console.error('[PUSH] Error desactivando token: ' + e.message);
    throw e;
  }
}


/**
 * Envía notificación push al owner.
 * @param {string} uid
 * @param {object} notification - {title, body, type, data}
 * @returns {Promise<{sent, failed, tokens}>}
 */
async function sendPushNotification(uid, notification) {
  if (!uid) throw new Error('uid requerido');
  if (!notification || typeof notification !== 'object') throw new Error('notification requerido');

  const type = notification.type || 'high_score_lead';
  if (!NOTIFICATION_TYPES.includes(type)) throw new Error('tipo invalido: ' + type);

  const title = notification.title || NOTIFICATION_TITLE_DEFAULT;
  const body = notification.body || NOTIFICATION_BODY_DEFAULT;
  const data = notification.data || {};

  const tokens = await getOwnerTokens(uid);
  if (tokens.length === 0) {
    console.log('[PUSH] sin tokens para uid=' + uid.substring(0, 8));
    return { sent: 0, failed: 0, tokens: [] };
  }

  const fcmKey = process.env.FCM_SERVER_KEY;
  if (!fcmKey) {
    console.error('[PUSH] FCM_SERVER_KEY no configurada');
    return { sent: 0, failed: tokens.length, tokens };
  }

  const poster = _httpClient || _defaultPost;
  let sent = 0;
  let failed = 0;

  for (const token of tokens) {
    const payload = {
      to: token,
      notification: { title, body },
      data: { ...data, type, uid },
    };
    let timer;
    try {
      const abortCtrl = new AbortController();
      timer = setTimeout(() => abortCtrl.abort(), 10000);
      const resp = await poster(FCM_ENDPOINT, payload, {
        Authorization: 'key=' + fcmKey,
        signal: abortCtrl.signal,
      });
      if (resp.success === 1) {
        sent++;
      } else if (resp.error === 'NotRegistered' || resp.error === 'InvalidRegistration') {
        failed++;
        await deactivateToken(uid, token).catch(() => {});
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
      console.error('[PUSH] Error enviando a token uid=' + uid.substring(0, 8) + ': ' + e.message);
    } finally {
      clearTimeout(timer);
    }
  }

  console.log('[PUSH] enviado uid=' + uid.substring(0, 8) + ' sent=' + sent + ' failed=' + failed);
  return { sent, failed, tokens };
}

async function _defaultPost(url, payload, headers) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: headers.signal,
  });
  return resp.json();
}


/**
 * Notifica al owner cuando un lead de alto score escribe.
 * Integra con lead_scorer: usa score calculado externamente.
 * @param {string} uid
 * @param {string} phone - teléfono del lead
 * @param {number} score - score calculado por lead_scorer
 * @param {number} [threshold] - umbral para notificar (default: 20)
 * @returns {Promise<{notified, score, shouldNotify}>}
 */
async function notifyHighScoreLead(uid, phone, score, threshold) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (typeof score !== 'number') throw new Error('score debe ser numero');

  const thresh = typeof threshold === 'number' ? threshold : 20;
  const shouldNotify = score >= thresh;

  if (!shouldNotify) {
    return { notified: false, score, shouldNotify };
  }

  const notification = {
    type: 'high_score_lead',
    title: 'MIIA — Lead activo 🔥',
    body: 'Lead ' + phone.slice(-6) + ' (score ' + score + ') te escribió',
    data: { phone, score: String(score) },
  };

  const result = await sendPushNotification(uid, notification);
  return { notified: result.sent > 0, score, shouldNotify, sent: result.sent, failed: result.failed };
}

/**
 * Guarda preferencias de notificación del owner.
 * @param {string} uid
 * @param {object} prefs - {enabled, threshold, types}
 */
async function saveNotificationPrefs(uid, prefs) {
  if (!uid) throw new Error('uid requerido');
  if (!prefs || typeof prefs !== 'object') throw new Error('prefs requerido');

  const doc = {
    uid,
    enabled: prefs.enabled !== undefined ? Boolean(prefs.enabled) : true,
    threshold: typeof prefs.threshold === 'number' ? prefs.threshold : 20,
    types: Array.isArray(prefs.types) ? prefs.types : [...NOTIFICATION_TYPES],
    updatedAt: new Date().toISOString(),
  };

  try {
    await db().collection('push_prefs').doc(uid).set(doc, { merge: true });
    console.log('[PUSH] prefs guardadas uid=' + uid.substring(0, 8));
  } catch (e) {
    console.error('[PUSH] Error guardando prefs uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  }
}

/**
 * Lee preferencias de notificación del owner.
 * @param {string} uid
 * @returns {Promise<{enabled, threshold, types}>}
 */
async function getNotificationPrefs(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('push_prefs').doc(uid).get();
    if (!snap.exists) {
      return { enabled: true, threshold: 20, types: [...NOTIFICATION_TYPES] };
    }
    return snap.data();
  } catch (e) {
    console.error('[PUSH] Error leyendo prefs uid=' + uid.substring(0, 8) + ': ' + e.message);
    return { enabled: true, threshold: 20, types: [...NOTIFICATION_TYPES] };
  }
}

module.exports = {
  registerToken, getOwnerTokens, deactivateToken,
  sendPushNotification, notifyHighScoreLead,
  saveNotificationPrefs, getNotificationPrefs,
  NOTIFICATION_TYPES, MAX_TOKENS_PER_OWNER,
  FCM_ENDPOINT, NOTIFICATION_TITLE_DEFAULT, NOTIFICATION_BODY_DEFAULT,
  __setFirestoreForTests, __setHttpClientForTests,
};
