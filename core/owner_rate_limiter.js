'use strict';

/**
 * MIIA — Owner-Configurable Rate Limiter (T98)
 * Extiende rate limiting base con config por owner desde Firestore.
 * owners/{uid}.rateLimits = { perContact: 5, perTenant: 50, windowSecs: 30 }
 * Recargable sin restart via reloadConfig(uid).
 */

const admin = require('firebase-admin');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || admin.firestore(); }

// Defaults base (pueden ser sobreescritos por config del owner)
const DEFAULTS = Object.freeze({
  perContact: 5,       // max mensajes por contacto en windowSecs
  perTenant: 50,       // max mensajes totales del tenant en windowSecs
  windowSecs: 30,      // ventana en segundos
});

// Cache en RAM: uid -> { config, loadedAt, counters: { contact: {phone: [{ts}]}, tenant: [{ts}] } }
const _cache = {};

/**
 * Carga o recarga la config de rate limit para un owner desde Firestore.
 * Si Firestore falla o no tiene config, usa DEFAULTS.
 * @param {string} uid
 * @returns {Promise<{perContact, perTenant, windowSecs}>}
 */
async function reloadConfig(uid) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  let config = { ...DEFAULTS };
  try {
    const snap = await db().collection('owners').doc(uid).get();
    if (snap.exists) {
      const data = snap.data();
      if (data.rateLimits && typeof data.rateLimits === 'object') {
        if (typeof data.rateLimits.perContact === 'number') config.perContact = data.rateLimits.perContact;
        if (typeof data.rateLimits.perTenant === 'number') config.perTenant = data.rateLimits.perTenant;
        if (typeof data.rateLimits.windowSecs === 'number') config.windowSecs = data.rateLimits.windowSecs;
      }
    }
    console.log(`[RATE-CFG] uid=${uid.substring(0,8)} config=${JSON.stringify(config)}`);
  } catch (e) {
    console.warn(`[RATE-CFG] Firestore error para uid=${uid.substring(0,8)}, usando defaults: ${e.message}`);
  }
  if (!_cache[uid]) _cache[uid] = { config, loadedAt: Date.now(), contact: {}, tenant: [] };
  else { _cache[uid].config = config; _cache[uid].loadedAt = Date.now(); }
  return config;
}

/**
 * Retorna config activa para un uid (usa cache o defaults si no cargado).
 */
function getConfig(uid) {
  if (_cache[uid]) return _cache[uid].config;
  return { ...DEFAULTS };
}

/**
 * Verifica si un contacto puede recibir mensaje. Registra si permite.
 * @returns {{ allowed: boolean, reason?: string }}
 */
function contactAllows(uid, phone, nowMs = Date.now()) {
  if (!uid || !phone) return { allowed: false, reason: 'uid o phone requerido' };
  const cfg = getConfig(uid);
  const windowMs = cfg.windowSecs * 1000;

  if (!_cache[uid]) _cache[uid] = { config: cfg, loadedAt: Date.now(), contact: {}, tenant: [] };
  const entry = _cache[uid];

  // Limpiar entries vencidas del contacto
  if (!entry.contact[phone]) entry.contact[phone] = [];
  entry.contact[phone] = entry.contact[phone].filter(ts => nowMs - ts < windowMs);

  if (entry.contact[phone].length >= cfg.perContact) {
    console.warn(`[RATE-LIMIT] contact bloqueado phone=${phone} uid=${uid.substring(0,8)} count=${entry.contact[phone].length}/${cfg.perContact}`);
    return { allowed: false, reason: 'contact_rate_exceeded' };
  }

  // Verificar limite del tenant
  entry.tenant = entry.tenant.filter(ts => nowMs - ts < windowMs);
  if (entry.tenant.length >= cfg.perTenant) {
    console.warn(`[RATE-LIMIT] tenant bloqueado uid=${uid.substring(0,8)} count=${entry.tenant.length}/${cfg.perTenant}`);
    return { allowed: false, reason: 'tenant_rate_exceeded' };
  }

  // Registrar
  entry.contact[phone].push(nowMs);
  entry.tenant.push(nowMs);
  return { allowed: true };
}

/**
 * Resetea contadores de un uid (para tests o reinicio).
 */
function resetCounters(uid) {
  if (_cache[uid]) { _cache[uid].contact = {}; _cache[uid].tenant = []; }
}

/**
 * Limpia cache completo (para tests).
 */
function clearCache() {
  for (const k of Object.keys(_cache)) delete _cache[k];
}

module.exports = {
  reloadConfig, getConfig, contactAllows, resetCounters, clearCache,
  DEFAULTS, __setFirestoreForTests,
};
