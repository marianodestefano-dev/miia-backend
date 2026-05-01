'use strict';

/**
 * MIIA — Response Cache (T146)
 * Cache de respuestas LLM para evitar regenerar respuestas identicas.
 * TTL configurable, max size, eviction LRU simplificado.
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutos
const DEFAULT_MAX_SIZE = 500;

/**
 * Genera cache key a partir del prompt y contexto.
 */
function buildCacheKey(prompt, contextHash = '') {
  if (!prompt) return null;
  const input = `${prompt}|${contextHash}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

class ResponseCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxSize = DEFAULT_MAX_SIZE } = {}) {
    if (ttlMs <= 0) throw new Error('ttlMs debe ser > 0');
    if (maxSize <= 0) throw new Error('maxSize debe ser > 0');
    this._ttlMs = ttlMs;
    this._maxSize = maxSize;
    this._cache = new Map(); // key -> { response, timestamp, hits }
  }

  /**
   * Obtiene una respuesta del cache si es valida.
   * @param {string} key
   * @param {number} [nowMs]
   * @returns {string|null}
   */
  get(key, nowMs = Date.now()) {
    if (!key) return null;
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (nowMs - entry.timestamp > this._ttlMs) {
      this._cache.delete(key);
      return null;
    }
    entry.hits++;
    return entry.response;
  }

  /**
   * Guarda una respuesta en el cache.
   * @param {string} key
   * @param {string} response
   * @param {number} [nowMs]
   */
  set(key, response, nowMs = Date.now()) {
    if (!key) throw new Error('key requerida');
    if (response === null || response === undefined) throw new Error('response requerida');

    // Evict si sobre el limite (evict el entry mas antiguo)
    if (this._cache.size >= this._maxSize && !this._cache.has(key)) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }

    this._cache.set(key, { response, timestamp: nowMs, hits: 0 });
  }

  /**
   * Invalida una entrada especifica.
   */
  invalidate(key) {
    return this._cache.delete(key);
  }

  /**
   * Limpia entradas expiradas.
   * @returns {number} cantidad de entradas limpiadas
   */
  evictExpired(nowMs = Date.now()) {
    let count = 0;
    for (const [key, entry] of this._cache.entries()) {
      if (nowMs - entry.timestamp > this._ttlMs) {
        this._cache.delete(key);
        count++;
      }
    }
    return count;
  }

  clear() { this._cache.clear(); }

  get size() { return this._cache.size; }

  getStats() {
    let totalHits = 0;
    for (const entry of this._cache.values()) totalHits += entry.hits;
    return { size: this._cache.size, maxSize: this._maxSize, ttlMs: this._ttlMs, totalHits };
  }
}

module.exports = { ResponseCache, buildCacheKey, DEFAULT_TTL_MS, DEFAULT_MAX_SIZE };
