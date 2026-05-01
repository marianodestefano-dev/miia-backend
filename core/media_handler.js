'use strict';

/**
 * MIIA — Media Handler (T123)
 * Detecta tipo de media, valida tamano y genera metadatos.
 */

const MIME_TO_TYPE = Object.freeze({
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/ogg': 'audio',
  'audio/wav': 'audio',
  'video/mp4': 'video',
  'video/webm': 'video',
  'application/pdf': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'text/plain': 'document',
});

const MAX_SIZES_BYTES = Object.freeze({
  image: 5 * 1024 * 1024,    // 5 MB
  audio: 16 * 1024 * 1024,   // 16 MB
  video: 64 * 1024 * 1024,   // 64 MB
  document: 10 * 1024 * 1024, // 10 MB
});

const SUPPORTED_MIMES = Object.freeze(Object.keys(MIME_TO_TYPE));

/**
 * Detecta el mediaType a partir del mimeType.
 * @param {string} mimeType
 * @returns {string|null} 'image'|'audio'|'video'|'document'|null
 */
function detectMediaType(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') return null;
  return MIME_TO_TYPE[mimeType.toLowerCase().trim()] || null;
}

/**
 * Valida que el archivo cumpla los requisitos de tamano y tipo.
 * @param {{ mimeType: string, sizeBytes: number }} media
 * @returns {{ valid: boolean, mediaType: string|null, reason?: string }}
 */
function validateMedia(media) {
  if (!media || typeof media !== 'object') {
    return { valid: false, mediaType: null, reason: 'media_required' };
  }
  const { mimeType, sizeBytes } = media;
  const mediaType = detectMediaType(mimeType);
  if (!mediaType) {
    return { valid: false, mediaType: null, reason: `unsupported_mime:${mimeType}` };
  }
  if (typeof sizeBytes !== 'number' || sizeBytes <= 0) {
    return { valid: false, mediaType, reason: 'invalid_size' };
  }
  const maxBytes = MAX_SIZES_BYTES[mediaType];
  if (sizeBytes > maxBytes) {
    return { valid: false, mediaType, reason: `size_exceeded:${sizeBytes}>${maxBytes}` };
  }
  return { valid: true, mediaType };
}

/**
 * Genera metadatos de media para guardar en Firestore.
 * @param {{ mimeType, sizeBytes, filename?, duration? }} media
 * @returns {{ mediaType, mimeType, sizeBytes, filename, duration, createdAt }}
 */
function buildMediaMeta(media) {
  const { mimeType, sizeBytes, filename = null, duration = null } = media || {};
  const mediaType = detectMediaType(mimeType);
  return {
    mediaType,
    mimeType: mimeType || null,
    sizeBytes: sizeBytes || 0,
    filename: filename || null,
    duration: duration || null,
    createdAt: new Date().toISOString(),
  };
}

module.exports = {
  detectMediaType,
  validateMedia,
  buildMediaMeta,
  MIME_TO_TYPE,
  MAX_SIZES_BYTES,
  SUPPORTED_MIMES,
};
