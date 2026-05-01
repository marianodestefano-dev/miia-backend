'use strict';

/**
 * MIIA â€” Catalog Recommender (T153)
 * Sugiere productos al lead segun historial de interacciones y preferencias.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

const MAX_RECOMMENDATIONS = 5;
const HISTORY_LIMIT = 20; // ultimas N interacciones

/**
 * Obtiene el historial de productos vistos/consultados por un lead.
 * @param {string} uid - owner uid
 * @param {string} phone - lead phone
 * @returns {Promise<Array<{productId, category, timestamp}>>}
 */
async function getLeadHistory(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    const snap = await db().collection('catalog_history').doc(uid).collection('leads').doc(phone).get();
    if (!snap.exists) return [];
    const data = snap.data();
    return (data.interactions || []).slice(-HISTORY_LIMIT);
  } catch (e) {
    console.error('[RECOMMENDER] Error leyendo historial uid=' + uid.substring(0,8) + ' phone=' + phone.substring(0,6) + ': ' + e.message);
    return [];
  }
}

/**
 * Registra una interaccion del lead con un producto.
 * @param {string} uid
 * @param {string} phone
 * @param {object} interaction - { productId, category, action }
 */
async function recordInteraction(uid, phone, interaction) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!interaction || !interaction.productId) throw new Error('interaction.productId requerido');

  const entry = {
    productId: interaction.productId,
    category: interaction.category || null,
    action: interaction.action || 'view',
    timestamp: new Date().toISOString(),
  };

  try {
    const admin = require('firebase-admin');
    await db().collection('catalog_history').doc(uid).collection('leads').doc(phone).set(
      { interactions: admin.firestore.FieldValue.arrayUnion(entry) },
      { merge: true }
    );
  } catch (e) {
    console.error('[RECOMMENDER] Error guardando interaccion: ' + e.message);
    throw e;
  }
}

/**
 * Genera recomendaciones de productos para un lead basadas en su historial.
 * @param {string} uid
 * @param {string} phone
 * @param {Array<object>} catalogProducts - productos disponibles
 * @param {object} [opts] - { maxResults, history }
 * @returns {Promise<Array<{product, score, reason}>>}
 */
async function getRecommendations(uid, phone, catalogProducts, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!Array.isArray(catalogProducts)) throw new Error('catalogProducts debe ser array');

  const maxResults = (opts && opts.maxResults) || MAX_RECOMMENDATIONS;
  const history = (opts && opts.history) ? opts.history : await getLeadHistory(uid, phone);

  if (catalogProducts.length === 0) return [];

  // Construir perfil del lead
  const profile = _buildProfile(history);

  // Puntuar productos
  const scored = [];
  for (const product of catalogProducts) {
    const { score, reason } = _scoreForLead(product, profile, history);
    if (score > 0) scored.push({ product, score, reason });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

function _buildProfile(history) {
  const categoryCounts = {};
  const viewedProducts = new Set();
  const purchasedProducts = new Set();

  for (const item of history) {
    viewedProducts.add(item.productId);
    if (item.action === 'purchase') purchasedProducts.add(item.productId);
    if (item.category) {
      categoryCounts[item.category] = (categoryCounts[item.category] || 0) +
        (item.action === 'purchase' ? 3 : item.action === 'inquiry' ? 2 : 1);
    }
  }

  return { categoryCounts, viewedProducts, purchasedProducts };
}

function _scoreForLead(product, profile, history) {
  let score = 0;
  let reason = '';

  const pid = product.id || '';
  const pcat = (product.category || '').toLowerCase();

  // Ya comprado: no recomendar de nuevo
  if (profile.purchasedProducts.has(pid)) return { score: 0, reason: '' };

  // Ya visto muchas veces: penalizar
  const viewCount = history.filter(h => h.productId === pid).length;
  if (viewCount >= 3) return { score: 0, reason: '' };

  // Score por categoria preferida
  const catScore = profile.categoryCounts[pcat] || 0;
  if (catScore > 0) {
    score += Math.min(catScore * 0.2, 1.0);
    reason = 'categoria de interes';
  }

  // Score base si tiene precio accesible (si hay historial de productos baratos)
  const avgHistoryPrice = _avgPrice(history.map(h => h.price).filter(Boolean));
  if (avgHistoryPrice && product.price && product.price <= avgHistoryPrice * 1.3) {
    score += 0.2;
    if (!reason) reason = 'precio similar a tu historial';
  }

  // Producto popular (score base si nunca fue visto)
  if (viewCount === 0 && score === 0) {
    score = 0.1;
    reason = 'novedades';
  }

  return { score, reason };
}

function _avgPrice(prices) {
  if (!prices || prices.length === 0) return 0;
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

module.exports = {
  getLeadHistory, recordInteraction, getRecommendations,
  MAX_RECOMMENDATIONS, HISTORY_LIMIT,
  __setFirestoreForTests,
  _buildProfile, _scoreForLead,
};
