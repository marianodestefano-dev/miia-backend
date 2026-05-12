'use strict';

const admin = require('firebase-admin');

const CACHE_TTL_MS = 5 * 60 * 1000;
const GLOBAL_PRICING_DOC = 'settings/pricing';

const _cache = new Map();

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || admin.firestore(); }

function _isCacheValid(entry) {
  return entry && entry.expiresAt > Date.now();
}

function _setCache(key, data) {
  _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function _getCached(key) {
  const entry = _cache.get(key);
  if (_isCacheValid(entry)) return entry.data;
  _cache.delete(key);
  return null;
}

function invalidateCache(key) {
  if (key) {
    _cache.delete(key);
  } else {
    _cache.clear();
  }
}

async function getGlobalPricing() {
  const cached = _getCached('__global__');
  if (cached) return cached;

  try {
    const db = getDb();
    const snap = await db.doc(GLOBAL_PRICING_DOC).get();
    if (!snap.exists) {
      const { PLANS, COUNTRY_MULTIPLIERS } = require('./pricing_calculator');
      const fallback = { plans: PLANS, country_multipliers: COUNTRY_MULTIPLIERS, source: 'hardcoded' };
      _setCache('__global__', fallback);
      return fallback;
    }
    const data = Object.assign({}, snap.data(), { source: 'firestore' });
    _setCache('__global__', data);
    return data;
  } catch (err) {
    console.error('[PRICING-MANAGER] Error cargando pricing global:', err.message);
    const { PLANS, COUNTRY_MULTIPLIERS } = require('./pricing_calculator');
    return { plans: PLANS, country_multipliers: COUNTRY_MULTIPLIERS, source: 'fallback_error' };
  }
}

async function getPricingForBiz(bizId) {
  if (!bizId) throw new Error('bizId requerido');

  const cacheKey = 'biz:' + bizId;
  const cached = _getCached(cacheKey);
  if (cached) return cached;

  try {
    const db = getDb();
    const snap = await db.doc('businesses/' + bizId + '/pricing/config').get();
    if (!snap.exists) {
      const global = await getGlobalPricing();
      return Object.assign({}, global, { bizId, custom: false });
    }
    const data = Object.assign({}, snap.data(), { bizId, custom: true, source: 'firestore' });
    _setCache(cacheKey, data);
    return data;
  } catch (err) {
    console.error('[PRICING-MANAGER] Error cargando pricing para ' + bizId + ':', err.message);
    throw err;
  }
}

async function setPricingForBiz(bizId, pricingData) {
  if (!bizId) throw new Error('bizId requerido');
  if (!pricingData || typeof pricingData !== 'object') throw new Error('pricingData invalido');

  try {
    const db = getDb();
    const payload = Object.assign({}, pricingData, {
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
    });
    await db.doc('businesses/' + bizId + '/pricing/config').set(payload, { merge: true });
    invalidateCache('biz:' + bizId);
    console.log('[PRICING-MANAGER] Pricing actualizado para ' + bizId);
    return { success: true, bizId };
  } catch (err) {
    console.error('[PRICING-MANAGER] Error guardando pricing para ' + bizId + ':', err.message);
    throw err;
  }
}

async function setGlobalPricing(pricingData) {
  if (!pricingData || typeof pricingData !== 'object') throw new Error('pricingData invalido');

  try {
    const db = getDb();
    const payload = Object.assign({}, pricingData, {
      updatedAt: new Date().toISOString(),
    });
    await db.doc(GLOBAL_PRICING_DOC).set(payload, { merge: true });
    invalidateCache('__global__');
    console.log('[PRICING-MANAGER] Pricing global actualizado');
    return { success: true };
  } catch (err) {
    console.error('[PRICING-MANAGER] Error guardando pricing global:', err.message);
    throw err;
  }
}

function getPricingByCountry(pricing, country) {
  if (!pricing) return null;
  const rules = pricing.country_rules || {};
  if (rules[country]) return rules[country];
  const mult = pricing.country_multipliers;
  return { multiplier: mult ? (mult[country] || mult.default || 1.0) : 1.0 };
}

function clearCacheForTests() {
  _cache.clear();
}

module.exports = {
  getGlobalPricing,
  getPricingForBiz,
  setPricingForBiz,
  setGlobalPricing,
  getPricingByCountry,
  invalidateCache,
  clearCacheForTests,
  __setFirestoreForTests,
  CACHE_TTL_MS,
  GLOBAL_PRICING_DOC,
};
