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
