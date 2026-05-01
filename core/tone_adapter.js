'use strict';

/**
 * MIIA - Tone Adapter (T211)
 * MIIA adapta el tono de respuesta segun el tipo de contacto.
 */

const TONE_PROFILES = Object.freeze({
  formal: {
    greeting: 'Buenos dias',
    closing: 'Quedo a su disposicion',
    style: 'usted',
    emojiLevel: 0,
  },
  friendly: {
    greeting: 'Hola',
    closing: 'Cualquier consulta me avisas',
    style: 'tuteo',
    emojiLevel: 1,
  },
  casual: {
    greeting: 'Hey',
    closing: 'Cualquier cosa escribime',
    style: 'tuteo',
    emojiLevel: 2,
  },
  professional: {
    greeting: 'Estimado/a',
    closing: 'Atentamente',
    style: 'usted',
    emojiLevel: 0,
  },
  warm: {
    greeting: 'Hola que tal',
    closing: 'Estoy para lo que necesites',
    style: 'tuteo',
    emojiLevel: 1,
  },
});

const CONTACT_TYPE_TONES = Object.freeze({
  vip: 'warm',
  lead: 'friendly',
  client: 'friendly',
  enterprise: 'formal',
  support: 'professional',
  unknown: 'friendly',
});

const DEFAULT_TONE = 'friendly';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function getDefaultTone(contactType) {
  return CONTACT_TYPE_TONES[contactType] || DEFAULT_TONE;
}

function isValidTone(tone) {
  return tone in TONE_PROFILES;
}

function getToneProfile(tone) {
  return TONE_PROFILES[tone] || TONE_PROFILES[DEFAULT_TONE];
}

function applyTone(message, tone, opts) {
  if (!message || typeof message !== 'string') throw new Error('message requerido');
  var profile = getToneProfile(tone || DEFAULT_TONE);
  var result = message.trim();
  // Apply style transformations
  if (opts && opts.addGreeting) {
    result = profile.greeting + '! ' + result;
  }
  if (opts && opts.addClosing) {
    result = result + ' ' + profile.closing + '.';
  }
  return result;
}

async function saveTonePreference(uid, phone, tone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!isValidTone(tone)) throw new Error('tone invalido: ' + tone);
  try {
    await db().collection('tenants').doc(uid).collection('tone_preferences').doc(phone).set({ tone, updatedAt: new Date().toISOString() }, { merge: true });
  } catch (e) {
    console.error('[TONE_ADAPTER] Error guardando preferencia: ' + e.message);
    throw e;
  }
}

async function getTonePreference(uid, phone, contactType) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('tone_preferences').doc(phone).get();
    if (snap.exists) return snap.data().tone || getDefaultTone(contactType);
    return getDefaultTone(contactType);
  } catch (e) {
    console.error('[TONE_ADAPTER] Error leyendo preferencia: ' + e.message);
    return getDefaultTone(contactType);
  }
}

module.exports = {
  getDefaultTone,
  isValidTone,
  getToneProfile,
  applyTone,
  saveTonePreference,
  getTonePreference,
  TONE_PROFILES,
  CONTACT_TYPE_TONES,
  DEFAULT_TONE,
  __setFirestoreForTests,
};
