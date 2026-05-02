'use strict';

/**
 * feature_flags.js -- VI-WIRE-1 safety net.
 * Centraliza lectura de feature flags para wire-in produccion.
 * Default: TODOS APAGADOS. Mariano enciende cuando valida.
 *
 * Variables esperadas (env):
 *   MIIA_MODO_DEPORTE_ENABLED=1   -> activa cron polling deportes
 *   PISO3_CATALOGO_ENABLED=1      -> activa parser self-chat catalogo
 *   PISO3_AUDIO_IN_ENABLED=1      -> activa transcripcion audio incoming
 *   PISO3_AUDIO_OUT_ENABLED=1     -> activa sintesis audio outgoing
 */

const FLAG_NAMES = Object.freeze([
  'MIIA_MODO_DEPORTE_ENABLED',
  'PISO3_CATALOGO_ENABLED',
  'PISO3_AUDIO_IN_ENABLED',
  'PISO3_AUDIO_OUT_ENABLED',
]);

let _db = null;

/**
 * Lee si una flag esta encendida. Acepta '1' (default), 'true', 'on'.
 * Cualquier otro valor (incluido undefined) -> false.
 */
function isFlagEnabled(name) {
  if (!name || typeof name !== 'string') return false;
  if (!FLAG_NAMES.includes(name)) return false;
  const v = process.env[name];
  if (!v) return false;
  const norm = String(v).toLowerCase().trim();
  return norm === '1' || norm === 'true' || norm === 'on' || norm === 'yes';
}

function getAllFlags() {
  const out = {};
  for (const name of FLAG_NAMES) out[name] = isFlagEnabled(name);
  return out;
}

function logFlagsState(logger) {
  const flags = getAllFlags();
  const enabled = Object.entries(flags).filter(([, v]) => v).map(([k]) => k);
  if (logger && typeof logger.info === 'function') {
    logger.info({ enabled, all: flags }, '[feature_flags] state');
  }
  return flags;
}

module.exports = {
  isFlagEnabled,
  getAllFlags,
  logFlagsState,
  FLAG_NAMES,
};

// ────────────────────────────────────────────────────────────
// API LEGACY (T147) -- per-tenant Firestore feature flags
// ────────────────────────────────────────────────────────────

const ALL_FLAGS = Object.freeze([
  'tts_enabled',
  'ai_v2_enabled',
  'broadcasts_enabled',
  'webhooks_enabled',
  'onboarding_v2_enabled',
  'audio_in_enabled',
  'audio_out_enabled',
  'modo_deporte_enabled',
  'catalogo_v2_enabled',
  'sla_enabled',
]);

const GLOBAL_DEFAULTS = Object.freeze({
  tts_enabled: false,
  ai_v2_enabled: false,
  broadcasts_enabled: true,
  webhooks_enabled: true,
  onboarding_v2_enabled: false,
  audio_in_enabled: false,
  audio_out_enabled: false,
  modo_deporte_enabled: false,
  catalogo_v2_enabled: false,
  sla_enabled: true,
});

const COL_FF = 'feature_flags';
const CACHE_TTL_MS = 5 * 60 * 1000;
const _flagsCache = new Map();

let _dbLegacy = null;
function __setFirestoreForTests(fs) { _dbLegacy = fs; _db = fs; }
/* istanbul ignore next: defensive db getter -- runtime real usa firebase-admin */
function _legacyDb() { return _dbLegacy || require('firebase-admin').firestore(); }

function _coerceBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1' || v === 'on' || v === 'yes';
  if (typeof v === 'number') return v !== 0;
  return false;
}

async function getFlags(uid, now) {
  if (!uid) throw new Error('uid requerido');
  const t = typeof now === 'number' ? now : Date.now();
  const cached = _flagsCache.get(uid);
  if (cached && (t - cached.ts) < CACHE_TTL_MS) return { ...cached.flags };

  let overrides = {};
  try {
    const doc = await _legacyDb().collection(COL_FF).doc(uid).get();
    if (doc && doc.exists) overrides = doc.data ? doc.data() : {};
  } catch (e) {
    // fail-open: usar defaults
    overrides = {};
  }
  const flags = { ...GLOBAL_DEFAULTS };
  for (const f of ALL_FLAGS) {
    if (overrides[f] !== undefined) flags[f] = _coerceBool(overrides[f]);
  }
  _flagsCache.set(uid, { ts: t, flags });
  return flags;
}

async function isEnabled(uid, flag) {
  if (!uid) throw new Error('uid requerido');
  if (!ALL_FLAGS.includes(flag)) throw new Error('flag invalido: ' + flag);
  const flags = await getFlags(uid);
  return !!flags[flag];
}

async function setFlags(uid, updates) {
  if (!uid) throw new Error('uid requerido');
  if (!updates || typeof updates !== 'object') throw new Error('updates requerido');
  const filtered = {};
  for (const f of Object.keys(updates)) {
    if (!ALL_FLAGS.includes(f)) throw new Error('flags invalidos: ' + f);
    filtered[f] = !!updates[f];
  }
  await _legacyDb().collection(COL_FF).doc(uid).set(filtered, { merge: true });
  _flagsCache.delete(uid);
}

function clearCache() {
  _flagsCache.clear();
}

module.exports.getFlags = getFlags;
module.exports.isEnabled = isEnabled;
module.exports.setFlags = setFlags;
module.exports.clearCache = clearCache;
module.exports.ALL_FLAGS = ALL_FLAGS;
module.exports.GLOBAL_DEFAULTS = GLOBAL_DEFAULTS;
module.exports.__setFirestoreForTests = __setFirestoreForTests;

