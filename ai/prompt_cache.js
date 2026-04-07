// ════════════════════════════════════════════════════════════════════════════
// MIIA — Prompt Cache (P5.5)
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// Cache en memoria para system prompts frecuentes.
// Reduce tokens enviados a la IA al cachear prompts que no cambian seguido.
// TTL por tipo: cerebro (5min), system prompt (10min), clasificación (1h).
// ════════════════════════════════════════════════════════════════════════════

'use strict';

// Cache: { key: { value, createdAt, hits, ttl } }
const cache = new Map();

// TTLs por tipo (ms)
const TTL = {
  SYSTEM_PROMPT: 10 * 60 * 1000,   // 10 min — prompts del sistema
  CEREBRO: 5 * 60 * 1000,          // 5 min — cerebro del negocio (cambia más seguido)
  CLASSIFICATION: 60 * 60 * 1000,  // 1 hora — prompt de clasificación (estático)
  SPORT: 30 * 60 * 1000,           // 30 min — prompt deportivo
  GENERAL: 15 * 60 * 1000          // 15 min — default
};

// Métricas
const metrics = {
  hits: 0,
  misses: 0,
  evictions: 0,
  sets: 0
};

/**
 * Genera una key de cache basada en el tipo y parámetros.
 * @param {string} type - Tipo de prompt
 * @param {string} uid - Owner UID
 * @param {string} [extra] - Parámetro extra (bizId, phone, etc.)
 */
function makeKey(type, uid, extra = '') {
  return `${type}:${uid}:${extra}`;
}

/**
 * Obtiene un prompt del cache si existe y no expiró.
 * @returns {string|null} El prompt cacheado o null si no existe/expiró
 */
function get(type, uid, extra = '') {
  const key = makeKey(type, uid, extra);
  const entry = cache.get(key);

  if (!entry) {
    metrics.misses++;
    return null;
  }

  // Verificar TTL
  if (Date.now() - entry.createdAt > entry.ttl) {
    cache.delete(key);
    metrics.misses++;
    metrics.evictions++;
    return null;
  }

  entry.hits++;
  metrics.hits++;
  return entry.value;
}

/**
 * Guarda un prompt en cache.
 * @param {string} type - Tipo de prompt (para determinar TTL)
 * @param {string} uid - Owner UID
 * @param {string} value - El prompt a cachear
 * @param {string} [extra] - Parámetro extra
 * @param {number} [customTtl] - TTL personalizado (ms)
 */
function set(type, uid, value, extra = '', customTtl = null) {
  if (!value || typeof value !== 'string') return;

  const key = makeKey(type, uid, extra);
  const ttl = customTtl || TTL[type] || TTL.GENERAL;

  cache.set(key, {
    value,
    createdAt: Date.now(),
    hits: 0,
    ttl
  });
  metrics.sets++;

  // Limitar tamaño del cache (max 500 entries)
  if (cache.size > 500) {
    evictOldest();
  }
}

/**
 * Invalida un entry específico del cache.
 */
function invalidate(type, uid, extra = '') {
  const key = makeKey(type, uid, extra);
  const deleted = cache.delete(key);
  if (deleted) {
    console.log(`[PROMPT-CACHE] 🗑️ Invalidado: ${key}`);
  }
  return deleted;
}

/**
 * Invalida TODOS los entries de un owner.
 * Útil cuando el owner actualiza su cerebro o configuración.
 */
function invalidateOwner(uid) {
  let count = 0;
  for (const key of cache.keys()) {
    if (key.includes(`:${uid}:`)) {
      cache.delete(key);
      count++;
    }
  }
  if (count > 0) {
    console.log(`[PROMPT-CACHE] 🗑️ ${count} entries invalidados para owner ${uid}`);
  }
  return count;
}

/**
 * Elimina las entries más viejas cuando el cache está lleno.
 */
function evictOldest() {
  let oldest = null;
  let oldestKey = null;

  for (const [key, entry] of cache.entries()) {
    if (!oldest || entry.createdAt < oldest.createdAt) {
      oldest = entry;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    cache.delete(oldestKey);
    metrics.evictions++;
  }
}

/**
 * Limpia entries expirados.
 */
function cleanup() {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of cache.entries()) {
    if (now - entry.createdAt > entry.ttl) {
      cache.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    metrics.evictions += cleaned;
    console.log(`[PROMPT-CACHE] 🧹 Cleanup: ${cleaned} entries expirados removidos`);
  }
}

/**
 * Obtiene métricas del cache.
 */
function getStats() {
  const hitRate = (metrics.hits + metrics.misses) > 0
    ? Math.round((metrics.hits / (metrics.hits + metrics.misses)) * 100)
    : 0;

  return {
    size: cache.size,
    hits: metrics.hits,
    misses: metrics.misses,
    hitRate: `${hitRate}%`,
    sets: metrics.sets,
    evictions: metrics.evictions,
    timestamp: new Date().toISOString()
  };
}

/**
 * Health check.
 */
function healthCheck() {
  return {
    status: 'ok',
    ...getStats()
  };
}

// Auto-cleanup cada 5 minutos
setInterval(cleanup, 5 * 60 * 1000);

module.exports = {
  TTL,
  get,
  set,
  invalidate,
  invalidateOwner,
  cleanup,
  getStats,
  healthCheck
};
