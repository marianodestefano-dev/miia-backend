'use strict';

/**
 * R24 — core/ecommerce_integrations.js (Piso 4 P4.3)
 * Integración Shopify y WooCommerce por owner.
 * Shopify: Admin API REST (access_token por owner en Firestore).
 * WooCommerce: consumer_key + consumer_secret (Basic Auth).
 * Schema: owners/{uid}/integrations/shopify | woocommerce
 * Funciones: productos, ordenes, stock, estado de orden.
 */

// ── Constantes ────────────────────────────────────────────────────────────────

const SHOPIFY_API_VERSION = '2024-01';
const WC_API_VERSION = 'wc/v3';

const PLATFORM = Object.freeze({ SHOPIFY: 'shopify', WOOCOMMERCE: 'woocommerce' });

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

let _fetch = /* istanbul ignore next */ function () { return require('node-fetch')(...arguments); };
function __setFetchForTests(fn) { _fetch = fn; }

// ── Firestore refs ────────────────────────────────────────────────────────────
function _integrationDoc(uid, platform) {
  return db().collection('owners').doc(uid).collection('integrations').doc(platform);
}

// ── Credential helpers ────────────────────────────────────────────────────────
async function _getShopifyCreds(uid) {
  const snap = await _integrationDoc(uid, 'shopify').get();
  if (!snap.exists) throw new Error('shopify_no_conectado');
  const data = snap.data();
  if (!data.access_token || !data.shop_domain) throw new Error('shopify_creds_incompletos');
  return { accessToken: data.access_token, shopDomain: data.shop_domain };
}

async function _getWooCreds(uid) {
  const snap = await _integrationDoc(uid, 'woocommerce').get();
  if (!snap.exists) throw new Error('woocommerce_no_conectado');
  const data = snap.data();
  if (!data.consumer_key || !data.consumer_secret || !data.store_url) {
    throw new Error('woocommerce_creds_incompletos');
  }
  return {
    consumerKey: data.consumer_key,
    consumerSecret: data.consumer_secret,
    storeUrl: data.store_url.replace(/\/$/, ''),
  };
}

// ── Shopify API helpers ───────────────────────────────────────────────────────
function _shopifyBase(shopDomain) {
  return 'https://' + shopDomain + '/admin/api/' + SHOPIFY_API_VERSION;
}

async function _shopifyGet(uid, path) {
  const { accessToken, shopDomain } = await _getShopifyCreds(uid);
  const res = await _fetch(_shopifyBase(shopDomain) + path, {
    headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('shopify_api_error:' + res.status + ':' + errText.slice(0, 80));
  }
  return res.json();
}

async function _shopifyPut(uid, path, body) {
  const { accessToken, shopDomain } = await _getShopifyCreds(uid);
  const res = await _fetch(_shopifyBase(shopDomain) + path, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('shopify_api_error:' + res.status + ':' + errText.slice(0, 80));
  }
  return res.json();
}

// ── WooCommerce API helpers ───────────────────────────────────────────────────
async function _wooGet(uid, path) {
  const { consumerKey, consumerSecret, storeUrl } = await _getWooCreds(uid);
  const auth = Buffer.from(consumerKey + ':' + consumerSecret).toString('base64');
  const res = await _fetch(storeUrl + '/wp-json/' + WC_API_VERSION + path, {
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('woocommerce_api_error:' + res.status + ':' + errText.slice(0, 80));
  }
  return res.json();
}

async function _wooPut(uid, path, body) {
  const { consumerKey, consumerSecret, storeUrl } = await _getWooCreds(uid);
  const auth = Buffer.from(consumerKey + ':' + consumerSecret).toString('base64');
  const res = await _fetch(storeUrl + '/wp-json/' + WC_API_VERSION + path, {
    method: 'PUT',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('woocommerce_api_error:' + res.status + ':' + errText.slice(0, 80));
  }
  return res.json();
}

// ── Conexion / credenciales ───────────────────────────────────────────────────
/**
 * Guarda credenciales Shopify del owner en Firestore.
 * @param {string} uid
 * @param {{ access_token, shop_domain }} creds
 */
async function connectShopify(uid, creds) {
  if (!uid) throw new Error('uid_requerido');
  if (!creds || !creds.access_token || !creds.shop_domain) {
    throw new Error('shopify_creds_requeridos');
  }
  await _integrationDoc(uid, 'shopify').set({
    access_token: creds.access_token,
    shop_domain: creds.shop_domain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    connectedAt: new Date().toISOString(),
  });
  console.log('[ECOMM] Shopify connected uid=' + uid.slice(0, 8));
  return { ok: true, platform: PLATFORM.SHOPIFY };
}

/**
 * Guarda credenciales WooCommerce del owner en Firestore.
 * @param {string} uid
 * @param {{ consumer_key, consumer_secret, store_url }} creds
 */
async function connectWooCommerce(uid, creds) {
  if (!uid) throw new Error('uid_requerido');
  if (!creds || !creds.consumer_key || !creds.consumer_secret || !creds.store_url) {
    throw new Error('woocommerce_creds_requeridos');
  }
  await _integrationDoc(uid, 'woocommerce').set({
    consumer_key: creds.consumer_key,
    consumer_secret: creds.consumer_secret,
    store_url: creds.store_url,
    connectedAt: new Date().toISOString(),
  });
  console.log('[ECOMM] WooCommerce connected uid=' + uid.slice(0, 8));
  return { ok: true, platform: PLATFORM.WOOCOMMERCE };
}

// ── Shopify: Productos ────────────────────────────────────────────────────────
/**
 * Lista productos de Shopify.
 * @param {string} uid
 * @param {{ limit, page_info }} opts
 * @returns {Array}
 */
async function shopifyGetProducts(uid, opts) {
  const o = opts || {};
  const limit = Math.min(parseInt(o.limit) || 20, 250);
  let path = '/products.json?limit=' + limit;
  if (o.page_info) path += '&page_info=' + encodeURIComponent(o.page_info);
  const data = await _shopifyGet(uid, path);
  const products = data.products || [];
  return products.map(function (p) {
    return {
      id: p.id || '',
      title: p.title || '',
      status: p.status || 'active',
      price: (p.variants && p.variants[0] && p.variants[0].price) || '0',
      inventory: (p.variants && p.variants[0] && p.variants[0].inventory_quantity) || 0,
      vendor: p.vendor || null,
    };
  });
}

/**
 * Actualiza el stock de un variante Shopify.
 * @param {string} uid
 * @param {string|number} inventoryItemId
 * @param {number} quantity
 * @param {string} locationId
 */
async function shopifyUpdateStock(uid, inventoryItemId, quantity, locationId) {
  if (!inventoryItemId) throw new Error('inventoryItemId_requerido');
  if (typeof quantity !== 'number' || quantity < 0) throw new Error('quantity_invalida');
  if (!locationId) throw new Error('locationId_requerido');
  const body = {
    location_id: locationId,
    inventory_item_id: inventoryItemId,
    available: quantity,
  };
  await _shopifyPut(uid, '/inventory_levels/set.json', body);
  console.log('[ECOMM] Shopify stock uid=' + uid.slice(0, 8) + ' item=' + inventoryItemId + ' qty=' + quantity);
  return { ok: true };
}

// ── Shopify: Ordenes ──────────────────────────────────────────────────────────
/**
 * Lista ordenes de Shopify.
 * @param {string} uid
 * @param {{ status, limit }} opts
 */
async function shopifyGetOrders(uid, opts) {
  const o = opts || {};
  const limit = Math.min(parseInt(o.limit) || 20, 250);
  const status = o.status || 'any';
  const data = await _shopifyGet(uid, '/orders.json?status=' + status + '&limit=' + limit);
  const orders = data.orders || [];
  return orders.map(function (ord) {
    return {
      id: ord.id || '',
      order_number: ord.order_number || '',
      financial_status: ord.financial_status || '',
      fulfillment_status: ord.fulfillment_status || null,
      total_price: ord.total_price || '0',
      currency: ord.currency || 'USD',
      customer: ord.customer ? { email: ord.customer.email || '', name: (ord.customer.first_name || '') + ' ' + (ord.customer.last_name || '') } : null,
      created_at: ord.created_at || null,
    };
  });
}

// ── WooCommerce: Productos ────────────────────────────────────────────────────
/**
 * Lista productos de WooCommerce.
 * @param {string} uid
 * @param {{ per_page, page }} opts
 */
async function wooGetProducts(uid, opts) {
  const o = opts || {};
  const perPage = Math.min(parseInt(o.per_page) || 20, 100);
  const page = parseInt(o.page) || 1;
  const products = await _wooGet(uid, '/products?per_page=' + perPage + '&page=' + page);
  return (products || []).map(function (p) {
    return {
      id: p.id || '',
      name: p.name || '',
      status: p.status || 'publish',
      price: p.price || '0',
      stock_quantity: p.stock_quantity || 0,
      sku: p.sku || null,
    };
  });
}

/**
 * Actualiza el stock de un producto WooCommerce.
 * @param {string} uid
 * @param {string|number} productId
 * @param {number} stockQuantity
 */
async function wooUpdateStock(uid, productId, stockQuantity) {
  if (!productId) throw new Error('productId_requerido');
  if (typeof stockQuantity !== 'number' || stockQuantity < 0) throw new Error('stock_invalido');
  await _wooPut(uid, '/products/' + productId, {
    stock_quantity: stockQuantity,
    manage_stock: true,
  });
  console.log('[ECOMM] WooCommerce stock uid=' + uid.slice(0, 8) + ' prod=' + productId + ' qty=' + stockQuantity);
  return { ok: true };
}

// ── WooCommerce: Ordenes ──────────────────────────────────────────────────────
/**
 * Lista ordenes de WooCommerce.
 * @param {string} uid
 * @param {{ status, per_page }} opts
 */
async function wooGetOrders(uid, opts) {
  const o = opts || {};
  const perPage = Math.min(parseInt(o.per_page) || 20, 100);
  const status = o.status || 'any';
  const orders = await _wooGet(uid, '/orders?status=' + status + '&per_page=' + perPage);
  return (orders || []).map(function (ord) {
    return {
      id: ord.id || '',
      status: ord.status || '',
      total: ord.total || '0',
      currency: ord.currency || 'USD',
      date_created: ord.date_created || null,
      billing: ord.billing ? { first_name: ord.billing.first_name || '', email: ord.billing.email || '' } : null,
    };
  });
}

/**
 * Actualiza el status de una orden WooCommerce.
 * @param {string} uid
 * @param {string|number} orderId
 * @param {string} status
 */
async function wooUpdateOrderStatus(uid, orderId, status) {
  if (!orderId) throw new Error('orderId_requerido');
  if (!status) throw new Error('status_requerido');
  const data = await _wooPut(uid, '/orders/' + orderId, { status });
  console.log('[ECOMM] WooCommerce order status uid=' + uid.slice(0, 8) + ' ord=' + orderId + ' status=' + status);
  return { ok: true, status: data.status || status };
}

// ── Verificacion de conexion ──────────────────────────────────────────────────
/**
 * Verifica si el owner tiene una plataforma conectada.
 * @param {string} uid
 * @param {string} platform - 'shopify' | 'woocommerce'
 */
async function isConnected(uid, platform) {
  if (!uid || !platform) return false;
  if (!PLATFORM[platform.toUpperCase()]) return false;
  try {
    const snap = await _integrationDoc(uid, platform).get();
    if (!snap.exists) return false;
    const data = snap.data();
    if (platform === 'shopify') return !!(data.access_token && data.shop_domain);
    return !!(data.consumer_key && data.consumer_secret && data.store_url);
  } catch (_) {
    return false;
  }
}

module.exports = {
  connectShopify,
  connectWooCommerce,
  shopifyGetProducts,
  shopifyUpdateStock,
  shopifyGetOrders,
  wooGetProducts,
  wooUpdateStock,
  wooGetOrders,
  wooUpdateOrderStatus,
  isConnected,
  PLATFORM,
  SHOPIFY_API_VERSION,
  WC_API_VERSION,
  __setFirestoreForTests,
  __setFetchForTests,
};
