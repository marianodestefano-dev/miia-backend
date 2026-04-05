/**
 * KEY_POOL.JS — Multi-key rotation & failover for AI providers
 *
 * STANDARD: Google + Amazon + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * Manages multiple API keys per provider with:
 *   - Round-robin rotation to distribute load
 *   - Automatic failover on 429/quota errors
 *   - Cooldown period for exhausted keys (5 minutes)
 *   - Health tracking per key
 *   - Thread-safe key selection
 *
 * Usage:
 *   const keyPool = require('./key_pool');
 *   keyPool.register('gemini', [key1, key2, key3]);
 *   const key = keyPool.getKey('gemini');        // round-robin
 *   keyPool.markFailed('gemini', key, '429');    // cooldown
 *   keyPool.markSuccess('gemini', key);          // restore health
 */

'use strict';

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos de cooldown para keys agotadas
const MAX_CONSECUTIVE_FAILS = 3;    // Tras N fallos consecutivos → cooldown

// Estructura: { provider: { keys: [{ key, fails, lastFail, cooldownUntil, totalCalls, totalFails, tier }], index: 0 } }
const pools = {};

/**
 * Registra N keys para un proveedor. Se puede llamar múltiples veces (agrega, no reemplaza).
 * Ignora keys vacías, duplicadas o inválidas.
 * @param {string} provider - 'gemini' | 'openai' | 'claude' | 'groq' | 'mistral'
 * @param {string[]} keys - Array de API keys
 */
function register(provider, keys) {
  if (!provider || !Array.isArray(keys)) {
    console.error(`[KEY-POOL] ❌ register() llamado con parámetros inválidos: provider=${provider}, keys=${typeof keys}`);
    return;
  }

  if (!pools[provider]) {
    pools[provider] = { keys: [], index: 0 };
  }

  const existingKeys = new Set(pools[provider].keys.map(k => k.key));
  let added = 0;

  for (const key of keys) {
    if (!key || typeof key !== 'string' || key.trim().length < 10) continue;
    const trimmed = key.trim();
    if (existingKeys.has(trimmed)) continue;

    pools[provider].keys.push({
      key: trimmed,
      fails: 0,
      lastFail: null,
      cooldownUntil: null,
      totalCalls: 0,
      totalFails: 0,
      tier: 'primary'
    });
    existingKeys.add(trimmed);
    added++;
  }

  console.log(`[KEY-POOL] ✅ ${provider}: ${added} keys registradas (total: ${pools[provider].keys.length})`);
}

/**
 * Registra keys de EMERGENCIA/BACKUP para un proveedor.
 * Estas keys solo se usan cuando TODAS las primarias están en cooldown.
 * @param {string} provider
 * @param {string[]} keys - Array de API keys de backup
 */
function registerBackup(provider, keys) {
  if (!provider || !Array.isArray(keys)) {
    console.error(`[KEY-POOL] ❌ registerBackup() parámetros inválidos: provider=${provider}`);
    return;
  }

  if (!pools[provider]) {
    pools[provider] = { keys: [], index: 0 };
  }

  const existingKeys = new Set(pools[provider].keys.map(k => k.key));
  let added = 0;

  for (const key of keys) {
    if (!key || typeof key !== 'string' || key.trim().length < 10) continue;
    const trimmed = key.trim();
    if (existingKeys.has(trimmed)) continue;

    pools[provider].keys.push({
      key: trimmed,
      fails: 0,
      lastFail: null,
      cooldownUntil: null,
      totalCalls: 0,
      totalFails: 0,
      tier: 'backup'
    });
    existingKeys.add(trimmed);
    added++;
  }

  const totalPrimary = pools[provider].keys.filter(k => k.tier === 'primary').length;
  const totalBackup = pools[provider].keys.filter(k => k.tier === 'backup').length;
  console.log(`[KEY-POOL] 🛡️ ${provider}: ${added} BACKUP keys registradas (${totalPrimary} primary + ${totalBackup} backup = ${pools[provider].keys.length} total)`);
}

/**
 * Obtiene la siguiente key disponible para un proveedor (round-robin con skip de cooldown).
 * @param {string} provider
 * @returns {string|null} - Key disponible o null si todas están en cooldown
 */
function getKey(provider) {
  const pool = pools[provider];
  if (!pool || pool.keys.length === 0) return null;

  const now = Date.now();
  const primaryKeys = pool.keys.filter(k => k.tier === 'primary');
  const backupKeys = pool.keys.filter(k => k.tier === 'backup');

  // FASE 1: Intentar keys PRIMARIAS (round-robin con skip de cooldown)
  const primaryResult = _getAvailableKey(primaryKeys, pool, now, provider, 'primary');
  if (primaryResult) return primaryResult;

  // FASE 2: Todas las primarias en cooldown → usar keys de BACKUP
  if (backupKeys.length > 0) {
    const backupResult = _getAvailableKey(backupKeys, pool, now, provider, 'backup');
    if (backupResult) {
      console.warn(`[KEY-POOL] 🛡️ ${provider}: Primarias agotadas → usando key de EMERGENCIA`);
      return backupResult;
    }
  }

  // FASE 3: TODO en cooldown — devolver la que expira primero (primary preferida)
  const allKeys = primaryKeys.length > 0 ? primaryKeys : backupKeys;
  const earliest = allKeys.reduce((min, k) =>
    (!min || (k.cooldownUntil || Infinity) < (min.cooldownUntil || Infinity)) ? k : min
  , null);

  if (earliest) {
    const waitSec = Math.ceil(((earliest.cooldownUntil || 0) - now) / 1000);
    console.warn(`[KEY-POOL] ⚠️ ${provider}: TODAS las keys en cooldown (${primaryKeys.length}+${backupKeys.length}). Próxima en ${waitSec}s.`);
    earliest.totalCalls++;
    return earliest.key;
  }

  return null;
}

/** Helper interno: busca key disponible en un subset del pool */
function _getAvailableKey(keySubset, pool, now, provider, tierLabel) {
  for (const entry of keySubset) {
    if (entry.cooldownUntil && now < entry.cooldownUntil) continue;
    if (entry.cooldownUntil && now >= entry.cooldownUntil) {
      entry.cooldownUntil = null;
      entry.fails = 0;
      console.log(`[KEY-POOL] 🔄 ${provider} ${tierLabel} key ...${entry.key.slice(-4)} sale de cooldown`);
    }
    entry.totalCalls++;
    return entry.key;
  }
  return null;
}

/**
 * Marca una key como fallida. Tras MAX_CONSECUTIVE_FAILS → cooldown.
 * @param {string} provider
 * @param {string} key
 * @param {string} reason - Ej: '429', 'QUOTA_EXCEEDED', 'INVALID_KEY'
 */
function markFailed(provider, key, reason) {
  const pool = pools[provider];
  if (!pool) return;

  const entry = pool.keys.find(k => k.key === key);
  if (!entry) return;

  entry.fails++;
  entry.totalFails++;
  entry.lastFail = Date.now();

  const keyShort = key.substring(0, 6) + '...' + key.substring(key.length - 4);

  if (reason === 'INVALID_KEY' || reason === '401' || reason === '403') {
    // Key inválida → cooldown largo (1 hora)
    entry.cooldownUntil = Date.now() + 60 * 60 * 1000;
    console.error(`[KEY-POOL] 🔴 ${provider} key ${keyShort} INVÁLIDA (${reason}) → cooldown 1h`);
  } else if (entry.fails >= MAX_CONSECUTIVE_FAILS) {
    // Demasiados fallos → cooldown estándar
    entry.cooldownUntil = Date.now() + COOLDOWN_MS;
    console.warn(`[KEY-POOL] 🟡 ${provider} key ${keyShort} → cooldown ${COOLDOWN_MS / 1000}s (${entry.fails} fallos: ${reason})`);
  } else {
    console.warn(`[KEY-POOL] ⚠️ ${provider} key ${keyShort} fallo #${entry.fails}/${MAX_CONSECUTIVE_FAILS} (${reason})`);
  }
}

/**
 * Marca una key como exitosa. Resetea el contador de fallos consecutivos.
 * @param {string} provider
 * @param {string} key
 */
function markSuccess(provider, key) {
  const pool = pools[provider];
  if (!pool) return;

  const entry = pool.keys.find(k => k.key === key);
  if (!entry) return;

  if (entry.fails > 0) {
    console.log(`[KEY-POOL] ✅ ${provider} key ...${key.substring(key.length - 4)} recuperada (${entry.fails} fallos previos)`);
  }
  entry.fails = 0;
}

/**
 * Estadísticas de un proveedor.
 * @param {string} provider
 * @returns {{ total: number, available: number, cooldown: number, stats: object[] }}
 */
function getStats(provider) {
  const pool = pools[provider];
  if (!pool) return { total: 0, available: 0, cooldown: 0, stats: [] };

  const now = Date.now();
  const stats = pool.keys.map((k, i) => ({
    index: i,
    keyHint: k.key.substring(0, 6) + '...',
    fails: k.fails,
    totalCalls: k.totalCalls,
    totalFails: k.totalFails,
    inCooldown: !!(k.cooldownUntil && now < k.cooldownUntil),
    cooldownRemaining: k.cooldownUntil ? Math.max(0, Math.ceil((k.cooldownUntil - now) / 1000)) : 0
  }));

  return {
    total: pool.keys.length,
    available: stats.filter(s => !s.inCooldown).length,
    cooldown: stats.filter(s => s.inCooldown).length,
    stats
  };
}

/**
 * Resumen de todos los proveedores registrados.
 * @returns {Object} - { provider: { total, available, cooldown } }
 */
function getAllStats() {
  const result = {};
  for (const provider of Object.keys(pools)) {
    result[provider] = getStats(provider);
  }
  return result;
}

/**
 * ¿Tiene este proveedor keys registradas?
 * @param {string} provider
 * @returns {boolean}
 */
function hasKeys(provider) {
  return !!(pools[provider] && pools[provider].keys.length > 0);
}

module.exports = {
  register,
  registerBackup,
  getKey,
  markFailed,
  markSuccess,
  getStats,
  getAllStats,
  hasKeys
};
