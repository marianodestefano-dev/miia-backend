'use strict';

/**
 * MIIA — Owner Settings API (T106)
 * GET/PUT configuracion del owner desde Firestore owners/{uid}.settings
 * Valida keys permitidas. No permite settings arbitrarios.
 */

const admin = require('firebase-admin');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || admin.firestore(); }

// Keys de settings permitidas y sus tipos
const ALLOWED_SETTINGS = Object.freeze({
  language: 'string',           // 'es', 'en', 'pt'
  timezone: 'string',           // 'America/Bogota', etc
  aiEnabled: 'boolean',         // activar/desactivar IA
  autoReply: 'boolean',         // respuesta automatica
  workingHoursEnabled: 'boolean',
  workingHoursStart: 'string',  // '09:00'
  workingHoursEnd: 'string',    // '18:00'
  maxResponseLength: 'number',  // max chars en respuesta
  notificationsEnabled: 'boolean',
});

const DEFAULTS = Object.freeze({
  language: 'es',
  timezone: 'America/Bogota',
  aiEnabled: true,
  autoReply: true,
  workingHoursEnabled: false,
  workingHoursStart: '09:00',
  workingHoursEnd: '18:00',
  maxResponseLength: 500,
  notificationsEnabled: true,
});

/**
 * Retorna los settings actuales del owner (merge con defaults).
 */
async function getSettings(uid) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  try {
    const snap = await db().collection('owners').doc(uid).get();
    if (!snap.exists) return { uid, settings: { ...DEFAULTS } };
    const data = snap.data();
    const saved = (data && data.settings) || {};
    // Merge defaults + saved (solo keys permitidas)
    const merged = { ...DEFAULTS };
    for (const key of Object.keys(ALLOWED_SETTINGS)) {
      if (key in saved) merged[key] = saved[key];
    }
    return { uid, settings: merged };
  } catch (e) {
    console.warn(`[SETTINGS] getSettings error uid=${uid.substring(0,8)}: ${e.message}`);
    return { uid, settings: { ...DEFAULTS }, error: e.message };
  }
}

/**
 * Actualiza settings del owner. Solo permite keys de ALLOWED_SETTINGS.
 * @param {string} uid
 * @param {object} updates - keys/values a actualizar
 * @returns {Promise<{ uid, settings, updatedKeys }>}
 */
async function updateSettings(uid, updates) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new Error('updates debe ser un objeto');
  }

  const validated = {};
  const errors = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!(key in ALLOWED_SETTINGS)) {
      errors.push(`key no permitida: ${key}`);
      continue;
    }
    const expectedType = ALLOWED_SETTINGS[key];
    if (typeof value !== expectedType) {
      errors.push(`${key} debe ser ${expectedType}, recibido ${typeof value}`);
      continue;
    }
    validated[key] = value;
  }

  if (errors.length > 0) throw new Error(`Settings inválidos: ${errors.join('; ')}`);
  if (Object.keys(validated).length === 0) throw new Error('No hay settings válidos para actualizar');

  await db().collection('owners').doc(uid).set(
    { settings: validated },
    { merge: true }
  );

  const updatedAt = new Date().toISOString();
  console.log(`[SETTINGS] updateSettings uid=${uid.substring(0,8)} keys=${Object.keys(validated).join(',')}`);
  return { uid, updatedKeys: Object.keys(validated), updatedAt };
}

module.exports = { getSettings, updateSettings, ALLOWED_SETTINGS, DEFAULTS, __setFirestoreForTests };
