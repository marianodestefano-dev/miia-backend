'use strict';

/**
 * MMC.1 — Memoria episodica por contacto
 * Coleccion: owners/{uid}/episodic_memory/{contact_phone}
 * Schema: { last_interaction, interaction_count, key_facts, sentiment_history, tags }
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

const SCHEMA_VERSION = 1;
const MAX_KEY_FACTS = 20;

function _col(uid) {
  return db().collection('owners').doc(uid).collection('episodic_memory');
}

/**
 * Crea el doc de memoria episodica para un contacto si no existe.
 * Idempotente — si ya existe retorna los datos actuales.
 * @param {string} uid
 * @param {string} phone - telefono del contacto (docId)
 * @returns {Promise<Object>} datos del doc
 */
async function initEpisodicMemory(uid, phone) {
  if (!uid || !phone) throw new Error('uid y phone requeridos');
  const docRef = _col(uid).doc(phone);
  const doc = await docRef.get();
  if (doc.exists) return doc.data();
  const data = {
    uid,
    contact_phone: phone,
    last_interaction: null,
    interaction_count: 0,
    key_facts: [],
    sentiment_history: [],
    tags: [],
    schema_version: SCHEMA_VERSION,
    created_at: new Date().toISOString(),
  };
  await docRef.set(data);
  return data;
}

/**
 * Agrega hechos clave (max MAX_KEY_FACTS en total, elimina los mas viejos).
 * @param {string} uid
 * @param {string} phone
 * @param {Array<{fact: string, confidence: 'high'|'medium'}>} facts
 */
async function appendKeyFacts(uid, phone, facts) {
  if (!uid || !phone || !Array.isArray(facts) || facts.length === 0) return false;
  const docRef = _col(uid).doc(phone);
  const doc = await docRef.get();
  const existing = doc.exists ? (doc.data().key_facts || []) : [];
  const stamped = facts.map(function(f) {
    return { fact: f.fact, confidence: f.confidence, learned_at: new Date().toISOString() };
  });
  const combined = existing.concat(stamped);
  const trimmed = combined.slice(-MAX_KEY_FACTS);
  await docRef.set({ key_facts: trimmed, last_interaction: new Date().toISOString() }, { merge: true });
  return true;
}

/**
 * Obtiene la memoria episodica de un contacto.
 */
async function getEpisodicMemory(uid, phone) {
  if (!uid || !phone) return null;
  const doc = await _col(uid).doc(phone).get();
  return doc.exists ? doc.data() : null;
}

/**
 * Elimina toda la memoria episodica de un contacto.
 */
async function deleteEpisodicMemory(uid, phone) {
  if (!uid || !phone) return false;
  await _col(uid).doc(phone).delete();
  return true;
}

module.exports = {
  initEpisodicMemory,
  appendKeyFacts,
  getEpisodicMemory,
  deleteEpisodicMemory,
  SCHEMA_VERSION,
  MAX_KEY_FACTS,
  __setFirestoreForTests,
};
