'use strict';

/**
 * MIIA — Contact Enrichment (T112)
 * Enriquece datos de un contacto con metadata adicional.
 * Lee y escribe en users/{uid}/contacts/{phone}/enrichment
 */

const admin = require('firebase-admin');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || admin.firestore(); }

const ALLOWED_FIELDS = Object.freeze(['name','email','company','notes','tags','customData']);

/**
 * Lee enriquecimiento de un contacto.
 */
async function getEnrichment(uid, phone) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!phone || typeof phone !== 'string') throw new Error('phone requerido');
  try {
    const snap = await db().collection('users').doc(uid)
      .collection('contacts').doc(phone).get();
    if (!snap.exists) return { uid, phone, enrichment: null };
    const data = snap.data();
    return { uid, phone, enrichment: data.enrichment || null };
  } catch (e) {
    console.warn(`[ENRICHMENT] getEnrichment error: ${e.message}`);
    return { uid, phone, enrichment: null, error: e.message };
  }
}

/**
 * Guarda o actualiza enriquecimiento de un contacto.
 * Solo permite campos de ALLOWED_FIELDS.
 */
async function setEnrichment(uid, phone, fields) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!phone || typeof phone !== 'string') throw new Error('phone requerido');
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('fields debe ser objeto');

  const sanitized = {};
  const invalid = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.includes(k)) { invalid.push(k); continue; }
    sanitized[k] = v;
  }
  if (invalid.length > 0) throw new Error(`Campos no permitidos: ${invalid.join(', ')}`);
  if (Object.keys(sanitized).length === 0) throw new Error('No hay campos válidos para guardar');

  const updatedAt = new Date().toISOString();
  await db().collection('users').doc(uid).collection('contacts').doc(phone)
    .set({ enrichment: { ...sanitized, updatedAt } }, { merge: true });
  console.log(`[ENRICHMENT] uid=${uid.substring(0,8)} phone=${phone} fields=${Object.keys(sanitized).join(',')}`);
  return { uid, phone, updatedFields: Object.keys(sanitized), updatedAt };
}

/**
 * Elimina el enriquecimiento de un contacto.
 */
async function deleteEnrichment(uid, phone) {
  if (!uid || !phone) throw new Error('uid y phone requeridos');
  await db().collection('users').doc(uid).collection('contacts').doc(phone)
    .set({ enrichment: null }, { merge: true });
  console.log(`[ENRICHMENT] DELETE uid=${uid.substring(0,8)} phone=${phone}`);
  return { uid, phone, deleted: true };
}

module.exports = { getEnrichment, setEnrichment, deleteEnrichment, ALLOWED_FIELDS, __setFirestoreForTests };
