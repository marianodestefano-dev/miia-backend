'use strict';

/**
 * MIIA - MIIA Persona Config (T212)
 * Owner configura nombre, estilo y personalidad de MIIA para su negocio.
 */

const DEFAULT_PERSONA = Object.freeze({
  name: 'MIIA',
  style: 'friendly',
  language: 'es',
  greeting: null,
  farewell: null,
  presentationLine: null,
  hideAI: false,
});

const ALLOWED_STYLES = Object.freeze(['formal', 'friendly', 'casual', 'professional', 'warm']);
const MAX_FIELD_LENGTH = 200;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function validatePersona(persona) {
  if (!persona || typeof persona !== 'object') return { valid: false, reason: 'persona debe ser objeto' };
  if (persona.name !== undefined) {
    if (typeof persona.name !== 'string' || persona.name.trim().length === 0) return { valid: false, reason: 'name invalido' };
    if (persona.name.length > MAX_FIELD_LENGTH) return { valid: false, reason: 'name muy largo' };
  }
  if (persona.style !== undefined) {
    if (!ALLOWED_STYLES.includes(persona.style)) return { valid: false, reason: 'style invalido: ' + persona.style };
  }
  if (persona.greeting !== undefined && persona.greeting !== null) {
    if (typeof persona.greeting !== 'string' || persona.greeting.length > MAX_FIELD_LENGTH) return { valid: false, reason: 'greeting muy largo' };
  }
  if (persona.farewell !== undefined && persona.farewell !== null) {
    if (typeof persona.farewell !== 'string' || persona.farewell.length > MAX_FIELD_LENGTH) return { valid: false, reason: 'farewell muy largo' };
  }
  return { valid: true };
}

function mergeWithDefault(partial) {
  return Object.assign({}, DEFAULT_PERSONA, partial);
}

async function savePersona(uid, persona) {
  if (!uid) throw new Error('uid requerido');
  if (!persona) throw new Error('persona requerido');
  var vr = validatePersona(persona);
  if (!vr.valid) throw new Error('persona invalida: ' + vr.reason);
  var merged = mergeWithDefault(persona);
  merged.updatedAt = new Date().toISOString();
  try {
    await db().collection('tenants').doc(uid).collection('config').doc('persona').set(merged, { merge: false });
    console.log('[MIIA_PERSONA] Persona guardada para ' + uid + ': ' + merged.name);
  } catch (e) {
    console.error('[MIIA_PERSONA] Error guardando persona: ' + e.message);
    throw e;
  }
}

async function getPersona(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('config').doc('persona').get();
    if (!snap.exists) return Object.assign({}, DEFAULT_PERSONA);
    return Object.assign({}, DEFAULT_PERSONA, snap.data());
  } catch (e) {
    console.error('[MIIA_PERSONA] Error leyendo persona: ' + e.message);
    return Object.assign({}, DEFAULT_PERSONA);
  }
}

async function resetToDefault(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var data = Object.assign({}, DEFAULT_PERSONA, { updatedAt: new Date().toISOString(), resetAt: new Date().toISOString() });
    await db().collection('tenants').doc(uid).collection('config').doc('persona').set(data, { merge: false });
  } catch (e) {
    console.error('[MIIA_PERSONA] Error reseteando persona: ' + e.message);
    throw e;
  }
}

function buildPersonaPromptHint(persona) {
  if (!persona) return '';
  var parts = [];
  var p = mergeWithDefault(persona);
  parts.push('Tu nombre es ' + p.name + '.');
  if (p.style) parts.push('Tu estilo de comunicacion es ' + p.style + '.');
  if (p.greeting) parts.push('Tu saludo es: "' + p.greeting + '".');
  if (p.farewell) parts.push('Tu despedida es: "' + p.farewell + '".');
  if (p.presentationLine) parts.push('Tu presentacion: "' + p.presentationLine + '".');
  if (p.hideAI) parts.push('No menciones que eres IA a menos que te lo pregunten directamente.');
  return parts.join(' ');
}

module.exports = {
  validatePersona,
  mergeWithDefault,
  savePersona,
  getPersona,
  resetToDefault,
  buildPersonaPromptHint,
  DEFAULT_PERSONA,
  ALLOWED_STYLES,
  MAX_FIELD_LENGTH,
  __setFirestoreForTests,
};
