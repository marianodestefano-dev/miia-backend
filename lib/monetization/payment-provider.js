/**
 * payment-provider.js — Factory + selector multi-provider para MIIAF1.
 *
 * Origen: replicado de apps/api-ludomiia/lib/monetization/payment-provider.js
 * (LudoMIIA Paso 2 firma Mariano 2026-05-12). Adaptado a miia-backend para
 * F1 billing (firma Mariano [BLOQUE B - MIIAF1 completo] 2026-05-12 ~19:00 COT).
 *
 * Mariano firma 2026-04-30 18:34 COT: solo MercadoPago + PayPal. Stripe FUERA.
 *   1. MercadoPago (default LATAM: AR/BR/CL/CO/MX/PE/UY)
 *   2. PayPal (resto + LATAM fallback)
 *
 * NOTA scope MIIAF1:
 *   - Este modulo es NUEVO en miia-backend. server.js tiene logica MP/PayPal
 *     legacy via fetch directo (lineas 15805-15990) que NO se toca.
 *   - Coexistencia OK: lib/monetization/* lo usa F1 billing (nuevo, limpio,
 *     con SDK oficial). server.js legacy queda para flujos owner-dashboard
 *     existentes hasta que alguien decida migrar (NO scope MIIAF1).
 */

'use strict';

const SUPPORTED_PROVIDERS = Object.freeze(['mercadopago', 'paypal']);

const PROVIDER_BY_COUNTRY = Object.freeze({
  // LATAM core: MercadoPago default
  AR: 'mercadopago',
  BR: 'mercadopago',
  CL: 'mercadopago',
  CO: 'mercadopago',
  MX: 'mercadopago',
  PE: 'mercadopago',
  UY: 'mercadopago',
  // Resto: PayPal default
  US: 'paypal',
  ES: 'paypal',
  GB: 'paypal',
  DE: 'paypal',
  FR: 'paypal',
  IT: 'paypal',
});

/**
 * Selecciona provider segun country code (ISO 2 letras).
 * Default fallback: 'paypal' (mas universal).
 *
 * @param {string} countryCode
 * @returns {'mercadopago'|'paypal'}
 */
function selectProvider(countryCode) {
  if (!countryCode || typeof countryCode !== 'string') return 'paypal';
  const cc = countryCode.toUpperCase().slice(0, 2);
  return PROVIDER_BY_COUNTRY[cc] || 'paypal';
}

function isProviderSupported(provider) {
  return SUPPORTED_PROVIDERS.includes(provider);
}

/**
 * Factory: devuelve el modulo provider implementacion concreta.
 * Lazy-require: solo carga el SDK cuando se llama.
 *
 * @param {string} countryCode - ISO 2-letter
 * @returns {Object} provider module con createCheckoutSession + verifyWebhook
 * @throws {Error} UNKNOWN_PROVIDER si selector retorna algo desconocido
 */
function getPaymentProvider(countryCode) {
  const providerName = selectProvider(countryCode);
  if (providerName === 'mercadopago') {
    return require('./providers/mercadopago');
  }
  /* istanbul ignore else — defensive, selectProvider() solo retorna mp|paypal */
  if (providerName === 'paypal') {
    return require('./providers/paypal');
  }
  /* istanbul ignore next — defensive unreachable */
  throw new Error(`UNKNOWN_PROVIDER: ${providerName}`);
}

const paymentProviderFor = selectProvider;

module.exports = {
  SUPPORTED_PROVIDERS,
  PROVIDER_BY_COUNTRY,
  selectProvider,
  paymentProviderFor,
  getPaymentProvider,
  isProviderSupported,
};
