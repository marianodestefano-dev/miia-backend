'use strict';

/**
 * MiiaF1 — Cache datos live (Redis con fallback en memoria)
 * TTL: 30s (datos live tienen vida corta)
 * Si Redis no esta disponible: fallback a Map en memoria.
 */

const CACHE_TTL_MS = 30 * 1000;

// Fallback en memoria si Redis no esta disponible
const _memCache = new Map();

let _redisClient = null;
let _redisAvailable = false;

/**
 * Intenta conectar a Redis. Si falla, usa memoria.
 * @param {string} redisUrl - REDIS_URL de env
 */
async function initRedis(redisUrl) {
  if (!redisUrl) {
    console.warn('[F1-CACHE] Sin REDIS_URL, usando cache en memoria');
    return;
  }
  try {
    // Intentar cargar ioredis (opcional)
    const Redis = require('ioredis');
    _redisClient = new Redis(redisUrl, { lazyConnect: true, connectTimeout: 3000 });
    await _redisClient.connect();
    _redisAvailable = true;
    console.log('[F1-CACHE] Redis conectado:', redisUrl.split('@').pop());
  } catch (err) {
    console.warn(`[F1-CACHE] Redis no disponible (${err.message}), usando memoria`);
    _redisClient = null;
    _redisAvailable = false;
  }
}

async function _set(key, value) {
  const entry = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  if (_redisAvailable && _redisClient) {
    await _redisClient.set(key, JSON.stringify(entry), 'PX', CACHE_TTL_MS);
  } else {
    _memCache.set(key, entry);
  }
}

async function _get(key) {
  if (_redisAvailable && _redisClient) {
    const raw = await _redisClient.get(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    return entry.value;
  }
  const entry = _memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _memCache.delete(key); return null; }
  return entry.value;
}

// ─── API publica ──────────────────────────────────────

async function setDriverPosition(driverNumber, data) {
  await _set(`f1:pos:${driverNumber}`, data);
}

async function getDriverPosition(driverNumber) {
  return await _get(`f1:pos:${driverNumber}`);
}

async function setAllPositions(positions) {
  for (const pos of positions) {
    await setDriverPosition(pos.driver_number, pos);
  }
  await _set('f1:positions:all', positions);
}

async function getAllPositions() {
  const cached = await _get('f1:positions:all');
  if (cached) return cached;

  // Reconstruir desde cache individual (si existe)
  const positions = [];
  for (let n = 1; n <= 99; n++) {
    const pos = await _get(`f1:pos:${n}`);
    if (pos) positions.push(pos);
  }
  return positions.sort((a, b) => (a.position || 99) - (b.position || 99));
}

async function setRaceStatus(status) {
  await _set('f1:race:status', status);
}

async function getRaceStatus() {
  return (await _get('f1:race:status')) || { isLive: false };
}

function clearMemCache() { _memCache.clear(); }
function isRedisAvailable() { return _redisAvailable; }

// Singleton
let _instance = null;
function getLiveCache() {
  if (!_instance) {
    _instance = { initRedis, setDriverPosition, getDriverPosition, setAllPositions, getAllPositions, setRaceStatus, getRaceStatus, clearMemCache, isRedisAvailable };
  }
  return _instance;
}

module.exports = { getLiveCache };
