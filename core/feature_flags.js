'use strict';

/**
 * MIIA — Feature Flags (T147)
 * Flags de funcionalidades por tenant con defaults globales.
 * Permite activar/desactivar features sin redeploy.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

const ALL_FLAGS = Object.freeze([
  'broadcasts_enabled',
  'tts_enabled',
  'ai_v2_enabled',
  'webhooks_enabled',
  'analytics_enabled',
  'export_enabled',
  'mmc_enabled',
  'audit_trail_enabled',
  'onboarding_v2_enabled',
  'smart_followups_enabled',
]);

const GLOBAL_DEFAULTS = Object.freeze({
  broadcasts_enabled: true,
  tts_enabled: false,
  ai_v2_enabled: false,
  webhooks_enabled: true,
  analytics_enabled: true,
  export_enabled: true,
  mmc_enabled: true,
  audit_trail_enabled: true,
  onboarding_v2_enabled: false,
  smart_followups_enabled: true,
});

// Cache en memoria TTL 5 minutos
const _flagCache = new Map(); // uid -> { flags, cachedAt }
const FLAG_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Obtiene los flags de un tenant.
 * @param {string} uid
 * @param {number} [nowMs]
 * @returns {Promise<object>} { flag: boolean, ... }
 */
async function getFlags(uid, nowMs = Date.now()) {
  if (!uid) throw new Error('uid requerido');

  // Verificar cache
  const cached = _flagCache.get(uid);
  if (cached && nowMs - cached.cachedAt < FLAG_CACHE_TTL_MS) {
    return cached.flags;
  }

  try {
    const snap = await db().collection('feature_flags').doc(uid).get();
    const overrides = snap.exists ? (snap.data() || {}) : {};
    const flags = {};
    for (const flag of ALL_FLAGS) {
      flags[flag] = flag in overrides ? Boolean(overrides[flag]) : GLOBAL_DEFAULTS[flag];
    }
    _flagCache.set(uid, { flags, cachedAt: nowMs });
    return flags;
  } catch (e) {
    console.error(`[FLAGS] Error leyendo flags uid=${uid.substring(0,8)}: ${e.message}`);
    return { ...GLOBAL_DEFAULTS };
  }
}

/**
 * Verifica si un flag especifico esta activo para un tenant.
 * @param {string} uid
 * @param {string} flagName
 * @param {number} [nowMs]
 * @returns {Promise<boolean>}
 */
async function isEnabled(uid, flagName, nowMs = Date.now()) {
  if (!uid) throw new Error('uid requerido');
  if (!ALL_FLAGS.includes(flagName)) throw new Error(`flag invalido: ${flagName}`);
  const flags = await getFlags(uid, nowMs);
  return Boolean(flags[flagName]);
}

/**
 * Actualiza flags de un tenant.
 * @param {string} uid
 * @param {object} updates - { flagName: boolean }
 */
async function setFlags(uid, updates) {
  if (!uid) throw new Error('uid requerido');
  if (!updates || typeof updates !== 'object') throw new Error('updates requerido');

  const invalid = Object.keys(updates).filter(k => !ALL_FLAGS.includes(k));
  if (invalid.length > 0) throw new Error(`flags invalidos: ${invalid.join(', ')}`);

  const sanitized = {};
  for (const [k, v] of Object.entries(updates)) {
    sanitized[k] = Boolean(v);
  }

  try {
    await db().collection('feature_flags').doc(uid).set(sanitized, { merge: true });
    _flagCache.delete(uid); // invalidar cache
    console.log(`[FLAGS] Updated uid=${uid.substring(0,8)}: ${JSON.stringify(sanitized)}`);
  } catch (e) {
    console.error(`[FLAGS] Error guardando flags uid=${uid.substring(0,8)}: ${e.message}`);
    throw e;
  }
}

function clearCache(uid) {
  if (uid) _flagCache.delete(uid);
  else _flagCache.clear();
}

module.exports = {
  getFlags,
  isEnabled,
  setFlags,
  clearCache,
  ALL_FLAGS,
  GLOBAL_DEFAULTS,
  __setFirestoreForTests,
};
