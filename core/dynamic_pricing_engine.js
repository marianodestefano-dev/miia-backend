'use strict';

/**
 * MIIA - Dynamic Pricing Engine (T231)
 * PB.2 ROADMAP: precios dinamicos desde Firestore, no hardcodeados.
 * Multi-moneda, country_rules, cache con listener Firestore.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const SUPPORTED_CURRENCIES = Object.freeze(['USD', 'ARS', 'COP', 'MXN', 'CLP', 'PEN', 'BRL']);

const DEFAULT_PLANS = Object.freeze({
  free: { priceUSD: 0, messagesPerDay: 50, broadcastsPerDay: 0, contacts: 100 },
  starter: { priceUSD: 19, messagesPerDay: 500, broadcastsPerDay: 2, contacts: 500 },
  pro: { priceUSD: 49, messagesPerDay: 5000, broadcastsPerDay: 10, contacts: 5000 },
  enterprise: { priceUSD: 149, messagesPerDay: 50000, broadcastsPerDay: 100, contacts: 50000 },
});

const COUNTRY_CURRENCY_MAP = Object.freeze({
  AR: 'ARS', CO: 'COP', MX: 'MXN', CL: 'CLP', PE: 'PEN', BR: 'BRL',
  US: 'USD', DEFAULT: 'USD',
});

const PLAN_NAMES = Object.freeze(['free', 'starter', 'pro', 'enterprise']);
const PRICING_COLLECTION = 'global_pricing';
const CACHE_TTL_MS = 5 * 60 * 1000;

var _cache = { data: null, fetchedAt: 0 };

function isCacheValid() {
  return _cache.data !== null && (Date.now() - _cache.fetchedAt) < CACHE_TTL_MS;
}

function invalidateCache() {
  _cache = { data: null, fetchedAt: 0 };
}

function isValidPlan(plan) {
  return PLAN_NAMES.includes(plan);
}

function isValidCurrency(currency) {
  return SUPPORTED_CURRENCIES.includes(currency);
}

function getCurrencyForCountry(countryCode) {
  return COUNTRY_CURRENCY_MAP[countryCode] || COUNTRY_CURRENCY_MAP.DEFAULT;
}

async function loadPricingFromFirestore() {
  if (isCacheValid()) return _cache.data;
  try {
    var snap = await db().collection(PRICING_COLLECTION).get();
    var pricing = {};
    snap.forEach(function(doc) { pricing[doc.id] = doc.data(); });
    if (Object.keys(pricing).length === 0) {
      _cache = { data: DEFAULT_PLANS, fetchedAt: Date.now() };
      return DEFAULT_PLANS;
    }
    _cache = { data: pricing, fetchedAt: Date.now() };
    return pricing;
  } catch (e) {
    console.error('[PRICING] Error cargando precios: ' + e.message + ' — usando defaults');
    _cache = { data: DEFAULT_PLANS, fetchedAt: Date.now() };
    return DEFAULT_PLANS;
  }
}

async function getPlanPrice(plan, countryCode) {
  if (!isValidPlan(plan)) throw new Error('plan invalido: ' + plan);
  var pricing = await loadPricingFromFirestore();
  var planData = pricing[plan] || DEFAULT_PLANS[plan] || {};
  var currency = getCurrencyForCountry(countryCode);
  var baseUSD = planData.priceUSD || 0;
  var currencyKey = 'price' + currency;
  var localPrice = planData[currencyKey] !== undefined ? planData[currencyKey] : null;
  return {
    plan,
    priceUSD: baseUSD,
    currency,
    localPrice,
    countryCode: countryCode || 'DEFAULT',
    features: {
      messagesPerDay: planData.messagesPerDay || 0,
      broadcastsPerDay: planData.broadcastsPerDay || 0,
      contacts: planData.contacts || 0,
    },
  };
}

async function getAllPlans(countryCode) {
  var results = {};
  for (var plan of PLAN_NAMES) {
    results[plan] = await getPlanPrice(plan, countryCode);
  }
  return results;
}

async function savePlanPricing(plan, priceData) {
  if (!isValidPlan(plan)) throw new Error('plan invalido: ' + plan);
  if (!priceData || typeof priceData !== 'object') throw new Error('priceData requerido');
  if (typeof priceData.priceUSD !== 'number' || priceData.priceUSD < 0) {
    throw new Error('priceUSD debe ser numero >= 0');
  }
  var record = { ...priceData, updatedAt: new Date().toISOString() };
  await db().collection(PRICING_COLLECTION).doc(plan).set(record, { merge: true });
  invalidateCache();
  console.log('[PRICING] Plan actualizado: ' + plan + ' priceUSD=' + priceData.priceUSD);
}

function comparePlans(planA, planB) {
  var a = DEFAULT_PLANS[planA];
  var b = DEFAULT_PLANS[planB];
  if (!a || !b) return null;
  return {
    planA,
    planB,
    priceDiffUSD: (b.priceUSD || 0) - (a.priceUSD || 0),
    messagesDiff: (b.messagesPerDay || 0) - (a.messagesPerDay || 0),
    broadcastsDiff: (b.broadcastsPerDay || 0) - (a.broadcastsPerDay || 0),
    contactsDiff: (b.contacts || 0) - (a.contacts || 0),
    upgradeRecommended: (b.priceUSD || 0) > (a.priceUSD || 0),
  };
}

function recommendPlan(usageStats) {
  if (!usageStats) return 'free';
  var daily = usageStats.avgMessagesPerDay || 0;
  var contacts = usageStats.totalContacts || 0;
  if (daily > 5000 || contacts > 5000) return 'enterprise';
  if (daily > 500 || contacts > 500) return 'pro';
  if (daily > 50 || contacts > 100) return 'starter';
  return 'free';
}

module.exports = {
  getPlanPrice,
  getAllPlans,
  savePlanPricing,
  comparePlans,
  recommendPlan,
  loadPricingFromFirestore,
  getCurrencyForCountry,
  isValidPlan,
  isValidCurrency,
  invalidateCache,
  SUPPORTED_CURRENCIES,
  DEFAULT_PLANS,
  COUNTRY_CURRENCY_MAP,
  PLAN_NAMES,
  CACHE_TTL_MS,
  __setFirestoreForTests,
};
