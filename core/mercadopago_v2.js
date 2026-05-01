'use strict';

/**
 * MIIA - MercadoPago V2 (T181)
 * Integracion de pagos MercadoPago: preference, webhook, estado.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

let _httpClient = null;
function __setHttpClientForTests(fn) { _httpClient = fn; }

const MP_ENDPOINT = 'https://api.mercadopago.com';
const PREFERENCE_PATH = '/checkout/preferences';
const PAYMENT_PATH = '/v1/payments';

const PAYMENT_STATUSES = Object.freeze([
  'pending', 'approved', 'authorized', 'in_process',
  'in_mediation', 'rejected', 'cancelled', 'refunded', 'charged_back',
]);

const SUPPORTED_CURRENCIES = Object.freeze(['ARS', 'BRL', 'CLP', 'COP', 'MXN', 'PEN', 'UYU']);
const DEFAULT_CURRENCY = 'ARS';
const MAX_ITEMS_PER_PREFERENCE = 50;
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;


/**
 * Crea una preferencia de pago en MercadoPago.
 * @param {string} uid - owner uid
 * @param {object} preference - {items, payer, backUrls, notificationUrl}
 * @returns {Promise<{preferenceId, initPoint, sandboxInitPoint}>}
 */
async function createPreference(uid, preference) {
  if (!uid) throw new Error('uid requerido');
  if (!preference || typeof preference !== 'object') throw new Error('preference requerido');
  if (!Array.isArray(preference.items) || preference.items.length === 0) {
    throw new Error('items requerido (array no vacio)');
  }
  if (preference.items.length > MAX_ITEMS_PER_PREFERENCE) {
    throw new Error('maximo ' + MAX_ITEMS_PER_PREFERENCE + ' items');
  }

  for (const item of preference.items) {
    if (!item.title) throw new Error('item.title requerido');
    if (typeof item.unit_price !== 'number' || item.unit_price <= 0) {
      throw new Error('item.unit_price debe ser numero positivo');
    }
    if (typeof item.quantity !== 'number' || item.quantity < 1) {
      throw new Error('item.quantity debe ser entero >= 1');
    }
  }

  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!accessToken) throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado');

  const poster = _httpClient || _defaultPost;
  let timer;
  try {
    const abortCtrl = new AbortController();
    timer = setTimeout(() => abortCtrl.abort(), 15000);
    const resp = await poster(
      MP_ENDPOINT + PREFERENCE_PATH,
      { ...preference, items: preference.items.slice(0, MAX_ITEMS_PER_PREFERENCE) },
      { Authorization: 'Bearer ' + accessToken },
      abortCtrl.signal
    );

    if (!resp.id) throw new Error('respuesta invalida de MercadoPago: sin id');

    const doc = {
      uid, preferenceId: resp.id,
      initPoint: resp.init_point,
      sandboxInitPoint: resp.sandbox_init_point,
      items: preference.items,
      status: 'created',
      createdAt: new Date().toISOString(),
    };

    await db().collection('mp_preferences').doc(uid).collection('preferences').doc(resp.id).set(doc);
    console.log('[MP] preferencia creada uid=' + uid.substring(0, 8) + ' id=' + resp.id);

    return {
      preferenceId: resp.id,
      initPoint: resp.init_point,
      sandboxInitPoint: resp.sandbox_init_point,
    };
  } catch (e) {
    console.error('[MP] Error creando preferencia uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function _defaultPost(url, body, headers, signal) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) throw new Error('MercadoPago HTTP ' + resp.status);
  return resp.json();
}

async function _defaultGet(url, headers, signal) {
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...headers },
    signal,
  });
  if (!resp.ok) throw new Error('MercadoPago HTTP ' + resp.status);
  return resp.json();
}


/**
 * Obtiene el estado de un pago desde MercadoPago.
 * @param {string} uid
 * @param {string} paymentId
 * @returns {Promise<{paymentId, status, amount, currency, payer}>}
 */
async function getPaymentStatus(uid, paymentId) {
  if (!uid) throw new Error('uid requerido');
  if (!paymentId) throw new Error('paymentId requerido');

  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!accessToken) throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado');

  const getter = _httpClient ? async (url, h, s) => _httpClient(url, null, h, s) : _defaultGet;
  let timer;
  try {
    const abortCtrl = new AbortController();
    timer = setTimeout(() => abortCtrl.abort(), 10000);
    const resp = await getter(
      MP_ENDPOINT + PAYMENT_PATH + '/' + paymentId,
      { Authorization: 'Bearer ' + accessToken },
      abortCtrl.signal
    );

    return {
      paymentId: String(resp.id || paymentId),
      status: resp.status || 'unknown',
      amount: resp.transaction_amount || 0,
      currency: resp.currency_id || DEFAULT_CURRENCY,
      payer: resp.payer || {},
    };
  } catch (e) {
    console.error('[MP] Error obteniendo pago uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Procesa un webhook de MercadoPago.
 * @param {string} uid
 * @param {object} payload - {type, data: {id}}
 * @returns {Promise<{processed, paymentId, status}>}
 */
async function processWebhook(uid, payload) {
  if (!uid) throw new Error('uid requerido');
  if (!payload || typeof payload !== 'object') throw new Error('payload requerido');

  const type = payload.type;
  if (type !== 'payment') {
    console.log('[MP] webhook tipo ignorado: ' + type);
    return { processed: false, reason: 'tipo no procesable: ' + type };
  }

  const paymentId = payload.data && payload.data.id ? String(payload.data.id) : null;
  if (!paymentId) throw new Error('payload.data.id requerido');

  let paymentInfo;
  try {
    paymentInfo = await getPaymentStatus(uid, paymentId);
  } catch (e) {
    console.error('[MP] Error consultando pago en webhook: ' + e.message);
    return { processed: false, reason: 'error consultando pago: ' + e.message };
  }

  try {
    await db()
      .collection('mp_payments').doc(uid)
      .collection('payments').doc(paymentId)
      .set({
        uid, paymentId,
        status: paymentInfo.status,
        amount: paymentInfo.amount,
        currency: paymentInfo.currency,
        receivedAt: new Date().toISOString(),
      }, { merge: true });
    console.log('[MP] webhook procesado uid=' + uid.substring(0, 8) + ' paymentId=' + paymentId + ' status=' + paymentInfo.status);
  } catch (e) {
    console.error('[MP] Error guardando webhook: ' + e.message);
  }

  return { processed: true, paymentId, status: paymentInfo.status };
}

/**
 * Obtiene el historial de pagos de un owner.
 * @param {string} uid
 * @returns {Promise<object[]>}
 */
async function getPaymentHistory(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db()
      .collection('mp_payments').doc(uid)
      .collection('payments').get();
    const payments = [];
    snap.forEach(doc => payments.push({ id: doc.id, ...doc.data() }));
    return payments.sort((a, b) => {
      const aTime = a.receivedAt ? new Date(a.receivedAt).getTime() : 0;
      const bTime = b.receivedAt ? new Date(b.receivedAt).getTime() : 0;
      return bTime - aTime;
    });
  } catch (e) {
    console.error('[MP] Error leyendo historial uid=' + uid.substring(0, 8) + ': ' + e.message);
    return [];
  }
}

/**
 * Verifica si un status de pago representa un pago exitoso.
 * @param {string} status
 * @returns {boolean}
 */
function isPaymentApproved(status) {
  return status === 'approved';
}

module.exports = {
  createPreference, getPaymentStatus, processWebhook,
  getPaymentHistory, isPaymentApproved,
  PAYMENT_STATUSES, SUPPORTED_CURRENCIES, DEFAULT_CURRENCY,
  MAX_ITEMS_PER_PREFERENCE,
  __setFirestoreForTests, __setHttpClientForTests,
};
