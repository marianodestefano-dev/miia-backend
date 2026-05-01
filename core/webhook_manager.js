'use strict';

/**
 * MIIA - Webhook Manager (T244)
 * P4.1 ROADMAP: integraciones externas via webhooks entrantes y salientes.
 * Registro, validacion HMAC, cola de reintentos, auditoria de eventos.
 */

const crypto = require('crypto');

const WEBHOOK_DIRECTIONS = Object.freeze(['inbound', 'outbound']);
const WEBHOOK_STATUSES = Object.freeze(['active', 'inactive', 'failed', 'suspended']);
const WEBHOOK_EVENT_TYPES = Object.freeze([
  'new_message', 'new_lead', 'handoff', 'broadcast_done',
  'payment_received', 'form_submitted', 'catalog_order', 'custom',
]);

const MAX_WEBHOOKS_PER_TENANT = 10;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 10 * 1000;
const HMAC_ALGORITHM = 'sha256';
const WEBHOOK_COLLECTION = 'webhooks';
const WEBHOOK_LOG_COLLECTION = 'webhook_logs';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidDirection(dir) {
  return WEBHOOK_DIRECTIONS.includes(dir);
}

function isValidStatus(status) {
  return WEBHOOK_STATUSES.includes(status);
}

function isValidEventType(type) {
  return WEBHOOK_EVENT_TYPES.includes(type);
}

function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function signPayload(payload, secret) {
  if (!payload || !secret) throw new Error('payload y secret requeridos');
  var body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return 'sha256=' + crypto.createHmac(HMAC_ALGORITHM, secret).update(body).digest('hex');
}

function verifySignature(payload, signature, secret) {
  if (!payload || !signature || !secret) return false;
  try {
    var expected = signPayload(payload, secret);
    var sigBuffer = Buffer.from(signature);
    var expectedBuffer = Buffer.from(expected);
    if (sigBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  } catch (e) {
    return false;
  }
}

function buildWebhookRecord(uid, url, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!url || typeof url !== 'string') throw new Error('url requerido');
  if (!url.startsWith('https://') && !url.startsWith('http://')) throw new Error('url debe ser http/https');
  var direction = (opts && opts.direction && isValidDirection(opts.direction)) ? opts.direction : 'outbound';
  var events = (opts && Array.isArray(opts.events))
    ? opts.events.filter(isValidEventType)
    : WEBHOOK_EVENT_TYPES.slice();
  var webhookId = 'wh_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  return {
    webhookId,
    uid,
    url,
    direction,
    events,
    status: 'active',
    secret: generateWebhookSecret(),
    name: (opts && opts.name) ? String(opts.name) : 'Webhook ' + direction,
    retryAttempts: 0,
    lastTriggeredAt: null,
    lastStatusCode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function saveWebhook(uid, record) {
  if (!uid) throw new Error('uid requerido');
  if (!record || !record.webhookId) throw new Error('record invalido');
  var existing = await getWebhooks(uid);
  if (!record._isUpdate && existing.length >= MAX_WEBHOOKS_PER_TENANT) {
    throw new Error('maximo de webhooks alcanzado: ' + MAX_WEBHOOKS_PER_TENANT);
  }
  await db().collection('tenants').doc(uid).collection(WEBHOOK_COLLECTION).doc(record.webhookId).set(record);
  console.log('[WEBHOOK] Guardado uid=' + uid + ' id=' + record.webhookId + ' url=' + record.url);
  return record.webhookId;
}

async function updateWebhookStatus(uid, webhookId, status, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!webhookId) throw new Error('webhookId requerido');
  if (!isValidStatus(status)) throw new Error('status invalido: ' + status);
  var update = { status, updatedAt: new Date().toISOString() };
  if (opts && typeof opts.lastStatusCode === 'number') update.lastStatusCode = opts.lastStatusCode;
  if (opts && opts.incrementRetry) update.retryAttempts = (opts.currentRetries || 0) + 1;
  if (opts && opts.lastTriggeredAt) update.lastTriggeredAt = opts.lastTriggeredAt;
  await db().collection('tenants').doc(uid).collection(WEBHOOK_COLLECTION).doc(webhookId).set(update, { merge: true });
}

async function getWebhooks(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection(WEBHOOK_COLLECTION).get();
    var webhooks = [];
    snap.forEach(function(doc) { webhooks.push(doc.data()); });
    if (opts && opts.status) webhooks = webhooks.filter(function(w) { return w.status === opts.status; });
    if (opts && opts.direction) webhooks = webhooks.filter(function(w) { return w.direction === opts.direction; });
    if (opts && opts.event) webhooks = webhooks.filter(function(w) { return w.events && w.events.includes(opts.event); });
    return webhooks;
  } catch (e) {
    console.error('[WEBHOOK] Error leyendo webhooks: ' + e.message);
    return [];
  }
}

async function logWebhookEvent(uid, webhookId, eventType, payload, result) {
  if (!uid) throw new Error('uid requerido');
  if (!webhookId) throw new Error('webhookId requerido');
  var logId = 'whlog_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  var record = {
    logId,
    webhookId,
    eventType,
    statusCode: result && result.statusCode,
    success: !!(result && result.success),
    durationMs: result && result.durationMs,
    error: (result && result.error) ? String(result.error).slice(0, 200) : null,
    payloadSize: payload ? JSON.stringify(payload).length : 0,
    triggeredAt: new Date().toISOString(),
  };
  try {
    await db().collection('tenants').doc(uid).collection(WEBHOOK_LOG_COLLECTION).doc(logId).set(record);
    return logId;
  } catch (e) {
    console.error('[WEBHOOK] Error guardando log: ' + e.message);
    return null;
  }
}

function buildWebhookPayload(eventType, data, uid) {
  if (!isValidEventType(eventType)) throw new Error('eventType invalido: ' + eventType);
  return {
    event: eventType,
    uid,
    timestamp: new Date().toISOString(),
    data: data || {},
    version: '1.0',
  };
}

function getWebhooksForEvent(webhooks, eventType) {
  if (!Array.isArray(webhooks)) return [];
  return webhooks.filter(function(w) {
    return w.status === 'active' && w.events && w.events.includes(eventType);
  });
}

function shouldRetry(record) {
  if (!record) return false;
  return record.retryAttempts < MAX_RETRY_ATTEMPTS && record.status !== 'suspended';
}

module.exports = {
  buildWebhookRecord,
  saveWebhook,
  updateWebhookStatus,
  getWebhooks,
  logWebhookEvent,
  buildWebhookPayload,
  getWebhooksForEvent,
  shouldRetry,
  signPayload,
  verifySignature,
  generateWebhookSecret,
  isValidDirection,
  isValidStatus,
  isValidEventType,
  WEBHOOK_DIRECTIONS,
  WEBHOOK_STATUSES,
  WEBHOOK_EVENT_TYPES,
  MAX_WEBHOOKS_PER_TENANT,
  MAX_RETRY_ATTEMPTS,
  RETRY_DELAY_MS,
  WEBHOOK_TIMEOUT_MS,
  HMAC_ALGORITHM,
  __setFirestoreForTests,
};
