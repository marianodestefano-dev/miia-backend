'use strict';

/**
 * MIIA - E-commerce Connector (T183)
 * Conecta MIIA con tiendas WooCommerce y Shopify.
 * Permite sincronizar catalogo y consultar ordenes.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

let _httpClient = null;
function __setHttpClientForTests(fn) { _httpClient = fn; }

const SUPPORTED_PLATFORMS = Object.freeze(['woocommerce', 'shopify', 'tiendanube']);
const ORDER_STATUSES = Object.freeze(['pending', 'processing', 'completed', 'cancelled', 'refunded', 'on-hold']);
const MAX_PRODUCTS_SYNC = 500;
const SYNC_INTERVAL_HOURS = 6;

SYNC_INTERVAL_HOURS;


/**
 * Guarda la configuracion de conexion de la tienda.
 * @param {string} uid
 * @param {object} config - {platform, storeUrl, apiKey, apiSecret}
 */
async function saveStoreConfig(uid, config) {
  if (!uid) throw new Error('uid requerido');
  if (!config || typeof config !== 'object') throw new Error('config requerido');
  if (!config.platform) throw new Error('config.platform requerido');
  if (!SUPPORTED_PLATFORMS.includes(config.platform)) {
    throw new Error('plataforma no soportada: ' + config.platform);
  }
  if (!config.storeUrl || typeof config.storeUrl !== 'string') throw new Error('config.storeUrl requerido');
  if (!config.apiKey) throw new Error('config.apiKey requerido');

  const doc = {
    uid,
    platform: config.platform,
    storeUrl: config.storeUrl.replace(/\/$/, ''),
    apiKey: config.apiKey,
    apiSecret: config.apiSecret || null,
    active: true,
    savedAt: new Date().toISOString(),
  };

  try {
    await db().collection('store_configs').doc(uid).set(doc);
    console.log('[ECOM] config guardada uid=' + uid.substring(0, 8) + ' platform=' + config.platform);
  } catch (e) {
    console.error('[ECOM] Error guardando config: ' + e.message);
    throw e;
  }
}

/**
 * Lee la configuracion de conexion del owner.
 * @param {string} uid
 * @returns {Promise<object|null>}
 */
async function getStoreConfig(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('store_configs').doc(uid).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (e) {
    console.error('[ECOM] Error leyendo config: ' + e.message);
    return null;
  }
}

/**
 * Normaliza un producto de WooCommerce al formato MIIA.
 * @param {object} product
 * @returns {object}
 */
function normalizeWooProduct(product) {
  return {
    id: String(product.id),
    name: product.name || '',
    description: product.short_description || product.description || '',
    price: parseFloat(product.price || 0),
    regularPrice: parseFloat(product.regular_price || 0),
    salePrice: product.sale_price ? parseFloat(product.sale_price) : null,
    sku: product.sku || '',
    stock: product.stock_quantity !== undefined ? product.stock_quantity : null,
    inStock: product.in_stock !== false,
    categories: (product.categories || []).map(c => c.name),
    images: (product.images || []).map(img => img.src),
    platform: 'woocommerce',
    sourceId: String(product.id),
  };
}

/**
 * Normaliza un producto de Shopify al formato MIIA.
 * @param {object} product
 * @returns {object}
 */
function normalizeShopifyProduct(product) {
  const variant = (product.variants && product.variants[0]) || {};
  return {
    id: String(product.id),
    name: product.title || '',
    description: product.body_html ? product.body_html.replace(/<[^>]*>/g, '') : '',
    price: parseFloat(variant.price || 0),
    regularPrice: parseFloat(variant.compare_at_price || variant.price || 0),
    salePrice: null,
    sku: variant.sku || '',
    stock: variant.inventory_quantity !== undefined ? variant.inventory_quantity : null,
    inStock: variant.inventory_policy !== 'deny' || (variant.inventory_quantity || 0) > 0,
    categories: (product.product_type ? [product.product_type] : []),
    images: (product.images || []).map(img => img.src),
    platform: 'shopify',
    sourceId: String(product.id),
  };
}


/**
 * Sincroniza el catalogo desde la tienda al formato MIIA.
 * @param {string} uid
 * @param {object} [configOverride] - config opcional (usa la guardada si no se provee)
 * @returns {Promise<{synced, products, platform}>}
 */
async function syncCatalog(uid, configOverride) {
  if (!uid) throw new Error('uid requerido');

  const config = configOverride || await getStoreConfig(uid);
  if (!config) throw new Error('configuracion de tienda no encontrada para uid=' + uid.substring(0, 8));

  const caller = _httpClient || _defaultFetch;

  let rawProducts = [];
  let timer;
  try {
    const abortCtrl = new AbortController();
    timer = setTimeout(() => abortCtrl.abort(), 20000);

    if (config.platform === 'woocommerce') {
      const url = config.storeUrl + '/wp-json/wc/v3/products?per_page=100&status=publish';
      rawProducts = await caller(url, { Authorization: 'Basic ' + Buffer.from(config.apiKey + ':' + (config.apiSecret || '')).toString('base64') }, abortCtrl.signal);
    } else if (config.platform === 'shopify') {
      const url = config.storeUrl + '/admin/api/2023-10/products.json?limit=250&status=active';
      const resp = await caller(url, { 'X-Shopify-Access-Token': config.apiKey }, abortCtrl.signal);
      rawProducts = resp.products || resp;
    } else if (config.platform === 'tiendanube') {
      const url = config.storeUrl + '/v1/products?per_page=200';
      rawProducts = await caller(url, { Authentication: 'bearer ' + config.apiKey }, abortCtrl.signal);
    }
  } catch (e) {
    console.error('[ECOM] Error syncing catalogo: ' + e.message);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const normalize = config.platform === 'woocommerce'
    ? normalizeWooProduct
    : config.platform === 'shopify'
      ? normalizeShopifyProduct
      : p => ({ ...p, platform: config.platform, sourceId: String(p.id) });

  const products = (Array.isArray(rawProducts) ? rawProducts : [])
    .slice(0, MAX_PRODUCTS_SYNC)
    .map(normalize);

  try {
    await db().collection('synced_catalogs').doc(uid).set({
      uid, platform: config.platform,
      products, syncedAt: new Date().toISOString(),
      count: products.length,
    });
    console.log('[ECOM] catalogo sincronizado uid=' + uid.substring(0, 8) + ' count=' + products.length);
  } catch (e) {
    console.error('[ECOM] Error guardando catalogo sincronizado: ' + e.message);
  }

  return { synced: products.length, products, platform: config.platform };
}

async function _defaultFetch(url, headers, signal) {
  const resp = await fetch(url, { headers, signal });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.json();
}

/**
 * Obtiene el catalogo sincronizado del owner.
 * @param {string} uid
 * @returns {Promise<object[]>}
 */
async function getSyncedCatalog(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('synced_catalogs').doc(uid).get();
    if (!snap.exists) return [];
    return snap.data().products || [];
  } catch (e) {
    console.error('[ECOM] Error leyendo catalogo: ' + e.message);
    return [];
  }
}

module.exports = {
  saveStoreConfig, getStoreConfig, syncCatalog, getSyncedCatalog,
  normalizeWooProduct, normalizeShopifyProduct,
  SUPPORTED_PLATFORMS, ORDER_STATUSES, MAX_PRODUCTS_SYNC,
  __setFirestoreForTests, __setHttpClientForTests,
};
