'use strict';

/**
 * PB.3 -- WHATSAPP HEALTH ALERTER
 * Envia alertas cuando un tenant WhatsApp se desconecta >10min o supera rate limit.
 * Canales: Firestore push_notifications (dashboard) + funcion externa inyectable (email/WA).
 */

const DISCONNECT_THRESHOLD_MS = 10 * 60 * 1000;
const RATE_LIMIT_THRESHOLD_MS = 5 * 60 * 1000;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

const ALERT_TYPES = Object.freeze({
  DISCONNECTED: 'wa_disconnected',
  RATE_LIMITED: 'wa_rate_limited',
  RECONNECTED: 'wa_reconnected',
});

let _db = null;
let _sendAlertFn = null;

function __setFirestoreForTests(fs) { _db = fs; }
function __setSendAlertForTests(fn) { _sendAlertFn = fn; }
function db() { return _db || require('firebase-admin').firestore(); }

const _lastAlertTime = {};

function canSendAlert(uid) {
  const last = _lastAlertTime[uid];
  if (!last) return true;
  return (Date.now() - last) >= ALERT_COOLDOWN_MS;
}

function markAlertSent(uid) {
  _lastAlertTime[uid] = Date.now();
}

function clearAlertCooldown(uid) {
  delete _lastAlertTime[uid];
}

function buildAlertMessage(alertType, elapsedMinutes) {
  if (alertType === ALERT_TYPES.DISCONNECTED) {
    return 'MIIA WhatsApp desconectado hace ' + Math.round(elapsedMinutes) + ' minutos. Verifica tu conexion.';
  }
  if (alertType === ALERT_TYPES.RATE_LIMITED) {
    return 'MIIA limitada por rate limit WhatsApp. Mensajes pausados temporalmente.';
  }
  if (alertType === ALERT_TYPES.RECONNECTED) {
    return 'MIIA WhatsApp reconectado. Todo vuelve a la normalidad.';
  }
  return 'Alerta de salud MIIA: ' + alertType;
}

function isValidAlertType(alertType) {
  return Object.values(ALERT_TYPES).includes(alertType);
}

async function pushAlertToFirestore(uid, alertType, message) {
  const doc = {
    type: alertType,
    message,
    severity: alertType === ALERT_TYPES.RECONNECTED ? 'info' : 'critical',
    read: false,
    createdAt: new Date().toISOString(),
  };
  const docId = alertType + '_' + Date.now().toString(36);
  await db().collection('tenants').doc(uid).collection('push_notifications').doc(docId).set(doc);
  console.log('[WA-HEALTH-ALERTER] Push uid=' + uid.substring(0, 8) + ' type=' + alertType);
  return docId;
}

async function sendHealthAlert(uid, alertType, opts) {
  if (opts === undefined) opts = {};
  if (!uid) throw new Error('uid requerido');
  if (!isValidAlertType(alertType)) throw new Error('alertType invalido: ' + alertType);

  const elapsedMinutes = opts.elapsedMs ? opts.elapsedMs / 60000 : 0;
  const message = opts.customMessage || buildAlertMessage(alertType, elapsedMinutes);

  if (!canSendAlert(uid)) {
    console.log('[WA-HEALTH-ALERTER] Alerta suprimida cooldown uid=' + uid.substring(0, 8));
    return { sent: false, reason: 'cooldown' };
  }

  const results = {};

  try {
    results.firestoreDocId = await pushAlertToFirestore(uid, alertType, message);
    results.firestore = true;
  } catch (e) {
    console.error('[WA-HEALTH-ALERTER] Error Firestore: ' + e.message);
    results.firestore = false;
  }

  const fn = _sendAlertFn || (opts && opts.sendFn);
  if (fn) {
    try {
      await fn(uid, alertType, message, opts);
      results.external = true;
    } catch (e) {
      console.error('[WA-HEALTH-ALERTER] Error envio externo: ' + e.message);
      results.external = false;
    }
  }

  markAlertSent(uid);
  return { sent: true, alertType, message, results };
}

async function checkAndAlertDisconnect(uid, lastSeenMs, nowMs) {
  const now = nowMs !== undefined ? nowMs : Date.now();
  if (!lastSeenMs) return null;
  const elapsed = now - lastSeenMs;
  if (elapsed >= DISCONNECT_THRESHOLD_MS) {
    return await sendHealthAlert(uid, ALERT_TYPES.DISCONNECTED, { elapsedMs: elapsed });
  }
  return null;
}

async function checkAndAlertRateLimit(uid, rateLimitedSinceMs, nowMs) {
  const now = nowMs !== undefined ? nowMs : Date.now();
  if (!rateLimitedSinceMs) return null;
  const elapsed = now - rateLimitedSinceMs;
  if (elapsed >= RATE_LIMIT_THRESHOLD_MS) {
    return await sendHealthAlert(uid, ALERT_TYPES.RATE_LIMITED, { elapsedMs: elapsed });
  }
  return null;
}

async function alertReconnected(uid) {
  if (!uid) throw new Error('uid requerido');
  clearAlertCooldown(uid);
  return await sendHealthAlert(uid, ALERT_TYPES.RECONNECTED, {});
}

module.exports = {
  sendHealthAlert,
  checkAndAlertDisconnect,
  checkAndAlertRateLimit,
  alertReconnected,
  buildAlertMessage,
  isValidAlertType,
  canSendAlert,
  clearAlertCooldown,
  pushAlertToFirestore,
  ALERT_TYPES,
  DISCONNECT_THRESHOLD_MS,
  RATE_LIMIT_THRESHOLD_MS,
  ALERT_COOLDOWN_MS,
  _lastAlertTime,
  __setFirestoreForTests,
  __setSendAlertForTests,
};
