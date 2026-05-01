'use strict';

/**
 * MIIA â€” Webhook Dispatcher (T148)
 */

const crypto = require('crypto');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

let _fetchFn = null;
function __setFetchForTests(fn) { _fetchFn = fn; }
function getFetch() { return _fetchFn || fetch; }

const WEBHOOK_EVENTS = Object.freeze([
  'message.received', 'message.sent', 'contact.classified',
  'appointment.created', 'appointment.cancelled',
  'broadcast.completed', 'followup.sent', 'consent.updated',
]);

const DISPATCH_DEFAULTS = Object.freeze({
  timeoutMs: 10000,
  maxRetries: 3,
  baseDelayMs: 1000,
});

const MAX_URL_LENGTH = 2048;
const MAX_PAYLOAD_BYTES = 65536;

async function registerWebhook(uid, { url, events, secret } = {}) {
  if (!uid) throw new Error('uid requerido');
  if (!url || typeof url !== 'string') throw new Error('url requerida');
  if (url.length > MAX_URL_LENGTH) throw new Error('url demasiado larga');
  if (!url.startsWith('https://')) throw new Error('url debe ser HTTPS');

  const eventsArr = Array.isArray(events) ? events : WEBHOOK_EVENTS.slice();
  const invalidEvents = eventsArr.filter(e => !WEBHOOK_EVENTS.includes(e));
  if (invalidEvents.length > 0) throw new Error('eventos invalidos: ' + invalidEvents.join(', '));

  const webhookId = 'wh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const payload = {
    webhookId, uid, url, events: eventsArr,
    secret: secret || null, active: true,
    createdAt: new Date().toISOString(),
    lastTriggeredAt: null, totalDispatched: 0, totalFailed: 0,
  };

  await db().collection('webhooks').doc(uid).collection('configs').doc(webhookId).set(payload);
  console.log('[WEBHOOK] Registered uid=' + uid.substring(0,8) + ' id=' + webhookId);
  return { webhookId, url, events: eventsArr };
}

async function dispatchEvent(uid, event, data, opts) {
  if (!opts) opts = {};
  if (!uid) throw new Error('uid requerido');
  if (!WEBHOOK_EVENTS.includes(event)) throw new Error('evento invalido: ' + event);

  let webhooks = [];
  try {
    const snap = await db().collection('webhooks').doc(uid).collection('configs')
      .where('active', '==', true).get();
    snap.forEach(doc => webhooks.push(doc.data()));
  } catch (e) {
    console.error('[WEBHOOK] Error leyendo configs uid=' + uid.substring(0,8) + ': ' + e.message);
    return { dispatched: 0, failed: 0, skipped: 0 };
  }

  const relevant = webhooks.filter(wh => wh.events.includes(event));
  if (relevant.length === 0) return { dispatched: 0, failed: 0, skipped: webhooks.length };

  const payloadObj = { event, uid, timestamp: new Date().toISOString(), data };
  const payloadStr = JSON.stringify(payloadObj);
  if (Buffer.byteLength(payloadStr, 'utf8') > MAX_PAYLOAD_BYTES) {
    console.warn('[WEBHOOK] Payload demasiado grande para evento ' + event);
    return { dispatched: 0, failed: 0, skipped: relevant.length };
  }

  let dispatched = 0, failed = 0;
  for (const wh of relevant) {
    const ok = await _sendWithRetry(wh, payloadStr, opts);
    if (ok) {
      dispatched++;
      _updateStats(uid, wh.webhookId, true).catch(() => {});
    } else {
      failed++;
      _updateStats(uid, wh.webhookId, false).catch(() => {});
    }
  }

  const skipped = webhooks.length - relevant.length;
  console.log('[WEBHOOK] Event=' + event + ' uid=' + uid.substring(0,8) +
    ': dispatched=' + dispatched + ' failed=' + failed + ' skipped=' + skipped);
  return { dispatched, failed, skipped };
}

async function _sendWithRetry(wh, payloadStr, opts) {
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : DISPATCH_DEFAULTS.timeoutMs;
  const maxRetries = opts.maxRetries !== undefined ? opts.maxRetries : DISPATCH_DEFAULTS.maxRetries;
  const baseDelayMs = opts.baseDelayMs !== undefined ? opts.baseDelayMs : DISPATCH_DEFAULTS.baseDelayMs;

  const headers = { 'Content-Type': 'application/json', 'X-Miia-Event': 'webhook' };
  if (wh.secret) headers['X-Miia-Signature'] = signPayload(payloadStr, wh.secret);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
    let timer;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await getFetch()(wh.url, {
        method: 'POST', headers, body: payloadStr, signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return true;
      console.warn('[WEBHOOK] HTTP ' + res.status + ' de ' + wh.url.substring(0,40) + ' intento ' + (attempt+1));
    } catch (e) {
      clearTimeout(timer);
      console.warn('[WEBHOOK] Error enviando intento ' + (attempt+1) + ': ' + e.message);
    }
  }
  return false;
}

function signPayload(payloadStr, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
}

async function _updateStats(uid, webhookId, success) {
  const update = { lastTriggeredAt: new Date().toISOString() };
  const admin = require('firebase-admin');
  if (success) update.totalDispatched = admin.firestore.FieldValue.increment(1);
  else update.totalFailed = admin.firestore.FieldValue.increment(1);
  try {
    await db().collection('webhooks').doc(uid).collection('configs').doc(webhookId).set(update, { merge: true });
  } catch (e) {
    console.warn('[WEBHOOK] Error actualizando stats ' + webhookId + ': ' + e.message);
  }
}

async function deactivateWebhook(uid, webhookId) {
  if (!uid) throw new Error('uid requerido');
  if (!webhookId) throw new Error('webhookId requerido');
  try {
    await db().collection('webhooks').doc(uid).collection('configs').doc(webhookId).set(
      { active: false, deactivatedAt: new Date().toISOString() }, { merge: true }
    );
    console.log('[WEBHOOK] Deactivated uid=' + uid.substring(0,8) + ' id=' + webhookId);
  } catch (e) {
    console.error('[WEBHOOK] Error desactivando ' + webhookId + ': ' + e.message);
    throw e;
  }
}

async function listWebhooks(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('webhooks').doc(uid).collection('configs').get();
    const result = [];
    snap.forEach(doc => {
      const d = doc.data();
      result.push({ webhookId: d.webhookId, url: d.url, events: d.events, active: d.active });
    });
    return result;
  } catch (e) {
    console.error('[WEBHOOK] Error listando webhooks uid=' + uid.substring(0,8) + ': ' + e.message);
    return [];
  }
}

module.exports = {
  registerWebhook, dispatchEvent, deactivateWebhook,
  listWebhooks, signPayload, WEBHOOK_EVENTS, DISPATCH_DEFAULTS,
  __setFirestoreForTests, __setFetchForTests,
};
