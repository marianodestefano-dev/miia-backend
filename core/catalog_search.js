'use strict';

/**
 * MIIA â€” Catalog Search (T151)
 * Busqueda semantica en catalogo de productos del tenant.
 * Indexa por tokens de nombre, descripcion y categoria.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

const MAX_RESULTS = 20;
const MIN_SCORE = 0.1;

const STOP_WORDS = new Set([
  'el','la','los','las','un','una','unos','unas',
  'de','del','en','a','con','por','para','que','es',
  'the','a','an','of','in','for','with','is','are',
]);

/**
 * Obtiene el catalogo de productos de un tenant.
 * @param {string} uid
 * @returns {Promise<Array<object>>}
 */
async function getCatalogProducts(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('catalog').doc(uid).collection('products')
      .where('active', '==', true).get();
    const products = [];
    snap.forEach(doc => products.push({ id: doc.id, ...doc.data() }));
    return products;
  } catch (e) {
    console.error('[CATALOG] Error leyendo catalogo uid=' + uid.substring(0,8) + ': ' + e.message);
    return [];
  }
}

/**
 * Busca productos en el catalogo por query de lenguaje natural.
 * @param {string} uid
 * @param {string} query
 * @param {object} [opts] - { maxResults, minScore, products }
 * @returns {Promise<Array<{id, name, score, product}>>}
 */
async function searchCatalog(uid, query, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!query || typeof query !== 'string') throw new Error('query requerido');

  const maxResults = (opts && opts.maxResults) || MAX_RESULTS;
  const minScore = (opts && opts.minScore !== undefined) ? opts.minScore : MIN_SCORE;

  // Permitir inyectar productos para tests
  const products = (opts && opts.products) ? opts.products : await getCatalogProducts(uid);
  if (products.length === 0) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const results = [];
  for (const product of products) {
    const score = scoreProduct(product, queryTokens);
    if (score >= minScore) {
      results.push({ id: product.id, name: product.name || '', score, product });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

/**
 * Rankea productos por relevancia a una query.
 * @param {Array<object>} products
 * @param {string} query
 * @returns {Array<{id, name, score, product}>}
 */
function rankByRelevance(products, query) {
  if (!Array.isArray(products)) throw new Error('products debe ser array');
  if (!query || typeof query !== 'string') throw new Error('query requerido');

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const results = products.map(p => ({
    id: p.id || '',
    name: p.name || '',
    score: scoreProduct(p, queryTokens),
    product: p,
  })).filter(r => r.score >= MIN_SCORE);

  results.sort((a, b) => b.score - a.score);
  return results;
}

function scoreProduct(product, queryTokens) {
  const fields = [
    { text: product.name || '', weight: 3 },
    { text: product.category || '', weight: 2 },
    { text: product.description || '', weight: 1 },
    { text: (product.tags || []).join(' '), weight: 2 },
  ];

  let totalScore = 0;
  let totalWeight = 0;

  for (const field of fields) {
    if (!field.text) continue;
    const fieldTokens = tokenize(field.text);
    if (fieldTokens.length === 0) continue;
    const fieldScore = _computeOverlap(queryTokens, fieldTokens);
    totalScore += fieldScore * field.weight;
    totalWeight += field.weight;
  }

  return totalWeight > 0 ? totalScore / totalWeight : 0;
}

function _computeOverlap(queryTokens, fieldTokens) {
  const fieldSet = new Set(fieldTokens);
  let matches = 0;
  for (const token of queryTokens) {
    if (fieldSet.has(token)) matches++;
    else {
      // Partial match: check if any field token starts with this token
      for (const ft of fieldSet) {
        if (ft.startsWith(token) && token.length >= 3) { matches += 0.5; break; }
      }
    }
  }
  return queryTokens.length > 0 ? matches / queryTokens.length : 0;
}

function tokenize(text) {
  return text.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove combining diacritics
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

module.exports = {
  getCatalogProducts, searchCatalog, rankByRelevance,
  tokenize, scoreProduct,
  MAX_RESULTS, MIN_SCORE,
  __setFirestoreForTests,
};
