/**
 * mercadopago.js — MercadoPago provider para MIIAF1 billing.
 *
 * Origen: replicado de apps/api-ludomiia/lib/monetization/providers/mercadopago.js
 * con ADAPTACION env var naming compatible miia-backend:
 *   - api-ludomiia patron: MERCADOPAGO_ACCESS_TOKEN
 *   - miia-backend actual: MP_ACCESS_TOKEN (ya en uso en server.js:15997)
 *
 * Mariano firma 2026-04-30: solo MP + PayPal. Stripe FUERA.
 * Firma actual [BLOQUE B - MIIAF1 completo] 2026-05-12 19:00 COT.
 *
 * Env vars required (Railway prod):
 *   MP_ACCESS_TOKEN          (en uso, confirmado por Vi via [RESPUESTA-VI-MIIAF1] Q3)
 *   MP_WEBHOOK_SECRET        (NUEVO, Mariano debe setear pre-B.4 deploy)
 *   MP_SANDBOX               'true' en dev, 'false' o ausente en prod
 *   API_URL                  base URL para webhook callback
 */

'use strict';

const NAME = 'mercadopago';

let _client = null;
let _preference = null;
let _payment = null;
let _sdkInitFailOverride = false;
let _sdkInstalledOverride = null;

function _isSDKInstalled() {
  if (_sdkInstalledOverride !== null) return _sdkInstalledOverride;
  try {
    require.resolve('mercadopago');
    return true;
  } catch {
    /* istanbul ignore next — SDK ya instalado en B.3.2 (npm install --save mercadopago) */
    return false;
  }
}

function _initSDK() {
  if (_client) return true;
  try {
    if (_sdkInitFailOverride) throw new Error('SDK_LOAD_FAIL_OVERRIDE');
    const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
    _client = new MercadoPagoConfig({
      accessToken: process.env.MP_ACCESS_TOKEN || '',
    });
    _preference = new Preference(_client);
    _payment = new Payment(_client);
    return true;
  } catch {
    return false;
  }
}

/**
 * Crea Checkout Preference MP para activacion addon MIIAF1.
 *
 * @param {Object} args
 *   - uid: string (owner UID)
 *   - addon_id: 'f1_addon' generalmente
 *   - amount: numeric (USD, se convierte a moneda local en la preference)
 *   - currency: ISO 3-letter (default 'USD')
 *   - success_url + cancel_url (opcionales)
 * @returns {Promise<{ checkoutUrl, init_point, sessionId, id, provider, sandbox }>}
 */
async function createCheckoutSession({ uid, addon_id, amount, currency, success_url, cancel_url }) {
  if (!_initSDK()) {
    const err = new Error('SDK_NOT_INSTALLED');
    err.code = 'SDK_NOT_INSTALLED';
    err.provider = NAME;
    throw err;
  }
  const apiBase = process.env.API_URL || '';
  const preference = await _preference.create({
    body: {
      items: [
        {
          id: addon_id,
          title: `MIIAF1 addon ($${amount} USD/mes)`,
          quantity: 1,
          unit_price: amount,
          currency_id: currency || 'USD',
        },
      ],
      payer: { name: uid },
      back_urls: {
        success: success_url || `${apiBase}/api/f1/billing/checkout/success?uid=${uid}`,
        failure: cancel_url || `${apiBase}/api/f1/billing/checkout/cancel?uid=${uid}`,
        pending: `${apiBase}/api/f1/billing/checkout/pending?uid=${uid}`,
      },
      auto_return: 'approved',
      notification_url: `${apiBase}/api/f1/billing/webhook?country=AR`,
      external_reference: `${uid}:${addon_id}:${Date.now()}`,
      metadata: { uid, addon_id },
    },
  });
  return {
    checkoutUrl: preference.init_point,
    init_point: preference.init_point,
    sessionId: preference.id,
    id: preference.id,
    provider: NAME,
    sandbox: process.env.MP_SANDBOX === 'true',
  };
}

/**
 * Fetch payment details by ID (post-webhook handling).
 */
async function getPaymentDetails(paymentId) {
  if (!_initSDK()) {
    const err = new Error('SDK_NOT_INSTALLED');
    err.code = 'SDK_NOT_INSTALLED';
    err.provider = NAME;
    throw err;
  }
  return _payment.get({ id: paymentId });
}

/**
 * Verifica firma webhook MP (HMAC-SHA256, node:crypto, sin SDK).
 *
 * Adapter para que la signature coincida con la API de provider.verifyWebhook
 * que espera routes/f1_billing.js: (rawBody, signature, secret) => boolean.
 *
 * Parsea x-signature header MP ("ts=<ts>,v1=<hmac>") y valida contra:
 *   template = "id:<dataId>;request-id:<xRequestId>;ts:<ts>;"
 *
 * Devuelve boolean (true/false) — compatible con resolver actual.
 *
 * Nota: para el template necesita dataId (de query param `id`) y xRequestId
 * (header `x-request-id`). El caller debe construir el body que contiene
 * estos campos para que el HMAC se calcule correcto.
 *
 * @param {string} rawBody — JSON.stringify del payload (no usado en MP, solo PayPal)
 * @param {string} signature — header `x-signature` completo de MP
 * @param {string} secret — env MP_WEBHOOK_SECRET
 * @param {Object} extra — { dataId, xRequestId } (opcional para fallback)
 * @returns {boolean}
 */
function verifyWebhook(rawBody, signature, secret, extra = {}) {
  if (!signature || !secret) return false;

  const tsMatch = signature.match(/ts=([^,]+)/);
  const v1Match = signature.match(/v1=([^,]+)/);
  if (!tsMatch || !v1Match) return false;

  const ts = tsMatch[1].trim();
  const receivedHash = v1Match[1].trim();

  // Si caller no proveyo dataId/xRequestId, intentar extraer del rawBody.
  let dataId = extra.dataId;
  let xRequestId = extra.xRequestId;
  if (!dataId && rawBody) {
    try {
      const parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
      dataId = (parsed && parsed.data && parsed.data.id) || parsed.id;
    } catch {
      /* parse fail — dataId undefined */
    }
  }

  // Template MP: id:<dataId>;request-id:<xRequestId>;ts:<ts>;
  const parts = [];
  if (dataId) parts.push(`id:${dataId}`);
  if (xRequestId) parts.push(`request-id:${xRequestId}`);
  parts.push(`ts:${ts}`);
  const template = parts.join(';') + ';';

  const crypto = require('node:crypto');
  let expectedHash;
  try {
    expectedHash = crypto.createHmac('sha256', secret).update(template).digest('hex');
  } catch {
    /* istanbul ignore next — defensive crypto guard */
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(receivedHash, 'hex'),
      Buffer.from(expectedHash, 'hex'),
    );
  } catch {
    return false; // length mismatch o hex invalido
  }
}

// Dependency injection para tests — permite inyectar mocks sin SDK real.
function _overrideSDKForTest(mocks) {
  if (mocks === null) {
    _client = null;
    _preference = null;
    _payment = null;
    _sdkInitFailOverride = false;
    _sdkInstalledOverride = null;
  } else {
    _client = mocks.client !== undefined ? mocks.client : {};
    _preference = mocks.preference !== undefined ? mocks.preference : {};
    _payment = mocks.payment !== undefined ? mocks.payment : {};
    if (mocks.sdkInitFail !== undefined) _sdkInitFailOverride = mocks.sdkInitFail;
    if (mocks.sdkInstalled !== undefined) _sdkInstalledOverride = mocks.sdkInstalled;
  }
}

module.exports = {
  name: NAME,
  createCheckoutSession,
  getPaymentDetails,
  verifyWebhook,
  _isSDKInstalled,
  _overrideSDKForTest,
};
