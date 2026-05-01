'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const DISPATCH_STATUSES = Object.freeze(['pending', 'success', 'failed', 'retrying', 'exhausted']);
const MAX_RETRY_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const WEBHOOK_TIMEOUT_MS = 15000;

function isValidStatus(s) { return DISPATCH_STATUSES.includes(s); }

function computeBackoffMs(attempt) {
  // Exponential backoff: 1s, 2s, 4s, capped at MAX_BACKOFF_MS
  return Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
}

function buildDispatchRecord(integrationId, eventId, data) {
  data = data || {};
  const now = Date.now();
  const dispatchId = integrationId.slice(0, 10) + '_dsp_' + eventId.slice(0, 10) + '_' + now.toString(36);
  return {
    dispatchId,
    integrationId,
    eventId,
    webhookUrl: typeof data.webhookUrl === 'string' ? data.webhookUrl.trim() : '',
    webhookMethod: data.webhookMethod || 'POST',
    webhookHeaders: data.webhookHeaders && typeof data.webhookHeaders === 'object' ? { ...data.webhookHeaders } : {},
    payload: data.payload && typeof data.payload === 'object' ? data.payload : {},
    status: 'pending',
    attempts: 0,
    maxAttempts: typeof data.maxAttempts === 'number' ? data.maxAttempts : MAX_RETRY_ATTEMPTS,
    lastAttemptAt: null,
    lastError: null,
    responseCode: null,
    responseBody: null,
    nextRetryAt: null,
    succeededAt: null,
    exhaustedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function buildDispatchResult(ok, statusCode, body, errorMsg) {
  return {
    ok: !!ok,
    statusCode: statusCode || null,
    body: typeof body === 'string' ? body.slice(0, 500) : null,
    errorMsg: typeof errorMsg === 'string' ? errorMsg : null,
    timestamp: Date.now(),
  };
}

function shouldRetry(record) {
  if (!record) return false;
  if (record.status === 'success' || record.status === 'exhausted') return false;
  return record.attempts < record.maxAttempts;
}

function applyDispatchResult(record, result) {
  const now = Date.now();
  const updated = { ...record, updatedAt: now, lastAttemptAt: now, attempts: record.attempts + 1 };
  if (result.ok) {
    updated.status = 'success';
    updated.responseCode = result.statusCode;
    updated.responseBody = result.body;
    updated.succeededAt = now;
    updated.nextRetryAt = null;
    updated.lastError = null;
  } else {
    updated.lastError = result.errorMsg || ('HTTP ' + result.statusCode);
    updated.responseCode = result.statusCode;
    if (updated.attempts >= updated.maxAttempts) {
      updated.status = 'exhausted';
      updated.exhaustedAt = now;
      updated.nextRetryAt = null;
    } else {
      updated.status = 'retrying';
      updated.nextRetryAt = now + computeBackoffMs(updated.attempts);
    }
  }
  return updated;
}

function buildDispatchSummaryText(dispatch) {
  if (!dispatch) return 'Despacho no encontrado.';
  const parts = [];
  const icons = { pending: '\u{23F3}', success: '\u{2705}', failed: '\u{274C}', retrying: '\u{1F504}', exhausted: '\u{1F6AB}' };
  const icon = icons[dispatch.status] || '\u{1F517}';
  parts.push(icon + ' Despacho: ' + dispatch.dispatchId.slice(0, 20) + '...');
  parts.push('Estado: ' + dispatch.status + ' | Intentos: ' + dispatch.attempts + '/' + dispatch.maxAttempts);
  if (dispatch.webhookUrl) parts.push('URL: ' + dispatch.webhookUrl.slice(0, 60) + (dispatch.webhookUrl.length > 60 ? '...' : ''));
  if (dispatch.responseCode) parts.push('HTTP: ' + dispatch.responseCode);
  if (dispatch.lastError) parts.push('Error: ' + dispatch.lastError.slice(0, 80));
  if (dispatch.succeededAt) parts.push('OK en: ' + new Date(dispatch.succeededAt).toISOString().slice(0, 16));
  return parts.join('\n');
}

async function saveDispatch(uid, dispatch) {
  console.log('[WEBHOOK] Guardando despacho id=' + dispatch.dispatchId + ' integId=' + dispatch.integrationId);
  try {
    await db().collection('owners').doc(uid)
      .collection('webhook_dispatches').doc(dispatch.dispatchId)
      .set(dispatch, { merge: false });
    return dispatch.dispatchId;
  } catch (err) {
    console.error('[WEBHOOK] Error guardando despacho:', err.message);
    throw err;
  }
}

async function getDispatch(uid, dispatchId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('webhook_dispatches').doc(dispatchId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[WEBHOOK] Error obteniendo despacho:', err.message);
    return null;
  }
}

async function updateDispatch(uid, dispatchId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  console.log('[WEBHOOK] Actualizando despacho id=' + dispatchId + ' status=' + (fields.status || '?'));
  try {
    await db().collection('owners').doc(uid)
      .collection('webhook_dispatches').doc(dispatchId)
      .set(update, { merge: true });
    return dispatchId;
  } catch (err) {
    console.error('[WEBHOOK] Error actualizando despacho:', err.message);
    throw err;
  }
}

async function listPendingDispatches(uid, opts) {
  opts = opts || {};
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('webhook_dispatches')
      .where('status', '==', 'pending').get();
    const retrySnap = await db().collection('owners').doc(uid)
      .collection('webhook_dispatches')
      .where('status', '==', 'retrying').get();
    const results = [];
    const now = Date.now();
    snap.forEach(d => results.push(d.data()));
    retrySnap.forEach(d => {
      const rec = d.data();
      if (!rec.nextRetryAt || rec.nextRetryAt <= now) results.push(rec);
    });
    if (opts.integrationId) return results.filter(r => r.integrationId === opts.integrationId);
    return results;
  } catch (err) {
    console.error('[WEBHOOK] Error listando despachos pendientes:', err.message);
    return [];
  }
}

async function listDispatchesByEvent(uid, eventId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('webhook_dispatches')
      .where('eventId', '==', eventId).get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results;
  } catch (err) {
    console.error('[WEBHOOK] Error listando despachos por evento:', err.message);
    return [];
  }
}

// Simula despacho HTTP (en tests se reemplaza con mock)
// En producción, usar fetch con AbortController (regla 6.18)
async function dispatchWebhook(dispatch, fetchFn) {
  if (!dispatch.webhookUrl) {
    return buildDispatchResult(false, null, null, 'webhookUrl vacia');
  }
  const fn = typeof fetchFn === 'function' ? fetchFn : null;
  if (!fn) {
    // En tests sin fetchFn real, retornar error controlado
    return buildDispatchResult(false, null, null, 'fetchFn no provisto');
  }
  try {
    const response = await fn(dispatch.webhookUrl, {
      method: dispatch.webhookMethod || 'POST',
      headers: { 'Content-Type': 'application/json', ...dispatch.webhookHeaders },
      body: JSON.stringify(dispatch.payload),
      timeout: WEBHOOK_TIMEOUT_MS,
    });
    const ok = response.status >= 200 && response.status < 300;
    const body = typeof response.text === 'function' ? await response.text() : String(response.body || '');
    return buildDispatchResult(ok, response.status, body, ok ? null : 'HTTP error ' + response.status);
  } catch (err) {
    return buildDispatchResult(false, null, null, err.message || 'Network error');
  }
}

module.exports = {
  buildDispatchRecord,
  buildDispatchResult,
  shouldRetry,
  applyDispatchResult,
  buildDispatchSummaryText,
  saveDispatch,
  getDispatch,
  updateDispatch,
  listPendingDispatches,
  listDispatchesByEvent,
  dispatchWebhook,
  computeBackoffMs,
  DISPATCH_STATUSES,
  MAX_RETRY_ATTEMPTS,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  WEBHOOK_TIMEOUT_MS,
  __setFirestoreForTests,
};
