/**
 * paypal.js — PayPal provider para MIIAF1 billing.
 *
 * Origen: replicado de apps/api-ludomiia/lib/monetization/providers/paypal.js
 * con reuse de env vars miia-backend ya existentes:
 *   PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET (en uso server.js:15809)
 *
 * NUEVO env var requerido (Mariano debe setear pre-B.4 deploy):
 *   PAYPAL_WEBHOOK_ID    — ID del webhook configurado en PayPal Dashboard
 *
 * Otros env vars:
 *   PAYPAL_MODE          'production' o 'sandbox' (default sandbox)
 *
 * Mariano firma 2026-04-30: solo MP + PayPal. Stripe FUERA.
 */

'use strict';

const NAME = 'paypal';

let _client = null;
let _paypalSDK = null;
let _sdkInstalledOverride = null;
let _sdkInitFailOverride = false;

function _isSDKInstalled() {
  if (_sdkInstalledOverride !== null) return _sdkInstalledOverride;
  try {
    require.resolve('@paypal/checkout-server-sdk');
    return true;
  } catch {
    /* istanbul ignore next — SDK ya instalado en B.3.2 */
    return false;
  }
}

function _initSDK() {
  if (_client) return true;
  try {
    if (_sdkInitFailOverride) throw new Error('SDK_LOAD_FAIL_OVERRIDE');
    _paypalSDK = require('@paypal/checkout-server-sdk');
    const Environment =
      process.env.PAYPAL_MODE === 'production'
        ? _paypalSDK.core.LiveEnvironment
        : _paypalSDK.core.SandboxEnvironment;
    _client = new _paypalSDK.core.PayPalHttpClient(
      new Environment(process.env.PAYPAL_CLIENT_ID || '', process.env.PAYPAL_CLIENT_SECRET || ''),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Crea Checkout Order PayPal para activacion addon MIIAF1.
 *
 * @param {Object} args
 *   - uid: string (owner UID)
 *   - addon_id: 'f1_addon'
 *   - amount: number (USD)
 *   - currency: 'USD' default
 *   - success_url + cancel_url
 * @returns {Promise<{ checkoutUrl, init_point, sessionId, id, provider, sandbox }>}
 */
async function createCheckoutSession({ uid, addon_id, amount, currency, success_url, cancel_url }) {
  if (!_initSDK()) {
    const err = new Error('SDK_NOT_INSTALLED');
    err.code = 'SDK_NOT_INSTALLED';
    err.provider = NAME;
    throw err;
  }
  const request = new _paypalSDK.orders.OrdersCreateRequest();
  request.prefer('return=representation');
  const apiBase = process.env.API_URL || '';
  request.requestBody({
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: addon_id,
        amount: {
          currency_code: (currency || 'USD').toUpperCase(),
          value: typeof amount === 'number' ? amount.toFixed(2) : String(amount),
        },
        description: `MIIAF1 addon ($${amount} USD/mes)`,
        custom_id: `${uid}:${addon_id}`,
      },
    ],
    application_context: {
      return_url: success_url || `${apiBase}/api/f1/billing/checkout/success?uid=${uid}`,
      cancel_url: cancel_url || `${apiBase}/api/f1/billing/checkout/cancel?uid=${uid}`,
      brand_name: 'MIIAF1',
      user_action: 'PAY_NOW',
    },
  });
  const response = await _client.execute(request);
  const order = response.result;
  const approveLink = (order.links || []).find((l) => l.rel === 'approve');
  return {
    checkoutUrl: approveLink ? approveLink.href : null,
    init_point: approveLink ? approveLink.href : null,
    sessionId: order.id,
    id: order.id,
    provider: NAME,
    sandbox: process.env.PAYPAL_MODE !== 'production',
  };
}

async function getPaymentDetails(orderId) {
  if (!_initSDK()) {
    const err = new Error('SDK_NOT_INSTALLED');
    err.code = 'SDK_NOT_INSTALLED';
    err.provider = NAME;
    throw err;
  }
  const request = new _paypalSDK.orders.OrdersGetRequest(orderId);
  const response = await _client.execute(request);
  return response.result;
}

// URLs de cert PayPal permitidas (anti-SSRF).
const PAYPAL_CERT_ORIGINS = Object.freeze([
  'https://api.paypal.com/',
  'https://api.sandbox.paypal.com/',
  'https://api.paypalobjects.com/',
]);

/**
 * Verifica webhook PayPal con guards defensivos.
 *
 * Signature compatible con resolver f1_billing.js: (rawBody, signature, secret) => boolean
 * Devuelve true/false directo (sin objeto).
 *
 * Guards:
 *   1. Presencia de headers obligatorios.
 *   2. CERT-URL contra whitelist anti-SSRF.
 *   3. SDK disponible (si no, retorna false).
 *
 * NOTA: la verificacion criptografica RSA-SHA256 completa requiere fetch del cert
 * desde PayPal y signature check via SDK. Implementacion completa pendiente de
 * configurar PAYPAL_WEBHOOK_ID + cert pinning. Por ahora retorna defensive false
 * si SDK no disponible o headers missing.
 *
 * @param {string} rawBody — request body (string JSON)
 * @param {string} signature — header `paypal-transmission-sig` (compat con f1_billing.js)
 * @param {string} secret — env PAYPAL_WEBHOOK_ID
 * @param {Object} extra — { headers, webhookId } para verificacion completa
 * @returns {boolean}
 */
function verifyWebhook(rawBody, signature, secret, extra = {}) {
  const headers = extra.headers || {};

  // Compat: si caller pasa solo signature, intentamos validar mínimo (false defensive).
  if (!signature && !headers['paypal-transmission-sig']) return false;
  if (!secret && !extra.webhookId) return false;
  if (!rawBody) return false;

  // Si tiene headers completos, validacion full.
  const REQUIRED = [
    'paypal-transmission-id',
    'paypal-transmission-time',
    'paypal-cert-url',
    'paypal-auth-algo',
    'paypal-transmission-sig',
  ];

  // Si NO viene el objeto headers completo, hacemos validacion defensive minima.
  if (!extra.headers) {
    // Sin headers detallados no podemos validar firma RSA — defensive false.
    // En B.4 deploy real, caller f1_billing.js pasa headers via extra.
    return false;
  }

  for (const h of REQUIRED) {
    if (!headers[h]) return false;
  }

  const certUrl = headers['paypal-cert-url'];
  const allowedOrigin = PAYPAL_CERT_ORIGINS.some((origin) => certUrl.startsWith(origin));
  if (!allowedOrigin) return false;

  if (!_isSDKInstalled()) return false;

  // SDK disponible — pendiente wire de _paypalSDK.notifications.WebhookEvent.verify
  // que requiere PAYPAL_WEBHOOK_ID configurado. Por ahora devolvemos false hasta
  // configuracion completa en Mariano Railway dashboard.
  /* istanbul ignore next — wire SDK pendiente B.4 deploy */
  return false;
}

// Dependency injection para tests.
function _overrideSDKForTest(mocks) {
  if (mocks === null) {
    _client = null;
    _paypalSDK = null;
    _sdkInstalledOverride = null;
    _sdkInitFailOverride = false;
  } else {
    _client = mocks.client !== undefined ? mocks.client : {};
    _paypalSDK = mocks.sdk !== undefined ? mocks.sdk : {};
    if (mocks.sdkInstalled !== undefined) _sdkInstalledOverride = mocks.sdkInstalled;
    if (mocks.sdkInitFail !== undefined) _sdkInitFailOverride = mocks.sdkInitFail;
  }
}

module.exports = {
  name: NAME,
  createCheckoutSession,
  getPaymentDetails,
  verifyWebhook,
  PAYPAL_CERT_ORIGINS,
  _isSDKInstalled,
  _overrideSDKForTest,
};
