'use strict';

/**
 * core/webhook_dedup.js -- VI-A7-DEDUP
 *
 * Idempotencia de webhooks por (provider, eventId|paymentId).
 * Si un webhook llega duplicado (re-envio PayPal, retry MP), se rechaza con duplicate=true.
 *
 * Colleccion: webhook_events/{provider}__{eventId}
 *   { provider, eventId, receivedAt, uid, eventType, payload (resumen) }
 *
 * API:
 *   markProcessed(provider, eventId, meta) -- returns { duplicate: bool }
 *   wasProcessed(provider, eventId)        -- returns bool
 *
 * INYECCION testeable: __setFirestoreForTests(fs) | __setNowForTests(fn)
 */

const admin = require('firebase-admin');

let _fsOverride = null;
let _nowOverride = null;

function __setFirestoreForTests(fs) { _fsOverride = fs; }
function __setNowForTests(fn) { _nowOverride = fn; }

function _fs() { return _fsOverride || /* istanbul ignore next */ admin.firestore(); }
function _now() { return _nowOverride ? _nowOverride() : /* istanbul ignore next */ new Date(); }

function _key(provider, eventId) {
  return String(provider) + '__' + String(eventId);
}

async function wasProcessed(provider, eventId) {
  if (!provider || !eventId) return false;
  const ref = _fs().collection('webhook_events').doc(_key(provider, eventId));
  const snap = await ref.get();
  return snap.exists === true;
}

async function markProcessed(provider, eventId, meta) {
  if (!provider || !eventId) {
    return { duplicate: false, skipped: true, reason: 'invalid_ids' };
  }
  const ref = _fs().collection('webhook_events').doc(_key(provider, eventId));
  const snap = await ref.get();
  if (snap.exists) {
    return { duplicate: true };
  }
  const payload = Object.assign({
    provider,
    eventId,
    receivedAt: _now().toISOString(),
  }, meta || {});
  await ref.set(payload);
  return { duplicate: false };
}

module.exports = {
  markProcessed,
  wasProcessed,
  __setFirestoreForTests,
  __setNowForTests,
};
