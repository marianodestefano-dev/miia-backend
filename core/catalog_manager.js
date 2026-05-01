'use strict';

/**
 * MIIA - Catalog Manager (T238)
 * P3.1 ROADMAP: catalogo conversacional de productos y servicios del owner.
 * Permite al owner cargar, actualizar y consultar su catalogo desde WhatsApp.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const CATALOG_COLLECTION = 'catalog';
const MAX_ITEMS_PER_CATALOG = 500;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_IMAGES_PER_ITEM = 5;

const ITEM_CATEGORIES = Object.freeze([
  'product', 'service', 'package', 'subscription', 'addon',
]);

const ITEM_STATUSES = Object.freeze([
  'active', 'inactive', 'out_of_stock', 'discontinued',
]);

const CURRENCY_CODES = Object.freeze([
  'USD', 'ARS', 'COP', 'MXN', 'CLP', 'PEN', 'BRL',
]);

function isValidCategory(cat) {
  return ITEM_CATEGORIES.includes(cat);
}

function isValidStatus(status) {
  return ITEM_STATUSES.includes(status);
}

function isValidCurrency(currency) {
  return CURRENCY_CODES.includes(currency);
}

function buildCatalogItem(name, opts) {
  if (!name || typeof name !== 'string') throw new Error('name requerido');
  if (name.length > MAX_NAME_LENGTH) throw new Error('name demasiado largo: max ' + MAX_NAME_LENGTH);
  var category = (opts && opts.category && isValidCategory(opts.category)) ? opts.category : 'product';
  var status = (opts && opts.status && isValidStatus(opts.status)) ? opts.status : 'active';
  var currency = (opts && opts.currency && isValidCurrency(opts.currency)) ? opts.currency : 'USD';
  return {
    name: name.trim(),
    description: (opts && opts.description) ? String(opts.description).slice(0, MAX_DESCRIPTION_LENGTH) : null,
    category,
    status,
    price: (opts && typeof opts.price === 'number' && opts.price >= 0) ? opts.price : null,
    currency,
    images: (opts && Array.isArray(opts.images)) ? opts.images.slice(0, MAX_IMAGES_PER_ITEM) : [],
    tags: (opts && Array.isArray(opts.tags)) ? opts.tags.map(String) : [],
    sku: (opts && opts.sku) ? String(opts.sku) : null,
    stock: (opts && typeof opts.stock === 'number') ? opts.stock : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function addCatalogItem(uid, name, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!name) throw new Error('name requerido');
  var existing = await getCatalogItems(uid);
  if (existing.length >= MAX_ITEMS_PER_CATALOG) {
    throw new Error('catalogo lleno: maximo ' + MAX_ITEMS_PER_CATALOG + ' items');
  }
  var item = buildCatalogItem(name, opts);
  var docId = 'item_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  await db().collection('tenants').doc(uid).collection(CATALOG_COLLECTION).doc(docId).set(item);
  console.log('[CATALOG] Agregado uid=' + uid + ' item=' + name + ' id=' + docId);
  return { docId, item };
}

async function updateCatalogItem(uid, docId, updates) {
  if (!uid) throw new Error('uid requerido');
  if (!docId) throw new Error('docId requerido');
  if (!updates || typeof updates !== 'object') throw new Error('updates requerido');
  var allowed = ['name','description','price','status','category','currency','images','tags','sku','stock'];
  var filtered = {};
  allowed.forEach(function(k) {
    if (k in updates) filtered[k] = updates[k];
  });
  if (Object.keys(filtered).length === 0) throw new Error('sin campos validos para actualizar');
  if (filtered.status && !isValidStatus(filtered.status)) throw new Error('status invalido: ' + filtered.status);
  if (filtered.category && !isValidCategory(filtered.category)) throw new Error('category invalida: ' + filtered.category);
  if (filtered.currency && !isValidCurrency(filtered.currency)) throw new Error('currency invalida: ' + filtered.currency);
  if (filtered.name && filtered.name.length > MAX_NAME_LENGTH) throw new Error('name demasiado largo');
  filtered.updatedAt = new Date().toISOString();
  await db().collection('tenants').doc(uid).collection(CATALOG_COLLECTION).doc(docId).set(filtered, { merge: true });
  console.log('[CATALOG] Actualizado uid=' + uid + ' id=' + docId);
}

async function removeCatalogItem(uid, docId) {
  if (!uid) throw new Error('uid requerido');
  if (!docId) throw new Error('docId requerido');
  await db().collection('tenants').doc(uid).collection(CATALOG_COLLECTION).doc(docId).delete();
  console.log('[CATALOG] Eliminado uid=' + uid + ' id=' + docId);
}

async function getCatalogItems(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection(CATALOG_COLLECTION).get();
    var items = [];
    snap.forEach(function(doc) { items.push({ docId: doc.id, ...doc.data() }); });
    if (opts && opts.status) {
      items = items.filter(function(i) { return i.status === opts.status; });
    }
    if (opts && opts.category) {
      items = items.filter(function(i) { return i.category === opts.category; });
    }
    if (opts && opts.search) {
      var q = String(opts.search).toLowerCase();
      items = items.filter(function(i) {
        return (i.name && i.name.toLowerCase().includes(q)) ||
               (i.description && i.description.toLowerCase().includes(q)) ||
               (i.tags && i.tags.some(function(t) { return t.toLowerCase().includes(q); }));
      });
    }
    return items;
  } catch (e) {
    console.error('[CATALOG] Error leyendo catalogo: ' + e.message);
    return [];
  }
}

async function getCatalogItem(uid, docId) {
  if (!uid) throw new Error('uid requerido');
  if (!docId) throw new Error('docId requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection(CATALOG_COLLECTION).doc(docId).get();
    if (!snap.exists) return null;
    return { docId: snap.id, ...snap.data() };
  } catch (e) {
    console.error('[CATALOG] Error leyendo item: ' + e.message);
    return null;
  }
}

function formatPriceText(item) {
  if (item.price === null || item.price === undefined) return 'Precio a consultar';
  if (item.price === 0) return 'Gratis';
  return item.price.toLocaleString('es') + ' ' + (item.currency || 'USD');
}

function buildCatalogSummaryText(items) {
  if (!Array.isArray(items) || items.length === 0) return 'El catálogo está vacío.';
  var active = items.filter(function(i) { return i.status === 'active'; });
  var lines = ['📦 *Catálogo* (' + active.length + ' disponibles):'];
  active.slice(0, 20).forEach(function(item, idx) {
    var price = formatPriceText(item);
    lines.push((idx + 1) + '. *' + item.name + '* — ' + price);
    if (item.description) {
      lines.push('   ' + item.description.slice(0, 80) + (item.description.length > 80 ? '...' : ''));
    }
  });
  if (active.length > 20) lines.push('... y ' + (active.length - 20) + ' más. Preguntame por cualquier producto.');
  return lines.join('\n');
}

function buildItemDetailText(item) {
  if (!item) return 'Producto no encontrado.';
  var lines = ['*' + item.name + '*'];
  if (item.description) lines.push(item.description);
  lines.push('💰 ' + formatPriceText(item));
  if (item.status !== 'active') lines.push('⚠️ Estado: ' + item.status);
  if (item.stock !== null && item.stock !== undefined) lines.push('📊 Stock: ' + item.stock);
  if (item.tags && item.tags.length > 0) lines.push('🏷️ ' + item.tags.join(', '));
  return lines.join('\n');
}

function searchCatalogByText(items, query) {
  if (!query || !Array.isArray(items)) return [];
  var q = query.toLowerCase().trim();
  if (q.length < 2) return [];
  return items.filter(function(item) {
    if (item.status !== 'active') return false;
    var nameMatch = item.name && item.name.toLowerCase().includes(q);
    var descMatch = item.description && item.description.toLowerCase().includes(q);
    var tagMatch = item.tags && item.tags.some(function(t) { return t.toLowerCase().includes(q); });
    return nameMatch || descMatch || tagMatch;
  });
}

module.exports = {
  addCatalogItem,
  updateCatalogItem,
  removeCatalogItem,
  getCatalogItems,
  getCatalogItem,
  buildCatalogItem,
  formatPriceText,
  buildCatalogSummaryText,
  buildItemDetailText,
  searchCatalogByText,
  isValidCategory,
  isValidStatus,
  isValidCurrency,
  CATALOG_COLLECTION,
  MAX_ITEMS_PER_CATALOG,
  MAX_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_IMAGES_PER_ITEM,
  ITEM_CATEGORIES,
  ITEM_STATUSES,
  CURRENCY_CODES,
  __setFirestoreForTests,
};
