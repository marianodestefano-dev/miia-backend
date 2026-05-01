'use strict';

/**
 * MIIA — Review Requester (T193)
 * Flujo de solicitud de resenas a clientes satisfechos.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const REQUEST_STATES = Object.freeze(['pending', 'sent', 'responded', 'declined', 'expired']);
const MIN_SCORE_FOR_REQUEST = 30;
const COOLDOWN_DAYS = 90;
const MAX_REQUESTS_PER_OWNER_PER_DAY = 20;
const REQUEST_EXPIRY_DAYS = 7;

const DEFAULT_MESSAGES = Object.freeze({
  es: 'Hola! Nos alegra saber que tuviste una buena experiencia. Si tenes un momento, nos ayudaria mucho que dejes tu opinion. Gracias!',
  en: 'Hi! We are glad you had a great experience. If you have a moment, a review would mean a lot to us. Thank you!',
});

function buildReviewRequestMessage(language, customMessage) {
  if (customMessage && typeof customMessage === 'string' && customMessage.trim().length > 0) {
    return customMessage.trim();
  }
  return DEFAULT_MESSAGES[language] || DEFAULT_MESSAGES.es;
}

async function shouldRequestReview(uid, phone, score) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (typeof score !== 'number') throw new Error('score debe ser numero');
  if (score < MIN_SCORE_FOR_REQUEST) return { should: false, reason: 'score_too_low' };

  try {
    const snap = await db().collection('review_requests').doc(uid).collection('by_phone').doc(phone.replace('+', '')).get();
    if (snap.exists) {
      const data = snap.data();
      const lastSentAt = data.lastSentAt ? new Date(data.lastSentAt).getTime() : 0;
      const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
      if (Date.now() - lastSentAt < cooldownMs) {
        return { should: false, reason: 'in_cooldown' };
      }
    }
    return { should: true, reason: 'eligible' };
  } catch (e) {
    console.error('[REVIEW_REQUESTER] Error leyendo cooldown uid=' + uid.substring(0, 8) + ': ' + e.message);
    return { should: false, reason: 'error' };
  }
}

async function scheduleReviewRequest(uid, phone, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  opts = opts || {};
  const language = opts.language || 'es';
  const customMessage = opts.customMessage || null;
  const message = buildReviewRequestMessage(language, customMessage);
  const docId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + REQUEST_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const data = {
    uid, phone, message, language,
    state: 'pending',
    requestId: docId,
    scheduledAt: now,
    sentAt: null,
    respondedAt: null,
    expiresAt,
  };
  try {
    await db().collection('review_requests').doc(uid).collection('pending').doc(docId).set(data);
    await db().collection('review_requests').doc(uid).collection('by_phone').doc(phone.replace('+', '')).set({ lastSentAt: now }, { merge: true });
    console.log('[REVIEW_REQUESTER] Solicitud programada uid=' + uid.substring(0, 8) + ' phone=' + phone);
    return { requestId: docId, message, scheduledAt: now };
  } catch (e) {
    console.error('[REVIEW_REQUESTER] Error guardando solicitud uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  }
}

async function markRequestSent(uid, requestId) {
  if (!uid) throw new Error('uid requerido');
  if (!requestId) throw new Error('requestId requerido');
  try {
    await db().collection('review_requests').doc(uid).collection('pending').doc(requestId).set(
      { state: 'sent', sentAt: new Date().toISOString() },
      { merge: true }
    );
  } catch (e) {
    console.error('[REVIEW_REQUESTER] Error marcando enviado: ' + e.message);
    throw e;
  }
}

async function recordResponse(uid, requestId, responded) {
  if (!uid) throw new Error('uid requerido');
  if (!requestId) throw new Error('requestId requerido');
  const state = responded ? 'responded' : 'declined';
  try {
    await db().collection('review_requests').doc(uid).collection('pending').doc(requestId).set(
      { state, respondedAt: new Date().toISOString() },
      { merge: true }
    );
    return { state };
  } catch (e) {
    console.error('[REVIEW_REQUESTER] Error guardando respuesta: ' + e.message);
    throw e;
  }
}

async function getPendingRequests(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('review_requests').doc(uid).collection('pending')
      .where('state', '==', 'pending').get();
    const results = [];
    snap.forEach(doc => results.push(doc.data()));
    return results;
  } catch (e) {
    console.error('[REVIEW_REQUESTER] Error leyendo pendientes: ' + e.message);
    return [];
  }
}

module.exports = {
  buildReviewRequestMessage,
  shouldRequestReview,
  scheduleReviewRequest,
  markRequestSent,
  recordResponse,
  getPendingRequests,
  REQUEST_STATES,
  DEFAULT_MESSAGES,
  MIN_SCORE_FOR_REQUEST,
  COOLDOWN_DAYS,
  REQUEST_EXPIRY_DAYS,
  __setFirestoreForTests,
};
