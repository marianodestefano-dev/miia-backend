'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const INTEGRATION_TYPES = Object.freeze([
  'google_calendar', 'mercadopago', 'stripe', 'mailchimp', 'instagram',
  'facebook', 'woocommerce', 'shopify', 'zapier', 'webhook', 'custom',
]);

const EVENT_TYPES = Object.freeze([
  'payment_confirmed', 'payment_failed', 'appointment_booked', 'appointment_cancelled',
  'lead_created', 'lead_converted', 'broadcast_sent', 'coupon_redeemed',
  'inventory_low', 'onboarding_completed', 'custom',
]);

const INTEGRATION_STATUSES = Object.freeze(['active', 'inactive', 'error', 'pending_auth']);
const WEBHOOK_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const MAX_PAYLOAD_SIZE_KB = 64;
const MAX_RETRY_ATTEMPTS = 3;
const MAX_INTEGRATIONS_PER_OWNER = 20;
const WEBHOOK_TIMEOUT_MS = 30000;

function isValidType(t) { return INTEGRATION_TYPES.includes(t); }
function isValidEventType(e) { return EVENT_TYPES.includes(e); }
function isValidStatus(s) { return INTEGRATION_STATUSES.includes(s); }
function isValidMethod(m) { return WEBHOOK_METHODS.includes(m); }

function buildIntegrationId(uid, type) {
  return uid.slice(0, 8) + '_integ_' + type.replace(/_/g, '').slice(0, 12);
}

function buildIntegrationRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const intType = isValidType(data.type) ? data.type : 'custom';
  const integrationId = data.integrationId || buildIntegrationId(uid, intType);
  return {
    integrationId,
    uid,
    type: intType,
    name: typeof data.name === 'string' ? data.name.trim().slice(0, 100) : intType,
    status: isValidStatus(data.status) ? data.status : 'inactive',
    config: data.config && typeof data.config === 'object' ? { ...data.config } : {},
    webhookUrl: typeof data.webhookUrl === 'string' ? data.webhookUrl.trim().slice(0, 500) : null,
    webhookMethod: isValidMethod(data.webhookMethod) ? data.webhookMethod : 'POST',
    webhookHeaders: data.webhookHeaders && typeof data.webhookHeaders === 'object' ? { ...data.webhookHeaders } : {},
    subscribedEvents: Array.isArray(data.subscribedEvents)
      ? data.subscribedEvents.filter(e => isValidEventType(e))
      : [],
    retryAttempts: 0,
    lastEventAt: null,
    lastErrorAt: null,
    lastError: null,
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

function buildWebhookPayload(eventType, data, opts) {
  opts = opts || {};
  if (!isValidEventType(eventType)) throw new Error('eventType invalido: ' + eventType);
  return {
    event: eventType,
    timestamp: Date.now(),
    version: '1.0',
    source: 'miia',
    uid: opts.uid || null,
    payload: data && typeof data === 'object' ? data : {},
    metadata: opts.metadata || {},
  };
}

function validateWebhookPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['payload debe ser objeto'] };
  }
  if (!payload.event || !isValidEventType(payload.event)) {
    errors.push('event invalido o faltante');
  }
  if (!payload.timestamp || typeof payload.timestamp !== 'number') {
    errors.push('timestamp invalido o faltante');
  }
  const payloadStr = JSON.stringify(payload);
  if (payloadStr.length > MAX_PAYLOAD_SIZE_KB * 1024) {
    errors.push('payload excede MAX_PAYLOAD_SIZE_KB (' + MAX_PAYLOAD_SIZE_KB + ' KB)');
  }
  return { valid: errors.length === 0, errors };
}

function filterEventsForIntegration(integration, events) {
  if (!Array.isArray(events)) return [];
  if (!integration.subscribedEvents || integration.subscribedEvents.length === 0) return events;
  return events.filter(e => integration.subscribedEvents.includes(e.event || e.type));
}

function buildEventRecord(uid, eventType, data, opts) {
  opts = opts || {};
  if (!isValidEventType(eventType)) throw new Error('eventType invalido: ' + eventType);
  const now = Date.now();
  const eventId = uid.slice(0, 8) + '_evt_' + eventType.replace(/_/g, '').slice(0, 8) + '_' + now.toString(36);
  return {
    eventId,
    uid,
    type: eventType,
    data: data && typeof data === 'object' ? { ...data } : {},
    processed: false,
    dispatched: false,
    dispatchedAt: null,
    integrationIds: Array.isArray(opts.integrationIds) ? opts.integrationIds : [],
    retries: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function saveIntegration(uid, integration) {
  console.log('[INTEG] Guardando integracion uid=' + uid + ' type=' + integration.type + ' id=' + integration.integrationId);
  try {
    await db().collection('owners').doc(uid)
      .collection('integrations').doc(integration.integrationId)
      .set(integration, { merge: false });
    return integration.integrationId;
  } catch (err) {
    console.error('[INTEG] Error guardando integracion:', err.message);
    throw err;
  }
}

async function getIntegration(uid, integrationId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('integrations').doc(integrationId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[INTEG] Error obteniendo integracion:', err.message);
    return null;
  }
}

async function updateIntegrationStatus(uid, integrationId, status, extraFields) {
  if (!isValidStatus(status)) throw new Error('status invalido: ' + status);
  const update = { status, updatedAt: Date.now(), ...(extraFields || {}) };
  if (status === 'error') update.lastErrorAt = Date.now();
  console.log('[INTEG] Actualizando status uid=' + uid + ' id=' + integrationId + ' -> ' + status);
  try {
    await db().collection('owners').doc(uid)
      .collection('integrations').doc(integrationId)
      .set(update, { merge: true });
    return integrationId;
  } catch (err) {
    console.error('[INTEG] Error actualizando status:', err.message);
    throw err;
  }
}

async function listIntegrations(uid, opts) {
  opts = opts || {};
  try {
    let q = db().collection('owners').doc(uid).collection('integrations');
    if (opts.status && isValidStatus(opts.status)) {
      q = q.where('status', '==', opts.status);
    }
    const snap = await q.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      if (opts.type && rec.type !== opts.type) return;
      results.push(rec);
    });
    return results;
  } catch (err) {
    console.error('[INTEG] Error listando integraciones:', err.message);
    return [];
  }
}

async function saveEvent(uid, event) {
  console.log('[INTEG] Guardando evento uid=' + uid + ' type=' + event.type + ' id=' + event.eventId);
  try {
    await db().collection('owners').doc(uid)
      .collection('integration_events').doc(event.eventId)
      .set(event, { merge: false });
    return event.eventId;
  } catch (err) {
    console.error('[INTEG] Error guardando evento:', err.message);
    throw err;
  }
}

async function listPendingEvents(uid, opts) {
  opts = opts || {};
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('integration_events').where('dispatched', '==', false).get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    if (opts.type) return results.filter(e => e.type === opts.type);
    return results;
  } catch (err) {
    console.error('[INTEG] Error listando eventos pendientes:', err.message);
    return [];
  }
}

function buildIntegrationSummaryText(integration) {
  if (!integration) return 'Integracion no encontrada.';
  const parts = [];
  const statusIcon = { active: '\u{2705}', inactive: '\u{23F9}\uFE0F', error: '\u{274C}', pending_auth: '\u{23F3}' };
  const icon = statusIcon[integration.status] || '\u{1F517}';
  parts.push(icon + ' *' + integration.name + '* (' + integration.type + ')');
  parts.push('Estado: ' + integration.status);
  if (integration.webhookUrl) parts.push('Webhook: ' + integration.webhookUrl.slice(0, 50) + '...');
  if (integration.subscribedEvents && integration.subscribedEvents.length > 0) {
    parts.push('Eventos: ' + integration.subscribedEvents.slice(0, 3).join(', ') +
      (integration.subscribedEvents.length > 3 ? ' (+' + (integration.subscribedEvents.length - 3) + ' mas)' : ''));
  }
  if (integration.lastErrorAt) parts.push('Ultimo error: ' + new Date(integration.lastErrorAt).toISOString().slice(0, 16));
  return parts.join('\n');
}

module.exports = {
  buildIntegrationRecord,
  buildWebhookPayload,
  validateWebhookPayload,
  filterEventsForIntegration,
  buildEventRecord,
  saveIntegration,
  getIntegration,
  updateIntegrationStatus,
  listIntegrations,
  saveEvent,
  listPendingEvents,
  buildIntegrationSummaryText,
  INTEGRATION_TYPES,
  EVENT_TYPES,
  INTEGRATION_STATUSES,
  WEBHOOK_METHODS,
  MAX_PAYLOAD_SIZE_KB,
  MAX_RETRY_ATTEMPTS,
  MAX_INTEGRATIONS_PER_OWNER,
  WEBHOOK_TIMEOUT_MS,
  __setFirestoreForTests,
};
