'use strict';

/**
 * R20-A -- core/pricing_engine.js (Planta Baja PB.2)
 * Pricing dinamico desde Firestore con cache 5 min.
 * Schema Firestore: config/pricing
 *   { plans: { basico, pro, enterprise }, country_rules: { CO, AR, MX, CL } }
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const PLAN_NAMES = ['basico', 'pro', 'enterprise'];
const VALID_COUNTRIES = ['CO', 'AR', 'MX', 'CL'];
const DEFAULT_CURRENCY = 'USD';
const DEFAULT_IVA = 0;
const DEFAULT_PRICING = {
  plans: {
    basico:     { price_usd: 29 },
    pro:        { price_usd: 79 },
    enterprise: { price_usd: 199 },
  },
  country_rules: {
    CO: { currency: 'COP', usd_rate: 4100, iva: 0.19 },
    AR: { currency: 'ARS', usd_rate: 1000, iva: 0.21 },
    MX: { currency: 'MXN', usd_rate: 17,   iva: 0.16 },
    CL: { currency: 'CLP', usd_rate: 900,  iva: 0.19 },
  },
};

let _cache = null;
let _cacheTs = 0;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; _cache = null; _cacheTs = 0; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _pricingDoc() {
  return db().collection('config').doc('pricing');
}
/**
 * Carga pricing desde Firestore con cache 5 min.
 * @returns {object} pricing data { plans, country_rules }
 */
async function loadPricing() {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_TTL_MS) {
    return _cache;
  }
  const snap = await _pricingDoc().get();
  const data = snap.exists ? snap.data() : DEFAULT_PRICING;
  _cache = data;
  _cacheTs = now;
  return data;
}

/**
 * Precio de un plan para un pais.
 * @param {string} plan
 * @param {string} countryCode
 * @returns {{ precio, moneda, iva }}
 */
async function getPlanPrice(plan, countryCode) {
  if (!plan || !PLAN_NAMES.includes(plan)) throw new Error('plan_invalido: ' + plan);
  const pricing = await loadPricing();
  const plans = pricing.plans || DEFAULT_PRICING.plans;
  const planData = plans[plan];
  if (!planData) throw new Error('plan_no_encontrado: ' + plan);
  const priceUsd = planData.price_usd || 0;
  const cc = (countryCode && VALID_COUNTRIES.includes(countryCode)) ? countryCode : null;
  if (!cc) {
    return { precio: priceUsd, moneda: DEFAULT_CURRENCY, iva: DEFAULT_IVA };
  }
  const cr = (pricing.country_rules || {})[cc] || {};
  const rate = cr.usd_rate || 1;
  const currency = cr.currency || DEFAULT_CURRENCY;
  const iva = (cr.iva !== undefined) ? cr.iva : DEFAULT_IVA;
  return { precio: Math.round(priceUsd * rate), moneda: currency, iva };
}
/**
 * Recomienda un plan segun tipo de negocio y citas mensuales.
 * @param {string} businessType
 * @param {number} citasMes
 * @returns {string} plan
 */
function getRecommendedPlan(businessType, citasMes) {
  const citas = parseInt(citasMes) || 0;
  const type = (businessType || '').toLowerCase();
  if (citas > 500 || type === 'enterprise' || type === 'corporativo') return 'enterprise';
  if (citas > 100 || type === 'clinica' || type === 'hotel' || type === 'gimnasio') return 'pro';
  return 'basico';
}

function _invalidateCache() { _cache = null; _cacheTs = 0; }

module.exports = {
  loadPricing,
  getPlanPrice,
  getRecommendedPlan,
  PLAN_NAMES,
  VALID_COUNTRIES,
  CACHE_TTL_MS,
  DEFAULT_PRICING,
  _invalidateCache,
  __setFirestoreForTests,
};
