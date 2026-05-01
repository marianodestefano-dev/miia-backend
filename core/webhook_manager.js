'use strict';

/**
 * MIIA — Webhook Outbound (T108)
 * registerWebhook, fireWebhook (con retry 3 intentos exp backoff), deleteWebhook.
 * Firestore: owners/{uid}/webhooks/{webhookId}
 * Seguridad: envia HMAC-SHA256 en header X-MIIA-Signature.
 */

const crypto = require('crypto');
const admin = require('firebase-admin');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || admin.firestore(); }

let _fetchFn = null;
function __setFetchForTests(fn) { _fetchFn = fn; }
function getFetch() { return _fetchFn || fetch; }

const ALLOWED_EVENTS = Object.freeze(['message_received', 'lead_classified', 'broadcast_sent', 'consent_changed']);
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500; // base para backoff exponencial

/**
 * Registra un webhook para un owner.
 */
async function registerWebhook(uid, { url, events, secret }) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!url || typeof url !== 'string') throw new Error('url requerida');
  if (!Array.isArray(events) || events.length === 0) throw new Error('events es requerido (array no vacio)');
  const invalidEvents = events.filter(e => !ALLOWED_EVENTS.includes(e));
  if (invalidEvents.length > 0) throw new Error(`Eventos no permitidos: ${invalidEvents.join(', ')}`);

  const webhookId = `wh_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const payload = {
    webhookId, uid, url, events,
    secret: secret || null,
    createdAt: new Date().toISOString(),
    active: true,
    lastFiredAt: null,
    failCount: 0,
  };

  await db().collection('owners').doc(uid).collection('webhooks').doc(webhookId).set(payload);
  console.log(`[WEBHOOK] Registered uid=${uid.substring(0,8)} id=${webhookId} events=${events.join(',')}`);
  return payload;
}

/**
 * Dispara un webhook a todos los endpoints del owner que escuchan el evento.
 * Con retry 3 veces, backoff exponencial.
 */
async function fireWebhook(uid, event, data) {
  if (!uid || !event) throw new Error('uid y event requeridos');

  // Buscar webhooks activos que escuchan este evento
  const snap = await db().collection('owners').doc(uid).collection('webhooks').get();
  const webhooks = snap.docs
    .map(d => d.data())
    .filter(w => w.active && Array.isArray(w.events) && w.events.includes(event));

  const results = [];
  for (const wh of webhooks) {
    const body = JSON.stringify({ event, uid, data, firedAt: new Date().toISOString() });
    const headers = { 'Content-Type': 'application/json' };
    if (wh.secret) {
      headers['X-MIIA-Signature'] = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
    }

    let success = false;
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const fetchFn = getFetch();
        const res = await fetchFn(wh.url, { method: 'POST', headers, body });
        if (res.ok || res.status < 500) { success = true; break; }
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        lastError = e.message;
      }
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt)));
      }
    }

    const now = new Date().toISOString();
    try {
      await db().collection('owners').doc(uid).collection('webhooks').doc(wh.webhookId)
        .set({ lastFiredAt: now, failCount: success ? 0 : (wh.failCount || 0) + 1 }, { merge: true });
    } catch (e) {
      console.warn(`[WEBHOOK] Error actualizando estado ${wh.webhookId}: ${e.message}`);
    }

    if (success) {
      console.log(`[WEBHOOK] OK uid=${uid.substring(0,8)} event=${event} id=${wh.webhookId}`);
    } else {
      console.warn(`[WEBHOOK] FAILED uid=${uid.substring(0,8)} event=${event} id=${wh.webhookId} err=${lastError}`);
    }
    results.push({ webhookId: wh.webhookId, success, error: lastError });
  }

  return { event, firedCount: webhooks.length, results };
}

/**
 * Elimina (desactiva) un webhook.
 */
async function deleteWebhook(uid, webhookId) {
  if (!uid || !webhookId) throw new Error('uid y webhookId requeridos');
  await db().collection('owners').doc(uid).collection('webhooks').doc(webhookId)
    .set({ active: false, deletedAt: new Date().toISOString() }, { merge: true });
  console.log(`[WEBHOOK] Deleted uid=${uid.substring(0,8)} id=${webhookId}`);
  return { deleted: true, webhookId };
}

module.exports = {
  registerWebhook, fireWebhook, deleteWebhook,
  ALLOWED_EVENTS, MAX_RETRIES,
  __setFirestoreForTests, __setFetchForTests,
};
