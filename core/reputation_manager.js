'use strict';

/**
 * MIIA - Reputation Manager (T185)
 * Manejo de reviews y reputacion del negocio.
 * Solicita, almacena y agrega reviews de clientes.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const REVIEW_SOURCES = Object.freeze(['whatsapp', 'google', 'facebook', 'manual']);
const MIN_RATING = 1;
const MAX_RATING = 5;
const DEFAULT_REQUEST_MESSAGE_ES = 'Gracias por tu visita! Te invitamos a dejar tu opinion. Del 1 al 5, cuanto valoras tu experiencia?';
const DEFAULT_REQUEST_MESSAGE_EN = 'Thank you for your visit! We invite you to share your feedback. From 1 to 5, how do you rate your experience?';
const MAX_REVIEW_LENGTH = 1000;


/**
 * Guarda una review de un cliente.
 * @param {string} uid
 * @param {object} review - {phone, rating, text, source}
 * @returns {Promise<{reviewId}>}
 */
async function saveReview(uid, review) {
  if (!uid) throw new Error('uid requerido');
  if (!review || typeof review !== 'object') throw new Error('review requerido');
  if (!review.phone) throw new Error('review.phone requerido');
  if (typeof review.rating !== 'number') throw new Error('review.rating debe ser numero');
  if (review.rating < MIN_RATING || review.rating > MAX_RATING) {
    throw new Error('review.rating debe estar entre ' + MIN_RATING + ' y ' + MAX_RATING);
  }

  const source = review.source && REVIEW_SOURCES.includes(review.source) ? review.source : 'whatsapp';
  const text = review.text && typeof review.text === 'string'
    ? review.text.slice(0, MAX_REVIEW_LENGTH)
    : '';

  const reviewId = uid.substring(0, 8) + '_' + review.phone.slice(-8) + '_' + Date.now();
  const doc = {
    uid, reviewId,
    phone: review.phone,
    rating: review.rating,
    text,
    source,
    reviewedAt: new Date().toISOString(),
  };

  try {
    await db()
      .collection('reviews').doc(uid)
      .collection('all').doc(reviewId)
      .set(doc);
    console.log('[REP] review guardada uid=' + uid.substring(0, 8) + ' rating=' + review.rating);
    return { reviewId };
  } catch (e) {
    console.error('[REP] Error guardando review: ' + e.message);
    throw e;
  }
}

/**
 * Obtiene el resumen de reputacion del owner.
 * @param {string} uid
 * @returns {Promise<{totalReviews, averageRating, distribution, trend}>}
 */
async function getReputationSummary(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db()
      .collection('reviews').doc(uid)
      .collection('all').get();

    const ratings = [];
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    snap.forEach(doc => {
      const d = doc.data();
      if (typeof d.rating === 'number' && d.rating >= 1 && d.rating <= 5) {
        ratings.push(d.rating);
        distribution[d.rating]++;
      }
    });

    const totalReviews = ratings.length;
    const averageRating = totalReviews > 0
      ? Math.round((ratings.reduce((s, r) => s + r, 0) / totalReviews) * 10) / 10
      : 0;

    const positive = (distribution[4] + distribution[5]);
    const negative = (distribution[1] + distribution[2]);
    const trend = totalReviews === 0 ? 'neutral'
      : positive > negative ? 'positive'
      : negative > positive ? 'negative'
      : 'neutral';

    return { totalReviews, averageRating, distribution, trend };
  } catch (e) {
    console.error('[REP] Error leyendo reputacion uid=' + uid.substring(0, 8) + ': ' + e.message);
    return { totalReviews: 0, averageRating: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, trend: 'neutral' };
  }
}

/**
 * Obtiene las reviews recientes del owner.
 * @param {string} uid
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
async function getRecentReviews(uid, limit) {
  if (!uid) throw new Error('uid requerido');
  const maxItems = typeof limit === 'number' && limit > 0 ? Math.min(limit, 100) : 20;

  try {
    const snap = await db()
      .collection('reviews').doc(uid)
      .collection('all').get();

    const reviews = [];
    snap.forEach(doc => reviews.push({ id: doc.id, ...doc.data() }));

    return reviews
      .sort((a, b) => new Date(b.reviewedAt || 0).getTime() - new Date(a.reviewedAt || 0).getTime())
      .slice(0, maxItems);
  } catch (e) {
    console.error('[REP] Error leyendo reviews recientes: ' + e.message);
    return [];
  }
}

/**
 * Genera el mensaje de solicitud de review.
 * @param {string} [language]
 * @param {string} [customMessage]
 * @returns {string}
 */
function buildReviewRequestMessage(language, customMessage) {
  if (customMessage && typeof customMessage === 'string') return customMessage;
  return language === 'en' ? DEFAULT_REQUEST_MESSAGE_EN : DEFAULT_REQUEST_MESSAGE_ES;
}

/**
 * Parsea una respuesta de rating del lead (texto libre).
 * Busca el primer numero del 1 al 5.
 * @param {string} text
 * @returns {number|null}
 */
function parseRatingFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/[1-5]/);
  if (!match) return null;
  const n = parseInt(match[0], 10);
  return n >= MIN_RATING && n <= MAX_RATING ? n : null;
}

module.exports = {
  saveReview, getReputationSummary, getRecentReviews,
  buildReviewRequestMessage, parseRatingFromText,
  REVIEW_SOURCES, MIN_RATING, MAX_RATING, MAX_REVIEW_LENGTH,
  DEFAULT_REQUEST_MESSAGE_ES, DEFAULT_REQUEST_MESSAGE_EN,
  __setFirestoreForTests,
};
