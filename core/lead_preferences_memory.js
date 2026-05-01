'use strict';

/**
 * MIIA - Lead Preferences Memory (T213)
 * MIIA recuerda preferencias del lead entre sesiones.
 */

const PREFERENCE_TYPES = Object.freeze([
  'language', 'tone', 'contactMethod', 'timeSlot', 'budget', 
  'interest', 'location', 'lastPurchase', 'category', 'notes',
]);

const MAX_PREFERENCES_PER_LEAD = 20;
const PREFERENCE_TTL_DAYS = 180;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidPreferenceType(type) {
  return PREFERENCE_TYPES.includes(type);
}

async function savePreference(uid, phone, type, value) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!type) throw new Error('type requerido');
  if (value === undefined || value === null) throw new Error('value requerido');
  if (!isValidPreferenceType(type)) throw new Error('type invalido: ' + type);
  var docId = phone.replace(/\+/g, '').replace(/[^0-9a-z]/gi, '');
  var data = {};
  data[type] = { value, updatedAt: new Date().toISOString() };
  try {
    await db().collection('tenants').doc(uid).collection('lead_preferences').doc(docId).set(data, { merge: true });
    console.log('[LEAD_PREFS] Guardada preferencia ' + type + ' para ' + phone);
  } catch (e) {
    console.error('[LEAD_PREFS] Error guardando preferencia: ' + e.message);
    throw e;
  }
}

async function getPreference(uid, phone, type) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!type) throw new Error('type requerido');
  var docId = phone.replace(/\+/g, '').replace(/[^0-9a-z]/gi, '');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('lead_preferences').doc(docId).get();
    if (!snap.exists) return null;
    var data = snap.data();
    return (data[type] && data[type].value !== undefined) ? data[type].value : null;
  } catch (e) {
    console.error('[LEAD_PREFS] Error leyendo preferencia: ' + e.message);
    return null;
  }
}

async function getAllPreferences(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  var docId = phone.replace(/\+/g, '').replace(/[^0-9a-z]/gi, '');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('lead_preferences').doc(docId).get();
    if (!snap.exists) return {};
    var raw = snap.data() || {};
    var result = {};
    var now = Date.now();
    var ttlMs = PREFERENCE_TTL_DAYS * 24 * 60 * 60 * 1000;
    Object.keys(raw).forEach(function(k) {
      if (!isValidPreferenceType(k)) return;
      var entry = raw[k];
      if (!entry || entry.value === undefined) return;
      var age = entry.updatedAt ? now - new Date(entry.updatedAt).getTime() : Infinity;
      if (age < ttlMs) result[k] = entry.value;
    });
    return result;
  } catch (e) {
    console.error('[LEAD_PREFS] Error leyendo preferencias: ' + e.message);
    return {};
  }
}

async function deletePreference(uid, phone, type) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!type) throw new Error('type requerido');
  if (!isValidPreferenceType(type)) throw new Error('type invalido: ' + type);
  var docId = phone.replace(/\+/g, '').replace(/[^0-9a-z]/gi, '');
  var update = {};
  update[type] = null;
  try {
    await db().collection('tenants').doc(uid).collection('lead_preferences').doc(docId).set(update, { merge: true });
  } catch (e) {
    console.error('[LEAD_PREFS] Error borrando preferencia: ' + e.message);
    throw e;
  }
}

function buildPreferenceContextHint(prefs) {
  if (!prefs || typeof prefs !== 'object') return '';
  var parts = [];
  if (prefs.language) parts.push('Idioma preferido: ' + prefs.language);
  if (prefs.tone) parts.push('Tono preferido: ' + prefs.tone);
  if (prefs.timeSlot) parts.push('Horario preferido: ' + prefs.timeSlot);
  if (prefs.budget) parts.push('Presupuesto aproximado: ' + prefs.budget);
  if (prefs.interest) parts.push('Interes principal: ' + prefs.interest);
  if (prefs.location) parts.push('Ubicacion: ' + prefs.location);
  if (prefs.lastPurchase) parts.push('Ultima compra: ' + prefs.lastPurchase);
  return parts.join('. ');
}

module.exports = {
  isValidPreferenceType,
  savePreference,
  getPreference,
  getAllPreferences,
  deletePreference,
  buildPreferenceContextHint,
  PREFERENCE_TYPES,
  MAX_PREFERENCES_PER_LEAD,
  PREFERENCE_TTL_DAYS,
  __setFirestoreForTests,
};
