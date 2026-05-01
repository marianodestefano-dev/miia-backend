'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const PLATFORM_TYPES = Object.freeze(['woocommerce', 'shopify', 'tiendanube', 'mercadoshops', 'custom']);
const SYNC_STATUSES = Object.freeze(['pending', 'syncing', 'synced', 'error', 'skipped']);
const ORDER_STATUSES = Object.freeze(['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded']);
const SYNC_DIRECTIONS = Object.freeze(['import', 'export', 'bidirectional']);

const MAX_PRODUCTS_PER_SYNC = 500;
const MAX_ORDERS_PER_SYNC = 200;
const SYNC_COOLDOWN_MS = 60000; // 60 segundos entre syncs

function isValidPlatform(p) { return PLATFORM_TYPES.includes(p); }
function isValidSyncStatus(s) { return SYNC_STATUSES.includes(s); }
function isValidOrderStatus(s) { return ORDER_STATUSES.includes(s); }
function isValidDirection(d) { return SYNC_DIRECTIONS.includes(d); }

function buildEcommerceConnectionId(uid, platform) {
  return uid.slice(0, 8) + '_ecom_' + platform;
}

function buildEcommerceConnection(uid, platform, data) {
  data = data || {};
  if (!isValidPlatform(platform)) throw new Error('platform invalido: ' + platform);
  const now = Date.now();
  const connectionId = data.connectionId || buildEcommerceConnectionId(uid, platform);
  return {
    connectionId,
    uid,
    platform,
    storeUrl: typeof data.storeUrl === 'string' ? data.storeUrl.trim().slice(0, 500) : '',
    storeName: typeof data.storeName === 'string' ? data.storeName.trim().slice(0, 100) : '',
    apiKey: typeof data.apiKey === 'string' ? data.apiKey.trim().slice(0, 200) : '',
    apiSecret: typeof data.apiSecret === 'string' ? '***' : '', // nunca guardar en texto plano
    connected: data.connected === true,
    direction: isValidDirection(data.direction) ? data.direction : 'bidirectional',
    syncProducts: data.syncProducts !== false,
    syncOrders: data.syncOrders !== false,
    syncInventory: data.syncInventory !== false,
    lastSyncAt: null,
    lastSyncStatus: null,
    totalProductsSynced: 0,
    totalOrdersSynced: 0,
    errorCount: 0,
    lastError: null,
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

function buildSyncRecord(uid, connectionId, data) {
  data = data || {};
  const now = Date.now();
  const syncId = uid.slice(0, 8) + '_sync_' + connectionId.slice(0, 12) + '_' + now.toString(36);
  return {
    syncId,
    uid,
    connectionId,
    status: 'pending',
    direction: isValidDirection(data.direction) ? data.direction : 'import',
    type: data.type || 'full', // 'full' | 'incremental'
    productCount: 0,
    orderCount: 0,
    errorCount: 0,
    errors: [],
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function buildExternalProduct(data) {
  data = data || {};
  return {
    externalId: String(data.externalId || ''),
    externalSku: typeof data.externalSku === 'string' ? data.externalSku.trim() : '',
    name: typeof data.name === 'string' ? data.name.trim().slice(0, 200) : '',
    description: typeof data.description === 'string' ? data.description.slice(0, 1000) : '',
    price: typeof data.price === 'number' && data.price >= 0 ? data.price : 0,
    compareAtPrice: typeof data.compareAtPrice === 'number' ? data.compareAtPrice : null,
    stock: typeof data.stock === 'number' ? data.stock : 0,
    currency: typeof data.currency === 'string' ? data.currency.toUpperCase().slice(0, 3) : 'ARS',
    category: typeof data.category === 'string' ? data.category.trim() : '',
    images: Array.isArray(data.images) ? data.images.slice(0, 5) : [],
    active: data.active !== false,
    tags: Array.isArray(data.tags) ? data.tags.slice(0, 10) : [],
    weight: typeof data.weight === 'number' ? data.weight : null,
    platform: typeof data.platform === 'string' ? data.platform : '',
    syncedAt: Date.now(),
  };
}

function buildExternalOrder(data) {
  data = data || {};
  return {
    externalId: String(data.externalId || ''),
    externalNumber: typeof data.externalNumber === 'string' ? data.externalNumber : '',
    status: isValidOrderStatus(data.status) ? data.status : 'pending',
    total: typeof data.total === 'number' && data.total >= 0 ? data.total : 0,
    subtotal: typeof data.subtotal === 'number' ? data.subtotal : 0,
    shippingCost: typeof data.shippingCost === 'number' ? data.shippingCost : 0,
    currency: typeof data.currency === 'string' ? data.currency.toUpperCase().slice(0, 3) : 'ARS',
    customerName: typeof data.customerName === 'string' ? data.customerName.trim() : '',
    customerEmail: typeof data.customerEmail === 'string' ? data.customerEmail.trim() : '',
    customerPhone: typeof data.customerPhone === 'string' ? data.customerPhone.trim() : '',
    items: Array.isArray(data.items) ? data.items.slice(0, 50) : [],
    itemCount: Array.isArray(data.items) ? data.items.length : 0,
    platform: typeof data.platform === 'string' ? data.platform : '',
    placedAt: data.placedAt || null,
    syncedAt: Date.now(),
  };
}

function mapProductToInternal(externalProduct, uid) {
  return {
    uid,
    name: externalProduct.name,
    description: externalProduct.description,
    price: externalProduct.price,
    currency: externalProduct.currency,
    stock: externalProduct.stock,
    category: externalProduct.category || 'productos_fisicos',
    tags: externalProduct.tags,
    externalId: externalProduct.externalId,
    externalSku: externalProduct.externalSku,
    externalPlatform: externalProduct.platform,
    status: externalProduct.active ? 'available' : 'discontinued',
    syncedAt: externalProduct.syncedAt,
  };
}

function computeSyncStats(syncRecord) {
  return {
    duration: syncRecord.completedAt && syncRecord.startedAt
      ? syncRecord.completedAt - syncRecord.startedAt
      : null,
    productCount: syncRecord.productCount,
    orderCount: syncRecord.orderCount,
    errorCount: syncRecord.errorCount,
    success: syncRecord.status === 'synced' && syncRecord.errorCount === 0,
  };
}

function buildConnectionSummaryText(connection) {
  if (!connection) return 'Conexion no encontrada.';
  const parts = [];
  const icon = connection.connected ? '\u{1F7E2}' : '\u{1F534}';
  parts.push(icon + ' *E-commerce: ' + connection.platform.toUpperCase() + '*');
  if (connection.storeName) parts.push('Tienda: ' + connection.storeName);
  parts.push('Estado: ' + (connection.connected ? 'conectado' : 'desconectado'));
  parts.push('Direccion: ' + connection.direction);
  const features = [];
  if (connection.syncProducts) features.push('productos');
  if (connection.syncOrders) features.push('ordenes');
  if (connection.syncInventory) features.push('inventario');
  if (features.length > 0) parts.push('Sincroniza: ' + features.join(', '));
  parts.push('Productos sync: ' + connection.totalProductsSynced + ' | Ordenes sync: ' + connection.totalOrdersSynced);
  if (connection.lastSyncAt) {
    parts.push('Ultimo sync: ' + new Date(connection.lastSyncAt).toISOString().slice(0, 16));
  }
  if (connection.lastError) parts.push('Ultimo error: ' + connection.lastError.slice(0, 80));
  return parts.join('\n');
}

async function saveConnection(uid, connection) {
  console.log('[ECOM] Guardando conexion uid=' + uid + ' platform=' + connection.platform);
  try {
    await db().collection('owners').doc(uid)
      .collection('ecom_connections').doc(connection.connectionId)
      .set(connection, { merge: false });
    return connection.connectionId;
  } catch (err) {
    console.error('[ECOM] Error guardando conexion:', err.message);
    throw err;
  }
}

async function getConnection(uid, connectionId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('ecom_connections').doc(connectionId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[ECOM] Error obteniendo conexion:', err.message);
    return null;
  }
}

async function updateConnection(uid, connectionId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  try {
    await db().collection('owners').doc(uid)
      .collection('ecom_connections').doc(connectionId)
      .set(update, { merge: true });
    return connectionId;
  } catch (err) {
    console.error('[ECOM] Error actualizando conexion:', err.message);
    throw err;
  }
}

async function saveSyncRecord(uid, syncRecord) {
  console.log('[ECOM] Guardando sync id=' + syncRecord.syncId + ' status=' + syncRecord.status);
  try {
    await db().collection('owners').doc(uid)
      .collection('ecom_syncs').doc(syncRecord.syncId)
      .set(syncRecord, { merge: false });
    return syncRecord.syncId;
  } catch (err) {
    console.error('[ECOM] Error guardando sync:', err.message);
    throw err;
  }
}

async function getSyncRecord(uid, syncId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('ecom_syncs').doc(syncId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[ECOM] Error obteniendo sync:', err.message);
    return null;
  }
}

module.exports = {
  buildEcommerceConnection,
  buildSyncRecord,
  buildExternalProduct,
  buildExternalOrder,
  mapProductToInternal,
  computeSyncStats,
  buildConnectionSummaryText,
  saveConnection,
  getConnection,
  updateConnection,
  saveSyncRecord,
  getSyncRecord,
  PLATFORM_TYPES,
  SYNC_STATUSES,
  ORDER_STATUSES,
  SYNC_DIRECTIONS,
  MAX_PRODUCTS_PER_SYNC,
  MAX_ORDERS_PER_SYNC,
  SYNC_COOLDOWN_MS,
  __setFirestoreForTests,
};
