'use strict';

/**
 * R22-B -- scripts/env_validator.js (Cimientos C.8)
 * Valida variables de entorno y servicios externos al startup.
 * Expone: validateEnv(), checkExternalServices(), generateReport()
 */

const REQUIRED_ENV_VARS = [
  'ML_APP_ID', 'ML_SECRET', 'ML_REDIRECT_URI',
  'FIREBASE_PROJECT_ID', 'GEMINI_API_KEY',
];

let _getEnv = /* istanbul ignore next */ () => process.env;
function __setEnvForTests(fn) { _getEnv = fn; }

let _checkFirestore = /* istanbul ignore next */ async () => {
  try { require('firebase-admin').firestore(); return true; } catch (_) { return false; }
};
function __setFirestoreCheckForTests(fn) { _checkFirestore = fn; }

/**
 * Valida las variables de entorno requeridas.
 * @returns {{ ok, missing[], invalid[] }}
 */
function validateEnv() {
  const env = _getEnv();
  const missing = [];
  const invalid = [];
  for (const v of REQUIRED_ENV_VARS) {
    if (!env[v]) missing.push(v);
  }
  if (env.GEMINI_API_KEY && !env.GEMINI_API_KEY.startsWith('AI')) {
    invalid.push('GEMINI_API_KEY');
  }
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

/**
 * Verifica disponibilidad de servicios externos.
 * @returns {{ gemini, firestore, smtp, railway }}
 */
async function checkExternalServices() {
  const env = _getEnv();
  const gemini = !!(env.GEMINI_API_KEY);
  const firestore = await _checkFirestore();
  const smtp = !!(env.SMTP_HOST && env.SMTP_USER);
  const railway = !!(env.RAILWAY_TOKEN);
  return { gemini, firestore, smtp, railway };
}

/**
 * Genera reporte legible para logs.
 * @returns {string}
 */
function generateReport() {
  const { ok, missing, invalid } = validateEnv();
  const lines = ['=== ENV VALIDATOR REPORT ===', 'Status: ' + (ok ? 'OK' : 'ERRORS')];
  if (missing.length > 0) lines.push('Missing: ' + missing.join(', '));
  if (invalid.length > 0) lines.push('Invalid: ' + invalid.join(', '));
  lines.push('===========================');
  return lines.join('\n');
}

module.exports = {
  validateEnv,
  checkExternalServices,
  generateReport,
  REQUIRED_ENV_VARS,
  __setEnvForTests,
  __setFirestoreCheckForTests,
};
