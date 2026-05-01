'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const PRODUCT_STATUSES = Object.freeze(['available', 'out_of_stock', 'discontinued', 'draft']);
const CATALOG_CATEGORIES = Object.freeze([
  'servicios', 'productos_fisicos', 'productos_digitales', 'paquetes',
  'suscripciones', 'combos', 'promociones', 'otros',
]);
const CATALOG_CURRENCIES = Object.freeze(['ARS', 'USD', 'COP', 'MXN', 'CLP', 'PEN', 'BRL']);
const VALID_SORT_FIELDS = Object.freeze(['price', 'name', 'createdAt', 'updatedAt']);

const MAX_PRODUCTS_PER_CATALOG = 500;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_NAME_LENGTH = 120;
const MAX_TAGS_PER_PRODUCT = 10;

function isValidPrice(p) { return typeof p === 'number' && isFinite(p) && p >= 0; }
function isValidCurrency(c) { return CATALOG_CURRENCIES.includes(c); }
function isValidCategory(c) { return CATALOG_CATEGORIES.includes(c); }
function isValidStatus(s) { return PRODUCT_STATUSES.includes(s); }

function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  return name.trim().slice(0, MAX_NAME_LENGTH);
}

function sanitizeDescription(desc) {
  if (typeof desc !== 'string') return '';
  return desc.trim().slice(0, MAX_DESCRIPTION_LENGTH);
}

function buildProductId(uid, name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 30);
  return uid.slice(0, 8) + '_prod_' + slug;
}

function buildProductRecord(uid, data = {}) {
  const now = Date.now();
  const name = sanitizeName(data.name || '');
  const productId = data.productId || buildProductId(uid, name || String(now));
  const tags = Array.isArray(data.tags)
    ? data.tags.filter(t => typeof t === 'string').slice(0, MAX_TAGS_PER_PRODUCT)
    : [];
  return {
    productId,
    uid,
    name,
    description: sanitizeDescription(data.description || ''),
    price: isValidPrice(data.price) ? data.price : 0,
    currency: isValidCurrency(data.currency) ? data.currency : 'ARS',
    category: isValidCategory(data.category) ? data.category : 'otros',
    status: isValidStatus(data.status) ? data.status : 'available',
    stock: typeof data.stock === 'number' && data.stock >= 0 ? Math.floor(data.stock) : null,
    imageUrl: typeof data.imageUrl === 'string' ? data.imageUrl.trim().slice(0, 500) : null,
    tags,
    metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

function validateProductData(data) {
  const errors = [];
  if (!data.name || typeof data.name !== 'string' || data.name.trim().length === 0) {
    errors.push('name es requerido');
  }
  if (data.price !== undefined && !isValidPrice(data.price)) {
    errors.push('price debe ser numero no negativo');
  }
  if (data.currency && !isValidCurrency(data.currency)) {
    errors.push('currency invalida: ' + data.currency);
  }
  if (data.category && !isValidCategory(data.category)) {
    errors.push('category invalida: ' + data.category);
  }
  if (data.status && !isValidStatus(data.status)) {
    errors.push('status invalido: ' + data.status);
  }
  return { valid: errors.length === 0, errors };
}

async function saveProduct(uid, product) {
  console.log('[CATALOG] Guardando product uid=' + uid + ' id=' + product.productId);
  try {
    await db().collection('owners').doc(uid)
      .collection('catalog').doc(product.productId)
      .set(product, { merge: false });
    return product.productId;
  } catch (err) {
    console.error('[CATALOG] Error guardando product:', err.message);
    throw err;
  }
}

async function getProduct(uid, productId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('catalog').doc(productId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[CATALOG] Error obteniendo product:', err.message);
    return null;
  }
}

async function updateProductStatus(uid, productId, status) {
  if (!isValidStatus(status)) throw new Error('status invalido: ' + status);
  console.log('[CATALOG] Actualizando status uid=' + uid + ' id=' + productId + ' status=' + status);
  try {
    await db().collection('owners').doc(uid)
      .collection('catalog').doc(productId)
      .set({ status, updatedAt: Date.now() }, { merge: true });
    return productId;
  } catch (err) {
    console.error('[CATALOG] Error actualizando status:', err.message);
    throw err;
  }
}

async function updateProductPrice(uid, productId, price, currency) {
  if (!isValidPrice(price)) throw new Error('price invalido: ' + price);
  const update = { price, updatedAt: Date.now() };
  if (currency && isValidCurrency(currency)) update.currency = currency;
  console.log('[CATALOG] Actualizando precio uid=' + uid + ' id=' + productId + ' price=' + price);
  try {
    await db().collection('owners').doc(uid)
      .collection('catalog').doc(productId)
      .set(update, { merge: true });
    return productId;
  } catch (err) {
    console.error('[CATALOG] Error actualizando precio:', err.message);
    throw err;
  }
}

async function listProductsByCategory(uid, category) {
  if (!isValidCategory(category)) {
    console.warn('[CATALOG] category invalida:', category);
    return [];
  }
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('catalog').where('category', '==', category).get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results;
  } catch (err) {
    console.error('[CATALOG] Error listando por categoria:', err.message);
    return [];
  }
}

async function listAvailableProducts(uid) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('catalog').where('status', '==', 'available').get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results;
  } catch (err) {
    console.error('[CATALOG] Error listando disponibles:', err.message);
    return [];
  }
}

function searchProductsLocal(products, query, opts) {
  opts = opts || {};
  const q = typeof query === 'string' ? query.toLowerCase().trim() : '';
  let filtered = products.slice();
  if (q) {
    filtered = filtered.filter(function(p) {
      const inName = p.name && p.name.toLowerCase().includes(q);
      const inDesc = p.description && p.description.toLowerCase().includes(q);
      const inTags = p.tags && p.tags.some(function(t) { return t.toLowerCase().includes(q); });
      return inName || inDesc || inTags;
    });
  }
  if (opts.category && isValidCategory(opts.category)) {
    filtered = filtered.filter(function(p) { return p.category === opts.category; });
  }
  if (opts.status && isValidStatus(opts.status)) {
    filtered = filtered.filter(function(p) { return p.status === opts.status; });
  }
  if (opts.maxPrice !== undefined) {
    filtered = filtered.filter(function(p) { return p.price <= opts.maxPrice; });
  }
  if (opts.minPrice !== undefined) {
    filtered = filtered.filter(function(p) { return p.price >= opts.minPrice; });
  }
  const sortBy = VALID_SORT_FIELDS.includes(opts.sortBy) ? opts.sortBy : 'name';
  const sortDir = opts.sortDir === 'desc' ? -1 : 1;
  filtered.sort(function(a, b) {
    const av = a[sortBy] != null ? a[sortBy] : '';
    const bv = b[sortBy] != null ? b[sortBy] : '';
    if (typeof av === 'number' && typeof bv === 'number') return sortDir * (av - bv);
    return sortDir * String(av).localeCompare(String(bv));
  });
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 50;
  return filtered.slice(0, limit);
}

function computeProductAvailability(product) {
  if (!product) return { available: false, reason: 'not_found' };
  if (product.status !== 'available') return { available: false, reason: product.status };
  if (product.stock !== null && product.stock !== undefined && product.stock <= 0) {
    return { available: false, reason: 'stock_agotado' };
  }
  return { available: true, stock: product.stock };
}

function buildProductText(product) {
  if (!product) return '';
  const parts = [];
  parts.push('\u{1F4E6} *' + product.name + '*');
  if (product.description) parts.push(product.description);
  if (product.price !== undefined) {
    parts.push('\u{1F4B0} Precio: ' + product.price + ' ' + (product.currency || 'ARS'));
  }
  if (product.stock !== null && product.stock !== undefined) {
    parts.push('\u{1F4CA} Stock: ' + product.stock + ' unidades');
  }
  const avail = computeProductAvailability(product);
  parts.push(avail.available ? '\u{2705} Disponible' : '\u{274C} No disponible (' + avail.reason + ')');
  if (product.tags && product.tags.length > 0) {
    parts.push('\u{1F3F7} ' + product.tags.join(', '));
  }
  return parts.join('\n');
}

function buildCatalogText(products, opts) {
  opts = opts || {};
  if (!products || products.length === 0) return 'No hay productos disponibles en el catálogo.';
  const title = opts.title || 'Catálogo';
  const header = '\u{1F4CB} *' + title + '*';
  const grouped = {};
  products.forEach(function(p) {
    const cat = p.category || 'otros';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(p);
  });
  const sections = [header, ''];
  Object.keys(grouped).sort().forEach(function(cat) {
    const catLabel = cat.replace(/_/g, ' ');
    sections.push('*' + catLabel + '*');
    grouped[cat].forEach(function(p) {
      const avail = computeProductAvailability(p);
      const priceStr = p.price !== undefined ? ' — ' + p.price + ' ' + (p.currency || 'ARS') : '';
      const statusIcon = avail.available ? '\u{2705}' : '\u{274C}';
      sections.push(statusIcon + ' ' + p.name + priceStr);
    });
    sections.push('');
  });
  return sections.join('\n').trimEnd();
}

module.exports = {
  buildProductRecord,
  validateProductData,
  saveProduct,
  getProduct,
  updateProductStatus,
  updateProductPrice,
  listProductsByCategory,
  listAvailableProducts,
  searchProductsLocal,
  computeProductAvailability,
  buildProductText,
  buildCatalogText,
  PRODUCT_STATUSES,
  CATALOG_CATEGORIES,
  CATALOG_CURRENCIES,
  MAX_PRODUCTS_PER_CATALOG,
  MAX_DESCRIPTION_LENGTH,
  __setFirestoreForTests,
};
