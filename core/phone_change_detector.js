'use strict';

/**
 * MIIA - Phone Change Detector (T206)
 * Detecta cuando un lead cambio de numero de telefono.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const CHANGE_REASONS = Object.freeze(['self_reported', 'carrier_port', 'new_device', 'detected_mismatch', 'owner_manual']);
const MAX_LINKED_NUMBERS = 5;

function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  var cleaned = phone.replace(/[^\d+]/g, '');
  if (!cleaned.startsWith('+')) cleaned = '+' + cleaned;
  if (!/^\+\d{8,15}$/.test(cleaned)) return null;
  return cleaned;
}

function isSamePhone(phoneA, phoneB) {
  var a = normalizePhone(phoneA);
  var b = normalizePhone(phoneB);
  if (!a || !b) return false;
  if (a === b) return true;
  var suffixA = a.replace('+', '').slice(-10);
  var suffixB = b.replace('+', '').slice(-10);
  return suffixA === suffixB;
}

async function recordPhoneChange(uid, oldPhone, newPhone, reason, leadId) {
  if (!uid) throw new Error('uid requerido');
  if (!oldPhone) throw new Error('oldPhone requerido');
  if (!newPhone) throw new Error('newPhone requerido');
  if (!reason || !CHANGE_REASONS.includes(reason)) throw new Error('reason invalido');
  if (isSamePhone(oldPhone, newPhone)) throw new Error('oldPhone y newPhone son el mismo numero');
  var docId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  var data = {
    uid, oldPhone, newPhone, reason,
    leadId: leadId || null,
    recordedAt: new Date().toISOString(),
  };
  try {
    await db().collection('phone_changes').doc(uid).collection('history').doc(docId).set(data);
    await db().collection('tenants').doc(uid).collection('phone_links').doc(newPhone.replace('+', '')).set(
      { uid, phone: newPhone, linkedPhones: [oldPhone], updatedAt: new Date().toISOString() },
      { merge: true }
    );
    console.log('[PHONE_CHANGE] uid=' + uid.substring(0, 8) + ' old=' + oldPhone + ' new=' + newPhone);
    return { docId, oldPhone, newPhone, reason };
  } catch (e) {
    console.error('[PHONE_CHANGE] Error guardando cambio: ' + e.message);
    throw e;
  }
}

async function getPhoneHistory(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    var snap = await db().collection('phone_changes').doc(uid).collection('history')
      .where('oldPhone', '==', phone).get();
    var results = [];
    snap.forEach(function(doc) { results.push(doc.data()); });
    return results.sort(function(a, b) { return new Date(b.recordedAt) - new Date(a.recordedAt); });
  } catch (e) {
    console.error('[PHONE_CHANGE] Error leyendo historial: ' + e.message);
    return [];
  }
}

async function getCurrentPhone(uid, originalPhone) {
  if (!uid) throw new Error('uid requerido');
  if (!originalPhone) throw new Error('originalPhone requerido');
  try {
    var snap = await db().collection('phone_changes').doc(uid).collection('history')
      .where('oldPhone', '==', originalPhone).get();
    var changes = [];
    snap.forEach(function(doc) { changes.push(doc.data()); });
    if (changes.length === 0) return { currentPhone: originalPhone, changed: false };
    changes.sort(function(a, b) { return new Date(b.recordedAt) - new Date(a.recordedAt); });
    return { currentPhone: changes[0].newPhone, changed: true, changedAt: changes[0].recordedAt };
  } catch (e) {
    console.error('[PHONE_CHANGE] Error buscando numero actual: ' + e.message);
    return { currentPhone: originalPhone, changed: false };
  }
}

module.exports = {
  normalizePhone,
  isSamePhone,
  recordPhoneChange,
  getPhoneHistory,
  getCurrentPhone,
  CHANGE_REASONS,
  MAX_LINKED_NUMBERS,
  __setFirestoreForTests,
};