'use strict';

/**
 * MIIA — Training Data CRUD (T105)
 * GET/POST/DELETE del training data del owner.
 * Firestore: users/{uid}/miia_persistent/training_data
 * campo: content (string)
 */

const admin = require('firebase-admin');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || admin.firestore(); }

const MAX_CONTENT_BYTES = 50 * 1024; // 50KB

/**
 * Lee el training data del owner.
 * @param {string} uid
 * @returns {Promise<{ uid, content, updatedAt, sizeBytes }>}
 */
async function getTrainingData(uid) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  const snap = await db().collection('users').doc(uid)
    .collection('miia_persistent').doc('training_data').get();
  if (!snap.exists) return { uid, content: '', updatedAt: null, sizeBytes: 0 };
  const { content = '', updatedAt = null } = snap.data();
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  return { uid, content, updatedAt, sizeBytes };
}

/**
 * Guarda/actualiza el training data del owner.
 * @param {string} uid
 * @param {string} content
 * @returns {Promise<{ uid, sizeBytes, updatedAt }>}
 */
async function setTrainingData(uid, content) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (typeof content !== 'string') throw new Error('content debe ser string');
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  if (sizeBytes > MAX_CONTENT_BYTES) {
    throw new Error(`content excede el limite de ${MAX_CONTENT_BYTES} bytes (recibido: ${sizeBytes})`);
  }
  const updatedAt = new Date().toISOString();
  await db().collection('users').doc(uid)
    .collection('miia_persistent').doc('training_data')
    .set({ content, updatedAt }, { merge: false });
  console.log(`[TRAINING-CRUD] SET uid=${uid.substring(0,8)} sizeBytes=${sizeBytes}`);
  return { uid, sizeBytes, updatedAt };
}

/**
 * Elimina el training data del owner (guarda string vacio para evitar bug 6.1).
 * @param {string} uid
 * @returns {Promise<{ uid, deleted: boolean }>}
 */
async function deleteTrainingData(uid) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  // Per regla 6.1: SIEMPRE guardar en Firestore aunque sea vacio
  await db().collection('users').doc(uid)
    .collection('miia_persistent').doc('training_data')
    .set({ content: '', updatedAt: new Date().toISOString() }, { merge: false });
  console.log(`[TRAINING-CRUD] DELETE (reset to empty) uid=${uid.substring(0,8)}`);
  return { uid, deleted: true };
}

module.exports = { getTrainingData, setTrainingData, deleteTrainingData, MAX_CONTENT_BYTES, __setFirestoreForTests };
