/**
 * MMC Capa 2 — Episodios (schema + helpers básicos).
 *
 * Origen: CARTA_C-437 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27]
 *   Cita Mariano (chat naranja Wi turno actual):
 *   "Si ambos estan de acuerdo, no requieres preguntarme!!! A"
 *
 * Primera tanda de Piso 1 MMC. Estructural — sin tocar flujo principal
 * MIIA todavía. Wire-in TMH va en C-440.
 *
 * Modelo (subcollection del owner para aislamiento natural §2-quater +
 *  spec 06_AISLAMIENTO_TENANTS):
 *
 *   users/{ownerUid}/miia_memory/{episodeId}
 *     episodeId        string (auto-generado)
 *     ownerUid         string
 *     contactPhone     string (o contactId si group)
 *     startedAt        timestamp
 *     endedAt          timestamp | null  (null si abierto)
 *     messageIds       string[]          (refs a mensajes incluidos)
 *     status           'open' | 'closed' | 'distilled'
 *     topic            string | null     (asignable por destilación C-439)
 *     summary          string | null     (asignable por destilación C-439)
 *     tags             string[]          (asignables futuro)
 *
 * Spec wrapper: .claude/specs/15_PISO_1_MMC_EPISODICA_PRIVACY_REPORT.md
 * Spec técnico detallado MMC v0.3: .claude/specs/13_MMC_DISEÑO_1_MIIA_OWNER.md
 */

'use strict';

const VALID_STATUSES = ['open', 'closed', 'distilled'];

// Inyección perezosa de admin firestore para permitir mocking en tests.
let _firestore = null;
function _getFirestore() {
  if (_firestore) return _firestore;
  const admin = require('firebase-admin');
  _firestore = admin.firestore();
  return _firestore;
}

function __setFirestoreForTests(fs) {
  _firestore = fs;
}

function _episodesCol(ownerUid) {
  return _getFirestore().collection('users').doc(ownerUid).collection('miia_memory');
}

function _validateOwnerUid(ownerUid) {
  if (typeof ownerUid !== 'string' || ownerUid.length < 20 || ownerUid.length > 128) {
    throw new Error('ownerUid invalid (string 20-128 chars required)');
  }
}

function _validateContactPhone(contactPhone) {
  if (typeof contactPhone !== 'string' || contactPhone.trim().length === 0) {
    throw new Error('contactPhone vacío o no string');
  }
}

/**
 * Crea un episodio nuevo en estado 'open'.
 * @param {string} ownerUid
 * @param {string} contactPhone
 * @param {string} firstMessageId
 * @returns {Promise<string>} episodeId generado
 */
async function createEpisode(ownerUid, contactPhone, firstMessageId) {
  _validateOwnerUid(ownerUid);
  _validateContactPhone(contactPhone);
  if (typeof firstMessageId !== 'string' || firstMessageId.length === 0) {
    throw new Error('firstMessageId requerido (string no vacío)');
  }
  const docRef = _episodesCol(ownerUid).doc();
  const episode = {
    episodeId: docRef.id,
    ownerUid,
    contactPhone,
    startedAt: Date.now(),
    endedAt: null,
    messageIds: [firstMessageId],
    status: 'open',
    topic: null,
    summary: null,
    tags: [],
  };
  await docRef.set(episode);
  return docRef.id;
}

/**
 * Agrega un messageId al episodio (append al array).
 * Falla si el episodio no existe o está cerrado.
 * @param {string} ownerUid
 * @param {string} episodeId
 * @param {string} messageId
 * @returns {Promise<void>}
 */
async function addMessageToEpisode(ownerUid, episodeId, messageId) {
  _validateOwnerUid(ownerUid);
  if (typeof messageId !== 'string' || messageId.length === 0) {
    throw new Error('messageId requerido');
  }
  const docRef = _episodesCol(ownerUid).doc(episodeId);
  const snap = await docRef.get();
  if (!snap.exists) throw new Error(`Episode ${episodeId} not found`);
  const data = snap.data();
  if (data.status !== 'open') {
    throw new Error(`Episode ${episodeId} status=${data.status}, cannot add messages`);
  }
  const messageIds = Array.isArray(data.messageIds) ? data.messageIds.slice() : [];
  messageIds.push(messageId);
  await docRef.update({ messageIds });
}

/**
 * Cierra un episodio: setea endedAt + status='closed'.
 * @param {string} ownerUid
 * @param {string} episodeId
 * @param {number} [endedAt] timestamp millis (default Date.now())
 * @returns {Promise<void>}
 */
async function closeEpisode(ownerUid, episodeId, endedAt) {
  _validateOwnerUid(ownerUid);
  const docRef = _episodesCol(ownerUid).doc(episodeId);
  const snap = await docRef.get();
  if (!snap.exists) throw new Error(`Episode ${episodeId} not found`);
  const data = snap.data();
  if (data.status === 'closed' || data.status === 'distilled') {
    throw new Error(`Episode ${episodeId} already ${data.status}`);
  }
  await docRef.update({
    status: 'closed',
    endedAt: typeof endedAt === 'number' ? endedAt : Date.now(),
  });
}

/**
 * Lee un episodio por id.
 * @param {string} ownerUid
 * @param {string} episodeId
 * @returns {Promise<object|null>} doc data o null si no existe
 */
async function getEpisode(ownerUid, episodeId) {
  _validateOwnerUid(ownerUid);
  const snap = await _episodesCol(ownerUid).doc(episodeId).get();
  return snap.exists ? snap.data() : null;
}

/**
 * Lista episodios filtrados.
 * @param {string} ownerUid
 * @param {string} contactPhone
 * @param {object} [opts] { limit?: number, status?: 'open'|'closed'|'distilled' }
 * @returns {Promise<object[]>} array episodios ordenados desc por startedAt
 */
async function listEpisodes(ownerUid, contactPhone, opts) {
  _validateOwnerUid(ownerUid);
  _validateContactPhone(contactPhone);
  const o = opts || {};
  let q = _episodesCol(ownerUid).where('contactPhone', '==', contactPhone);
  if (o.status) {
    if (!VALID_STATUSES.includes(o.status)) {
      throw new Error(`status invalid: ${o.status}`);
    }
    q = q.where('status', '==', o.status);
  }
  q = q.orderBy('startedAt', 'desc');
  if (typeof o.limit === 'number' && o.limit > 0) {
    q = q.limit(o.limit);
  }
  const snap = await q.get();
  return snap.docs.map((d) => d.data());
}

module.exports = {
  createEpisode,
  addMessageToEpisode,
  closeEpisode,
  getEpisode,
  listEpisodes,
  // Internals para tests
  __setFirestoreForTests,
  VALID_STATUSES,
};
