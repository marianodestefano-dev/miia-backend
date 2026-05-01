'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const MOVEMENT_TYPES = Object.freeze(['in', 'out', 'adjustment', 'return', 'damaged', 'reserved', 'unreserved']);
const ALERT_TYPES = Object.freeze(['low_stock', 'out_of_stock', 'overstock', 'expiry_approaching']);
const ALERT_STATUSES = Object.freeze(['active', 'acknowledged', 'resolved']);

const DEFAULT_LOW_STOCK_THRESHOLD = 5;
const DEFAULT_OVERSTOCK_THRESHOLD = 1000;
const MAX_NOTES_LENGTH = 300;
const MAX_MOVEMENTS_PER_QUERY = 100;

function isValidMovementType(t) { return MOVEMENT_TYPES.includes(t); }
function isValidAlertType(t) { return ALERT_TYPES.includes(t); }
function isValidAlertStatus(s) { return ALERT_STATUSES.includes(s); }

function buildMovementId(uid, productId, type) {
  const ts = Date.now().toString(36);
  const typeSlug = type.replace(/_/g, '').slice(0, 4);
  return uid.slice(0, 8) + '_inv_' + (productId || '').slice(0, 8) + '_' + typeSlug + '_' + ts;
}

function buildInventoryRecord(uid, productId, data) {
  data = data || {};
  const now = Date.now();
  const quantity = typeof data.quantity === 'number' ? Math.max(0, Math.floor(data.quantity)) : 0;
  return {
    inventoryId: uid.slice(0, 8) + '_stock_' + (productId || '').slice(0, 20),
    uid,
    productId: productId || '',
    productName: typeof data.productName === 'string' ? data.productName.trim().slice(0, 100) : '',
    quantity,
    reservedQuantity: typeof data.reservedQuantity === 'number' ? Math.max(0, Math.floor(data.reservedQuantity)) : 0,
    lowStockThreshold: typeof data.lowStockThreshold === 'number' && data.lowStockThreshold >= 0
      ? Math.floor(data.lowStockThreshold) : DEFAULT_LOW_STOCK_THRESHOLD,
    overstockThreshold: typeof data.overstockThreshold === 'number' && data.overstockThreshold > 0
      ? Math.floor(data.overstockThreshold) : DEFAULT_OVERSTOCK_THRESHOLD,
    unit: typeof data.unit === 'string' ? data.unit.trim().slice(0, 20) : 'unidad',
    location: typeof data.location === 'string' ? data.location.trim().slice(0, 100) : '',
    metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

function buildMovementRecord(uid, productId, type, qty, data) {
  data = data || {};
  if (!isValidMovementType(type)) throw new Error('movement type invalido: ' + type);
  const quantity = typeof qty === 'number' && isFinite(qty) ? qty : 0;
  const movementId = data.movementId || buildMovementId(uid, productId, type);
  return {
    movementId,
    uid,
    productId: productId || '',
    type,
    quantity,
    previousQuantity: typeof data.previousQuantity === 'number' ? data.previousQuantity : null,
    notes: typeof data.notes === 'string' ? data.notes.trim().slice(0, MAX_NOTES_LENGTH) : '',
    referenceId: typeof data.referenceId === 'string' ? data.referenceId.trim() : null,
    createdAt: data.createdAt || Date.now(),
  };
}

function applyMovement(inventory, movement) {
  if (!inventory) throw new Error('inventory no puede ser null');
  const prev = inventory.quantity;
  let newQty;
  switch (movement.type) {
    case 'in':
    case 'return':
    case 'unreserved':
      newQty = prev + Math.abs(movement.quantity);
      break;
    case 'out':
    case 'damaged':
      newQty = Math.max(0, prev - Math.abs(movement.quantity));
      break;
    case 'reserved':
      newQty = prev;
      break;
    case 'adjustment':
      newQty = Math.max(0, movement.quantity);
      break;
    default:
      newQty = prev;
  }
  return {
    ...inventory,
    quantity: Math.floor(newQty),
    updatedAt: Date.now(),
  };
}

function computeAvailableQuantity(inventory) {
  if (!inventory) return 0;
  return Math.max(0, inventory.quantity - (inventory.reservedQuantity || 0));
}

function checkStockAlerts(inventory) {
  if (!inventory) return [];
  const alerts = [];
  const avail = computeAvailableQuantity(inventory);
  if (avail <= 0) {
    alerts.push({ type: 'out_of_stock', quantity: avail, threshold: 0 });
  } else if (avail <= inventory.lowStockThreshold) {
    alerts.push({ type: 'low_stock', quantity: avail, threshold: inventory.lowStockThreshold });
  }
  if (inventory.quantity >= inventory.overstockThreshold) {
    alerts.push({ type: 'overstock', quantity: inventory.quantity, threshold: inventory.overstockThreshold });
  }
  return alerts;
}

async function saveInventory(uid, inventory) {
  console.log('[INVENTORY] Guardando uid=' + uid + ' product=' + inventory.productId + ' qty=' + inventory.quantity);
  try {
    await db().collection('owners').doc(uid)
      .collection('inventory').doc(inventory.inventoryId)
      .set(inventory, { merge: false });
    return inventory.inventoryId;
  } catch (err) {
    console.error('[INVENTORY] Error guardando:', err.message);
    throw err;
  }
}

async function getInventory(uid, productId) {
  const inventoryId = uid.slice(0, 8) + '_stock_' + (productId || '').slice(0, 20);
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('inventory').doc(inventoryId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[INVENTORY] Error obteniendo:', err.message);
    return null;
  }
}

async function updateInventoryQuantity(uid, productId, newQuantity) {
  const inventoryId = uid.slice(0, 8) + '_stock_' + (productId || '').slice(0, 20);
  const qty = Math.max(0, Math.floor(newQuantity));
  console.log('[INVENTORY] Actualizando qty uid=' + uid + ' product=' + productId + ' qty=' + qty);
  try {
    await db().collection('owners').doc(uid)
      .collection('inventory').doc(inventoryId)
      .set({ quantity: qty, updatedAt: Date.now() }, { merge: true });
    return inventoryId;
  } catch (err) {
    console.error('[INVENTORY] Error actualizando qty:', err.message);
    throw err;
  }
}

async function saveMovement(uid, movement) {
  console.log('[INVENTORY] Movimiento uid=' + uid + ' type=' + movement.type + ' qty=' + movement.quantity);
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

async function listMovements(uid, productId, opts) {
  opts = opts || {};
  try {
    let q = db().collection('owners').doc(uid).collection('inventory_movements');
    if (productId) q = q.where('productId', '==', productId);
    const snap = await q.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      if (opts.type && rec.type !== opts.type) return;
      results.push(rec);
    });
    results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return results.slice(0, opts.limit || MAX_MOVEMENTS_PER_QUERY);
  } catch (err) {
    console.error('[INVENTORY] Error listando movimientos:', err.message);
    return [];
  }
}

async function listLowStockItems(uid) {
  try {
    const snap = await db().collection('owners').doc(uid).collection('inventory').get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      const avail = computeAvailableQuantity(rec);
      if (avail <= rec.lowStockThreshold) results.push(rec);
    });
    results.sort((a, b) => computeAvailableQuantity(a) - computeAvailableQuantity(b));
    return results;
  } catch (err) {
    console.error('[INVENTORY] Error listando low stock:', err.message);
    return [];
  }
}

function buildInventoryText(inventory) {
  if (!inventory) return '';
  const avail = computeAvailableQuantity(inventory);
  const alerts = checkStockAlerts(inventory);
  const parts = [];
  parts.push('\u{1F4E6} *' + (inventory.productName || inventory.productId) + '*');
  parts.push('Stock: ' + inventory.quantity + ' ' + inventory.unit);
  if (inventory.reservedQuantity > 0) parts.push('Reservado: ' + inventory.reservedQuantity);
  parts.push('Disponible: ' + avail);
  if (alerts.length > 0) {
    alerts.forEach(alert => {
      if (alert.type === 'out_of_stock') parts.push('\u{274C} SIN STOCK');
      else if (alert.type === 'low_stock') parts.push('\u{26A0}\uFE0F Stock bajo (limite: ' + alert.threshold + ')');
      else if (alert.type === 'overstock') parts.push('\u{1F4CA} Sobrestock');
    });
  } else {
    parts.push('\u{2705} Stock OK');
  }
  if (inventory.location) parts.push('Ubicacion: ' + inventory.location);
  return parts.join('\n');
}

function buildInventorySummaryText(inventoryList) {
  if (!inventoryList || inventoryList.length === 0) return 'No hay productos en inventario.';
  const lowStock = inventoryList.filter(i => {
    const avail = computeAvailableQuantity(i);
    return avail <= i.lowStockThreshold;
  });
  const outOfStock = lowStock.filter(i => computeAvailableQuantity(i) <= 0);
  const parts = [];
  parts.push('\u{1F4CB} *Resumen de Inventario*');
  parts.push('Total productos: ' + inventoryList.length);
  parts.push('Con stock bajo: ' + lowStock.length);
  parts.push('Sin stock: ' + outOfStock.length);
  if (outOfStock.length > 0) {
    parts.push('');
    parts.push('\u{274C} Sin stock:');
    outOfStock.slice(0, 5).forEach(i => parts.push('  - ' + (i.productName || i.productId)));
  }
  return parts.join('\n');
}

module.exports = {
  buildInventoryRecord,
  buildMovementRecord,
  applyMovement,
  computeAvailableQuantity,
  checkStockAlerts,
  saveInventory,
  getInventory,
  updateInventoryQuantity,
  saveMovement,
  listMovements,
  listLowStockItems,
  buildInventoryText,
  buildInventorySummaryText,
  MOVEMENT_TYPES,
  ALERT_TYPES,
  ALERT_STATUSES,
  DEFAULT_LOW_STOCK_THRESHOLD,
  __setFirestoreForTests,
};
