'use strict';

/**
 * MIIA - Media Handler (T240)
 * P3.2 ROADMAP: manejo de media (imagenes, documentos, audios) en conversaciones.
 * Descarga, valida y referencia media de WhatsApp para el catalogo y memorias.
 */

const SUPPORTED_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const SUPPORTED_DOCUMENT_TYPES = Object.freeze([
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);
const SUPPORTED_AUDIO_TYPES = Object.freeze(['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav']);

const MEDIA_CATEGORIES = Object.freeze(['image', 'document', 'audio', 'sticker', 'video']);

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_SIZE_BYTES = 16 * 1024 * 1024;
const MEDIA_STORAGE_COLLECTION = 'media_refs';
const DEFAULT_EXPIRY_HOURS = 24;

function isValidImageType(mimeType) {
  return SUPPORTED_IMAGE_TYPES.includes(mimeType);
}

function isValidDocumentType(mimeType) {
  return SUPPORTED_DOCUMENT_TYPES.includes(mimeType);
}

function isValidAudioType(mimeType) {
  return SUPPORTED_AUDIO_TYPES.includes(mimeType);
}

function getMediaCategory(mimeType) {
  if (!mimeType) return null;
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf' || mimeType.includes('word') || mimeType === 'text/plain') return 'document';
  return null;
}

function validateMediaMessage(mediaMsg) {
  if (!mediaMsg) throw new Error('mediaMsg requerido');
  if (!mediaMsg.mimeType) throw new Error('mimeType requerido');
  var category = getMediaCategory(mediaMsg.mimeType);
  if (!category) throw new Error('mimeType no soportado: ' + mediaMsg.mimeType);
  var sizeBytes = mediaMsg.sizeBytes || 0;
  if (category === 'image' && sizeBytes > MAX_IMAGE_SIZE_BYTES) {
    throw new Error('imagen demasiado grande: max ' + (MAX_IMAGE_SIZE_BYTES / 1024 / 1024) + 'MB');
  }
  if (category === 'document' && sizeBytes > MAX_DOCUMENT_SIZE_BYTES) {
    throw new Error('documento demasiado grande: max ' + (MAX_DOCUMENT_SIZE_BYTES / 1024 / 1024) + 'MB');
  }
  if (category === 'audio' && sizeBytes > MAX_AUDIO_SIZE_BYTES) {
    throw new Error('audio demasiado grande: max ' + (MAX_AUDIO_SIZE_BYTES / 1024 / 1024) + 'MB');
  }
  return { category, mimeType: mediaMsg.mimeType, sizeBytes };
}

function buildMediaRef(uid, phone, mediaMsg, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  var validation = validateMediaMessage(mediaMsg);
  var refId = 'media_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  var expiryHours = (opts && opts.expiryHours) ? opts.expiryHours : DEFAULT_EXPIRY_HOURS;
  return {
    refId,
    uid,
    phone,
    category: validation.category,
    mimeType: validation.mimeType,
    sizeBytes: validation.sizeBytes,
    fileName: mediaMsg.fileName || null,
    caption: mediaMsg.caption || null,
    messageId: mediaMsg.messageId || null,
    downloadUrl: mediaMsg.downloadUrl || null,
    storagePath: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString(),
    processed: false,
    context: (opts && opts.context) || 'conversation',
  };
}

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

async function saveMediaRef(uid, mediaRef) {
  if (!uid) throw new Error('uid requerido');
  if (!mediaRef || !mediaRef.refId) throw new Error('mediaRef invalido');
  await db().collection('tenants').doc(uid).collection(MEDIA_STORAGE_COLLECTION).doc(mediaRef.refId).set(mediaRef);
  console.log('[MEDIA] Guardado ref uid=' + uid + ' refId=' + mediaRef.refId + ' category=' + mediaRef.category);
  return mediaRef.refId;
}

async function getMediaRef(uid, refId) {
  if (!uid) throw new Error('uid requerido');
  if (!refId) throw new Error('refId requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection(MEDIA_STORAGE_COLLECTION).doc(refId).get();
    if (!snap || !snap.exists) return null;
    return snap.data();
  } catch (e) {
    console.error('[MEDIA] Error leyendo ref: ' + e.message);
    return null;
  }
}

async function markMediaProcessed(uid, refId, storagePath) {
  if (!uid) throw new Error('uid requerido');
  if (!refId) throw new Error('refId requerido');
  await db().collection('tenants').doc(uid).collection(MEDIA_STORAGE_COLLECTION).doc(refId).set({
    processed: true,
    storagePath: storagePath || null,
    processedAt: new Date().toISOString(),
  }, { merge: true });
  console.log('[MEDIA] Marcado procesado uid=' + uid + ' refId=' + refId);
}

async function getMediaRefsByPhone(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection(MEDIA_STORAGE_COLLECTION)
      .where('phone', '==', phone).get();
    var refs = [];
    snap.forEach(function(doc) { refs.push(doc.data()); });
    return refs;
  } catch (e) {
    console.error('[MEDIA] Error leyendo refs por phone: ' + e.message);
    return [];
  }
}

async function deleteExpiredMediaRefs(uid, nowMs) {
  if (!uid) throw new Error('uid requerido');
  var now = nowMs || Date.now();
  try {
    var snap = await db().collection('tenants').doc(uid).collection(MEDIA_STORAGE_COLLECTION).get();
    var deleted = 0;
    var promises = [];
    snap.forEach(function(doc) {
      var data = doc.data();
      if (data.expiresAt && new Date(data.expiresAt).getTime() < now) {
        promises.push(doc.ref.delete());
        deleted++;
      }
    });
    await Promise.all(promises);
    console.log('[MEDIA] Limpiados ' + deleted + ' refs expirados uid=' + uid);
    return deleted;
  } catch (e) {
    console.error('[MEDIA] Error limpiando expirados: ' + e.message);
    return 0;
  }
}

function isMediaExpired(mediaRef, nowMs) {
  if (!mediaRef || !mediaRef.expiresAt) return false;
  var now = nowMs || Date.now();
  return new Date(mediaRef.expiresAt).getTime() < now;
}

function buildMediaContextText(mediaRef) {
  if (!mediaRef) return '';
  var lines = ['[El contacto envio un archivo de tipo: ' + mediaRef.category + ']'];
  if (mediaRef.fileName) lines.push('Nombre: ' + mediaRef.fileName);
  if (mediaRef.caption) lines.push('Caption: ' + mediaRef.caption);
  if (mediaRef.sizeBytes) lines.push('Tamaño: ' + Math.round(mediaRef.sizeBytes / 1024) + 'KB');
  return lines.join('\n');
}

module.exports = {
  validateMediaMessage,
  buildMediaRef,
  saveMediaRef,
  getMediaRef,
  markMediaProcessed,
  getMediaRefsByPhone,
  deleteExpiredMediaRefs,
  isMediaExpired,
  buildMediaContextText,
  getMediaCategory,
  isValidImageType,
  isValidDocumentType,
  isValidAudioType,
  SUPPORTED_IMAGE_TYPES,
  SUPPORTED_DOCUMENT_TYPES,
  SUPPORTED_AUDIO_TYPES,
  MEDIA_CATEGORIES,
  MAX_IMAGE_SIZE_BYTES,
  MAX_DOCUMENT_SIZE_BYTES,
  MAX_AUDIO_SIZE_BYTES,
  DEFAULT_EXPIRY_HOURS,
  MEDIA_STORAGE_COLLECTION,
  __setFirestoreForTests,
};
