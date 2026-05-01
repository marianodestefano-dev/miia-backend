'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const PRODUCT_STATUSES = Object.freeze(['active', 'inactive', 'archived', 'out_of_stock', 'discontinued']);
const MOVEMENT_TYPES = Object.freeze(['purchase', 'sale', 'adjustment', 'return', 'damaged', 'transfer', 'initial']);
const PRODUCT_CATEGORIES = Object.freeze(['product', 'service', 'digital', 'subscription', 'bundle', 'other']);

const MAX_SKU_LENGTH = 50;
const MAX_NAME_LENGTH = 150;
const MAX_PRODUCTS_PER_QUERY = 500;
const DEFAULT_LOW_STOCK_THRESHOLD = 5;
const DEFAULT_TAX_RATE = 0.21;

function isValidStatus(s) { return PRODUCT_STATUSES.includes(s); }
function isValidMovementType(t) { return MOVEMENT_TYPES.includes(t); }
function isValidCategory(c) { return PRODUCT_CATEGORIES.includes(c); }

function buildProductId(uid, sku) {
  const cleanSku = String(sku).toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
  return uid.slice(0, 8) + '_prod_' + cleanSku;
}

function buildProductRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const sku = typeof data.sku === 'string' && data.sku.trim().length > 0
    ? data.sku.trim().toUpperCase().slice(0, MAX_SKU_LENGTH)
    : 'SKU' + now.toString(36).toUpperCase();
  const productId = data.productId || buildProductId(uid, sku);

  const unitPrice = typeof data.unitPrice === 'number' ? Math.max(0, data.unitPrice) : 0;
  const costPrice = typeof data.costPrice === 'number' ? Math.max(0, data.costPrice) : 0;
  const taxRate = typeof data.taxRate === 'number' ? Math.min(1, Math.max(0, data.taxRate)) : DEFAULT_TAX_RATE;
  const stock = typeof data.stock === 'number' ? Math.max(0, Math.floor(data.stock)) : 0;
  const status = stock === 0 && isValidStatus(data.status) && data.status !== 'out_of_stock'
    ? data.status
    : stock === 0 ? 'out_of_stock' : (isValidStatus(data.status) ? data.status : 'active');

  return {
    productId,
    uid,
    sku,
    name: typeof data.name === 'string' ? data.name.trim().slice(0, MAX_NAME_LENGTH) : 'Producto ' + sku,
    description: typeof data.description === 'string' ? data.description.slice(0, 500) : '',
    category: isValidCategory(data.category) ? data.category : 'product',
    status,
    unitPrice,
    costPrice,
    taxRate,
    priceWithTax: Math.round(unitPrice * (1 + taxRate) * 100) / 100,
    margin: unitPrice > 0 && costPrice > 0 ? Math.round((unitPrice - costPrice) / unitPrice * 100 * 100) / 100 : 0,
    stock,
    reservedStock: typeof data.reservedStock === 'number' ? Math.max(0, Math.floor(data.reservedStock)) : 0,
    lowStockThreshold: typeof data.lowStockThreshold === 'number' ? Math.max(0, data.lowStockThreshold) : DEFAULT_LOW_STOCK_THRESHOLD,
    trackStock: data.trackStock !== false,
    currency: typeof data.currency === 'string' ? data.currency.toUpperCase().slice(0, 3) : 'ARS',
    tags: Array.isArray(data.tags) ? data.tags.slice(0, 20).map(t => String(t).toLowerCase().trim()) : [],
    imageUrl: typeof data.imageUrl === 'string' ? data.imageUrl.slice(0, 500) : null,
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    totalSold: 0,
    totalRevenue: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function adjustStock(product, quantity, type) {
  if (!isValidMovementType(type)) throw new Error('invalid_movement_type: ' + type);
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) throw new Error('invalid_quantity');
  const delta = Math.floor(quantity);
  const newStock = product.stock + delta;
  if (newStock < 0) throw new Error('insufficient_stock');
  const now = Date.now();
  const status = newStock === 0 ? 'out_of_stock' : (product.status === 'out_of_stock' ? 'active' : product.status);
  const totalSold = type === 'sale' ? product.totalSold + Math.abs(delta) : product.totalSold;
  const totalRevenue = type === 'sale' ? product.totalRevenue + Math.abs(delta) * product.unitPrice : product.totalRevenue;
  return {
    ...product,
    stock: newStock,
    status,
    totalSold,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    updatedAt: now,
  };
}

function reserveStock(product, quantity) {
  if (typeof quantity !== 'number' || quantity <= 0) throw new Error('invalid_quantity');
  const qty = Math.floor(quantity);
  const available = product.stock - product.reservedStock;
  if (qty > available) throw new Error('insufficient_available_stock');
  return { ...product, reservedStock: product.reservedStock + qty, updatedAt: Date.now() };
}

function releaseReservation(product, quantity) {
  if (typeof quantity !== 'number' || quantity <= 0) throw new Error('invalid_quantity');
  const qty = Math.floor(quantity);
  const newReserved = Math.max(0, product.reservedStock - qty);
  return { ...product, reservedStock: newReserved, updatedAt: Date.now() };
}

function checkLowStock(product) {
  if (!product.trackStock) return false;
  return product.stock > 0 && product.stock <= product.lowStockThreshold;
}

function isOutOfStock(product) {
  return product.trackStock && product.stock === 0;
}

function getAvailableStock(product) {
  return Math.max(0, product.stock - product.reservedStock);
}

function buildMovementRecord(uid, productId, data) {
  data = data || {};
  const now = Date.now();
  const qty = typeof data.quantity === 'number' ? Math.floor(data.quantity) : 0;
  return {
    movementId: uid.slice(0, 6) + '_mov_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 5),
    uid,
    productId,
    type: isValidMovementType(data.type) ? data.type : 'adjustment',
    quantity: qty,
    stockBefore: typeof data.stockBefore === 'number' ? data.stockBefore : 0,
    stockAfter: typeof data.stockAfter === 'number' ? data.stockAfter : 0,
    unitCost: typeof data.unitCost === 'number' ? Math.max(0, data.unitCost) : 0,
    totalCost: typeof data.totalCost === 'number' ? Math.max(0, data.totalCost) : 0,
    reference: typeof data.reference === 'string' ? data.reference.slice(0, 200) : null,
    notes: typeof data.notes === 'string' ? data.notes.slice(0, 500) : '',
    performedBy: typeof data.performedBy === 'string' ? data.performedBy.slice(0, 100) : 'system',
    createdAt: now,
  };
}

function computeInventoryStats(products) {
  if (!Array.isArray(products) || products.length === 0) {
    return {
      total: 0, activeCount: 0, outOfStockCount: 0, lowStockCount: 0,
      totalStockValue: 0, totalRevenue: 0, totalSold: 0, avgMargin: 0,
    };
  }
  let activeCount = 0, outOfStockCount = 0, lowStockCount = 0;
  let totalStockValue = 0, totalRevenue = 0, totalSold = 0, totalMargin = 0;
  for (const p of products) {
    if (p.status === 'active') activeCount++;
    if (isOutOfStock(p)) outOfStockCount++;
    if (checkLowStock(p)) lowStockCount++;
    totalStockValue += p.stock * p.costPrice;
    totalRevenue += p.totalRevenue;
    totalSold += p.totalSold;
    totalMargin += p.margin;
  }
  return {
    total: products.length,
    activeCount,
    outOfStockCount,
    lowStockCount,
    totalStockValue: Math.round(totalStockValue * 100) / 100,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalSold,
    avgMargin: products.length > 0 ? Math.round(totalMargin / products.length * 100) / 100 : 0,
  };
}

function buildProductSummaryText(product) {
  if (!product) return 'Producto no encontrado.';
  const statusIcon = {
    active: '\u{1F7E2}', inactive: '\u{26AB}', out_of_stock: '\u{1F534}',
    discontinued: '\u{274C}', archived: '\u{1F4E6}',
  }[product.status] || '\u{1F4E6}';
  const lines = [];
  lines.push(statusIcon + ' *' + product.name + '* (' + product.sku + ')');
  lines.push('Estado: ' + product.status + ' | Categoria: ' + product.category);
  lines.push('Precio: ' + product.currency + ' ' + product.unitPrice.toLocaleString('es-AR') + ' (con IVA: ' + product.priceWithTax.toLocaleString('es-AR') + ')');
  if (product.margin > 0) lines.push('Margen: ' + product.margin + '%');
  lines.push('Stock: ' + product.stock + (product.reservedStock > 0 ? ' (reservado: ' + product.reservedStock + ')' : ''));
  if (checkLowStock(product)) lines.push('\u{26A0}\u{FE0F} Stock bajo! Umbral: ' + product.lowStockThreshold);
  if (product.totalSold > 0) lines.push('Vendido: ' + product.totalSold + ' unidades | Revenue: ' + product.currency + ' ' + product.totalRevenue.toLocaleString('es-AR'));
  if (product.tags.length > 0) lines.push('Tags: ' + product.tags.join(', '));
  return lines.join('\n');
}

// ─── Firestore CRUD ──────────────────────────────────────────────────────────

async function saveProduct(uid, product) {
  console.log('[INVENTORY] Guardando producto uid=' + uid + ' sku=' + product.sku + ' stock=' + product.stock);
  try {
    await db().collection('owners').doc(uid)
      .collection('inventory_products').doc(product.productId)
      .set(product, { merge: false });
    return product.productId;
  } catch (err) {
    console.error('[INVENTORY] Error guardando producto:', err.message);
    throw err;
  }
}

async function getProduct(uid, productId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('inventory_products').doc(productId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[INVENTORY] Error obteniendo producto:', err.message);
    return null;
  }
}

async function updateProduct(uid, productId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  try {
    await db().collection('owners').doc(uid)
      .collection('inventory_products').doc(productId)
      .set(update, { merge: true });
    return productId;
  } catch (err) {
    console.error('[INVENTORY] Error actualizando producto:', err.message);
    throw err;
  }
}

async function saveMovement(uid, movement) {
  console.log('[INVENTORY] Guardando movimiento id=' + movement.movementId + ' tipo=' + movement.type);
  try {
    await db().collection('owners').doc(uid)
      .collection('inventory_movements').doc(movement.movementId)
      .set(movement, { merge: false });
    return movement.movementId;
  } catch (err) {
    console.error('[INVENTORY] Error guardando movimiento:', err.message);
    throw err;
  }
}

async function listLowStockProducts(uid) {
  try {
    const snap = await db().collection('owners').doc(uid).collection('inventory_products').get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const p = d.data();
      if (checkLowStock(p)) results.push(p);
    });
    return results;
  } catch (err) {
    console.error('[INVENTORY] Error listando stock bajo:', err.message);
    return [];
  }
}

async function listProductsByStatus(uid, status) {
  try {
    const ref = db().collection('owners').doc(uid).collection('inventory_products');
    const snap = status
      ? await ref.where('status', '==', status).get()
      : await ref.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results.slice(0, MAX_PRODUCTS_PER_QUERY);
  } catch (err) {
    console.error('[INVENTORY] Error listando productos:', err.message);
    return [];
  }
}

async function listMovementsByProduct(uid, productId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('inventory_movements').where('productId', '==', productId).get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results;
  } catch (err) {
    console.error('[INVENTORY] Error listando movimientos:', err.message);
    return [];
  }
}

module.exports = {
  buildProductRecord,
  adjustStock,
  reserveStock,
  releaseReservation,
  checkLowStock,
  isOutOfStock,
  getAvailableStock,
  buildMovementRecord,
  computeInventoryStats,
  buildProductSummaryText,
  saveProduct,
  getProduct,
  updateProduct,
  saveMovement,
  listLowStockProducts,
  listProductsByStatus,
  listMovementsByProduct,
  PRODUCT_STATUSES,
  MOVEMENT_TYPES,
  PRODUCT_CATEGORIES,
  DEFAULT_LOW_STOCK_THRESHOLD,
  DEFAULT_TAX_RATE,
  __setFirestoreForTests,
};
