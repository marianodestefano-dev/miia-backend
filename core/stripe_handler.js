'use strict';

/**
 * MIIA - Stripe Handler (T182)
 * Integracion de pagos Stripe: payment intent, webhook, estado.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

let _httpClient = null;
function __setHttpClientForTests(fn) { _httpClient = fn; }

const STRIPE_ENDPOINT = 'https://api.stripe.com/v1';
const PAYMENT_INTENTS_PATH = '/payment_intents';

const INTENT_STATUSES = Object.freeze([
  'requires_payment_method', 'requires_confirmation', 'requires_action',
  'processing', 'requires_capture', 'canceled', 'succeeded',
]);

const SUPPORTED_CURRENCIES = Object.freeze(['usd', 'eur', 'gbp', 'brl', 'mxn', 'ars', 'cop', 'clp']);
const DEFAULT_CURRENCY = 'usd';
const MIN_AMOUNT_CENTS = 50;
const STRIPE_VERSION = '2023-10-16';

STRIPE_VERSION;


/**
 * Crea un PaymentIntent en Stripe.
 * @param {string} uid
 * @param {object} opts - {amount, currency, description, metadata}
 * @returns {Promise<{intentId, clientSecret, status, amount, currency}>}
 */
async function createPaymentIntent(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!opts || typeof opts !== 'object') throw new Error('opts requerido');
  if (typeof opts.amount !== 'number' || opts.amount < MIN_AMOUNT_CENTS) {
    throw new Error('amount debe ser numero >= ' + MIN_AMOUNT_CENTS + ' centavos');
  }

  const currency = (opts.currency || DEFAULT_CURRENCY).toLowerCase();
  if (!SUPPORTED_CURRENCIES.includes(currency)) throw new Error('currency no soportada: ' + currency);

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY no configurado');

  const body = new URLSearchParams({
    amount: String(Math.round(opts.amount)),
    currency,
    description: opts.description || 'Pago MIIA',
  });
  if (opts.metadata && typeof opts.metadata === 'object') {
    for (const [k, v] of Object.entries(opts.metadata)) {
      body.append('metadata[' + k + ']', String(v));
    }
  }

  const caller = _httpClient || _defaultPost;
  let timer;
  try {
    const abortCtrl = new AbortController();
    timer = setTimeout(() => abortCtrl.abort(), 15000);
    const resp = await caller(
      STRIPE_ENDPOINT + PAYMENT_INTENTS_PATH,
      body.toString(),
      {
        Authorization: 'Bearer ' + secretKey,
        'Stripe-Version': STRIPE_VERSION,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      abortCtrl.signal
    );

    if (!resp.id) throw new Error('respuesta invalida de Stripe: sin id');
    if (resp.error) throw new Error('Stripe error: ' + resp.error.message);

    const doc = {
      uid, intentId: resp.id,
      clientSecret: resp.client_secret,
      status: resp.status,
      amount: resp.amount,
      currency: resp.currency,
      createdAt: new Date().toISOString(),
    };
    await db().collection('stripe_intents').doc(uid).collection('intents').doc(resp.id).set(doc);
    console.log('[STRIPE] intent creado uid=' + uid.substring(0, 8) + ' id=' + resp.id);

    return {
      intentId: resp.id,
      clientSecret: resp.client_secret,
      status: resp.status,
      amount: resp.amount,
      currency: resp.currency,
    };
  } catch (e) {
    console.error('[STRIPE] Error creando intent uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function _defaultPost(url, body, headers, signal) {
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal,
  });
  return resp.json();
}


/**
 * Procesa un webhook de Stripe.
 * @param {string} uid
 * @param {object} event - {type, data: {object}}
 * @returns {Promise<{processed, intentId, status}>}
 */
async function processStripeWebhook(uid, event) {
  if (!uid) throw new Error('uid requerido');
  if (!event || typeof event !== 'object') throw new Error('event requerido');

  const type = event.type;
  if (!type || !type.startsWith('payment_intent.')) {
    console.log('[STRIPE] webhook tipo ignorado: ' + type);
    return { processed: false, reason: 'tipo no procesable: ' + type };
  }

  const intentObj = event.data && event.data.object;
  if (!intentObj || !intentObj.id) throw new Error('event.data.object.id requerido');

  const intentId = String(intentObj.id);
  const status = intentObj.status || 'unknown';

  try {
    await db()
      .collection('stripe_intents').doc(uid)
      .collection('intents').doc(intentId)
      .set({
        uid, intentId, status,
        amount: intentObj.amount || 0,
        currency: intentObj.currency || DEFAULT_CURRENCY,
        webhookType: type,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    console.log('[STRIPE] webhook procesado uid=' + uid.substring(0, 8) + ' intentId=' + intentId + ' status=' + status);
  } catch (e) {
    console.error('[STRIPE] Error guardando webhook: ' + e.message);
  }

  return { processed: true, intentId, status };
}

/**
 * Verifica si un PaymentIntent fue pagado exitosamente.
 * @param {string} status
 * @returns {boolean}
 */
function isPaymentSucceeded(status) {
  return status === 'succeeded';
}

/**
 * Obtiene historial de intents del owner.
 * @param {string} uid
 * @returns {Promise<object[]>}
 */
async function getIntentHistory(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db()
      .collection('stripe_intents').doc(uid)
      .collection('intents').get();
    const intents = [];
    snap.forEach(doc => intents.push({ id: doc.id, ...doc.data() }));
    return intents.sort((a, b) => {
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });
  } catch (e) {
    console.error('[STRIPE] Error leyendo historial uid=' + uid.substring(0, 8) + ': ' + e.message);
    return [];
  }
}

module.exports = {
  createPaymentIntent, processStripeWebhook, isPaymentSucceeded, getIntentHistory,
  INTENT_STATUSES, SUPPORTED_CURRENCIES, DEFAULT_CURRENCY,
  MIN_AMOUNT_CENTS, STRIPE_VERSION,
  __setFirestoreForTests, __setHttpClientForTests,
};
