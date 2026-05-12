'use strict';

/**
 * R18-A — data_fetcher.js (Piso 4 P4.3 - IDEA #008)
 * Verified Data Fetcher Pattern — abstracción reutilizable para APIs externas.
 * Estrategia: oficial → privado (adapterFn) → fallback (Gemini google_search)
 * AbortController en TODA llamada externa. Cache en memoria por topic + TTL configurable.
 */

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_TIMEOUT_MS = 10000;            // 10s

const INITIAL_TOPICS = Object.freeze(['finanzas', 'clima', 'noticias', 'deportes', 'tipos_cambio']);

const FRESHNESS = Object.freeze({
  HIT: 'cache_hit',
  OFICIAL: 'oficial',
  PRIVADO: 'privado',
  FALLBACK: 'fallback',
});

// Registry: topic → { adapterFn, oficial, fallback, cacheTTL }
const _registry = new Map();
// Cache: cacheKey → { data, source, freshness, expiresAt }
const _cache = new Map();
// Override para tests (evita esperas de 10s)
let _timeoutMs = DEFAULT_TIMEOUT_MS;

function __resetForTests() {
  _registry.clear();
  _cache.clear();
  _timeoutMs = DEFAULT_TIMEOUT_MS;
}

function __setTimeoutForTests(ms) { _timeoutMs = ms; }

/**
 * Registra un adapter para un topic dado.
 * @param {string} topic
 * @param {function} adapterFn — fuente privada/principal async(params, signal) → data|null
 * @param {object} opts — { oficial, fallback, cacheTTL }
 */
function registerAdapter(topic, adapterFn, opts) {
  if (!topic || typeof topic !== 'string') throw new Error('topic_requerido');
  if (typeof adapterFn !== 'function') throw new Error('adapterFn_requerido');
  const o = opts || {};
  _registry.set(topic, {
    adapterFn,
    oficial: o.oficial || null,
    fallback: o.fallback || null,
    cacheTTL: typeof o.cacheTTL === 'number' ? o.cacheTTL : DEFAULT_CACHE_TTL_MS,
  });
  console.log('[DATA-FETCHER] registerAdapter topic=' + topic);
  return true;
}

function _cacheKey(uid, topic, params) {
  return (uid || '') + ':' + topic + ':' + JSON.stringify(params || {});
}

function _getCached(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry;
}

function _setCache(key, result, ttl) {
  _cache.set(key, Object.assign({}, result, { expiresAt: Date.now() + ttl }));
}

/**
 * Llama fn con AbortController y timeout. Si el timeout dispara primero, rechaza con Error('timeout').
 * @param {function} fn — async(params, signal) → data
 * @param {object} params
 * @param {number} timeoutMs
 */
async function _tryStrategy(fn, params, timeoutMs) {
  const controller = new AbortController();
  let timerId = null;
  try {
    const result = await Promise.race([
      fn(params, controller.signal),
      new Promise(function (_, reject) {
        timerId = setTimeout(function () {
          controller.abort();
          reject(new Error('timeout'));
        }, timeoutMs);
      }),
    ]);
    clearTimeout(timerId);
    return result;
  } catch (e) {
    clearTimeout(timerId);
    throw e;
  }
}

/**
 * Busca datos para un topic con estrategia de 3 capas + cache.
 * @param {string|null} uid
 * @param {string} topic
 * @param {object} [params]
 * @returns {{ data, source, freshness }}
 */
async function fetch(uid, topic, params) {
  if (!topic) throw new Error('topic_requerido');
  const reg = _registry.get(topic);
  if (!reg) throw new Error('adapter_no_registrado:' + topic);

  const key = _cacheKey(uid, topic, params);
  const cached = _getCached(key);
  if (cached) {
    return { data: cached.data, source: cached.source, freshness: FRESHNESS.HIT };
  }

  const tout = _timeoutMs;
  let lastError = null;

  // Estrategia 1: oficial
  if (reg.oficial) {
    try {
      const data = await _tryStrategy(reg.oficial, params, tout);
      if (data != null) {
        const result = { data, source: 'oficial', freshness: FRESHNESS.OFICIAL };
        _setCache(key, result, reg.cacheTTL);
        console.log('[DATA-FETCHER] source=oficial uid=' + (uid || 'anon').slice(0, 8) + ' topic=' + topic);
        return result;
      }
    } catch (e) {
      lastError = e;
      console.warn('[DATA-FETCHER] oficial error topic=' + topic + ':', e.message);
    }
  }

  // Estrategia 2: privado (adapterFn principal)
  try {
    const data = await _tryStrategy(reg.adapterFn, params, tout);
    if (data != null) {
      const result = { data, source: 'privado', freshness: FRESHNESS.PRIVADO };
      _setCache(key, result, reg.cacheTTL);
      console.log('[DATA-FETCHER] source=privado uid=' + (uid || 'anon').slice(0, 8) + ' topic=' + topic);
      return result;
    }
  } catch (e) {
    lastError = e;
    console.warn('[DATA-FETCHER] privado error topic=' + topic + ':', e.message);
  }

  // Estrategia 3: fallback
  if (reg.fallback) {
    try {
      const data = await _tryStrategy(reg.fallback, params, tout);
      if (data != null) {
        const result = { data, source: 'fallback', freshness: FRESHNESS.FALLBACK };
        _setCache(key, result, reg.cacheTTL);
        console.log('[DATA-FETCHER] source=fallback uid=' + (uid || 'anon').slice(0, 8) + ' topic=' + topic);
        return result;
      }
    } catch (e) {
      lastError = e;
      console.warn('[DATA-FETCHER] fallback error topic=' + topic + ':', e.message);
    }
  }

  const errMsg = 'fetch_failed:' + topic + (lastError ? ':' + lastError.message : '');
  console.error('[DATA-FETCHER] todas las estrategias fallaron topic=' + topic);
  throw new Error(errMsg);
}

/**
 * Limpia la cache para un topic específico o toda la cache.
 * @param {string} [topic]
 */
function clearCache(topic) {
  if (topic) {
    for (const key of _cache.keys()) {
      if (key.includes(':' + topic + ':')) { _cache.delete(key); }
    }
  } else {
    _cache.clear();
  }
}

function getRegisteredTopics() {
  return Array.from(_registry.keys());
}

module.exports = {
  registerAdapter,
  fetch,
  clearCache,
  getRegisteredTopics,
  FRESHNESS,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  INITIAL_TOPICS,
  __resetForTests,
  __setTimeoutForTests,
};
