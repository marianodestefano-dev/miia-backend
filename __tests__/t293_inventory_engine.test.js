'use strict';

/**
 * T293 — inventory_engine tests
 * Products, stock adjustments, reservations, low stock detection,
 * movements, stats, summary text, CRUD mock Firestore
 */

const {
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
  __setFirestoreForTests: setInvDb,
} = require('../core/inventory_engine');

// ─── Mock DB ─────────────────────────────────────────────────────────────────

function makeMockDb() {
  const store = {};
  return {
    store,
    db: {
      collection: () => ({
        doc: (uid) => ({
          collection: (subCol) => ({
            doc: (id) => ({
              set: async (data) => {
                if (!store[uid]) store[uid] = {};
                if (!store[uid][subCol]) store[uid][subCol] = {};
                store[uid][subCol][id] = { ...data };
              },
              get: async () => {
                const rec = store[uid] && store[uid][subCol] && store[uid][subCol][id];
                return { exists: !!rec, data: () => rec };
              },
            }),
            where: (field, op, val) => {
              const chain = { filters: [[field, op, val]] };
              chain.where = (f2, op2, v2) => { chain.filters.push([f2, op2, v2]); return chain; };
              chain.get = async () => {
                const all = Object.values((store[uid] || {})[subCol] || {});
                const filtered = all.filter(r => chain.filters.every(([f, o, v]) => {
                  if (o === '==') return r[f] === v;
                  return true;
                }));
                return {
                  empty: filtered.length === 0,
                  forEach: (fn) => filtered.forEach(d => fn({ data: () => d })),
                };
              };
              return chain;
            },
            get: async () => {
              const all = Object.values((store[uid] || {})[subCol] || {});
              return {
                empty: all.length === 0,
                forEach: (fn) => all.forEach(d => fn({ data: () => d })),
              };
            },
          }),
        }),
      }),
    },
  };
}

const UID = 'owner_inv_001';

describe('T293 — inventory_engine: productos + stock + movimientos', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setInvDb(mock.db);
  });

  // ─── Constantes ──────────────────────────────────────────────────────────

  test('constantes exportadas correctas', () => {
    expect(PRODUCT_STATUSES).toContain('active');
    expect(PRODUCT_STATUSES).toContain('out_of_stock');
    expect(MOVEMENT_TYPES).toContain('purchase');
    expect(MOVEMENT_TYPES).toContain('sale');
    expect(PRODUCT_CATEGORIES).toContain('product');
    expect(PRODUCT_CATEGORIES).toContain('service');
    expect(DEFAULT_LOW_STOCK_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_TAX_RATE).toBeGreaterThan(0);
  });

  // ─── buildProductRecord ──────────────────────────────────────────────────

  test('buildProductRecord valores por defecto con stock 0 → out_of_stock', () => {
    const p = buildProductRecord(UID, { sku: 'PROD001', name: 'Shampoo Premium' });
    expect(p.uid).toBe(UID);
    expect(p.sku).toBe('PROD001');
    expect(p.name).toBe('Shampoo Premium');
    expect(p.stock).toBe(0);
    expect(p.status).toBe('out_of_stock');
    expect(p.category).toBe('product');
    expect(p.currency).toBe('ARS');
    expect(p.trackStock).toBe(true);
    expect(p.reservedStock).toBe(0);
    expect(p.totalSold).toBe(0);
    expect(typeof p.productId).toBe('string');
  });

  test('buildProductRecord con stock > 0 → active', () => {
    const p = buildProductRecord(UID, { sku: 'PROD002', unitPrice: 5000, costPrice: 3000, stock: 20 });
    expect(p.status).toBe('active');
    expect(p.stock).toBe(20);
    expect(p.unitPrice).toBe(5000);
    expect(p.costPrice).toBe(3000);
    // priceWithTax = 5000 * 1.21 = 6050
    expect(p.priceWithTax).toBe(6050);
    // margin = (5000-3000)/5000 * 100 = 40
    expect(p.margin).toBe(40);
  });

  test('buildProductRecord taxRate custom', () => {
    const p = buildProductRecord(UID, { sku: 'SRV001', unitPrice: 1000, taxRate: 0.10, stock: 1, category: 'service' });
    expect(p.priceWithTax).toBe(1100);
    expect(p.category).toBe('service');
  });

  test('buildProductRecord taxRate invalido se clampea 0-1', () => {
    const p1 = buildProductRecord(UID, { sku: 'A', unitPrice: 1000, taxRate: 2, stock: 5 });
    expect(p1.taxRate).toBe(1);
    const p2 = buildProductRecord(UID, { sku: 'B', unitPrice: 1000, taxRate: -0.5, stock: 5 });
    expect(p2.taxRate).toBe(0);
  });

  test('buildProductRecord SKU normalizado a mayusculas', () => {
    const p = buildProductRecord(UID, { sku: 'abc-def', stock: 10 });
    expect(p.sku).toBe('ABC-DEF');
  });

  test('buildProductRecord sin SKU genera uno automatico', () => {
    const p = buildProductRecord(UID, { name: 'Sin SKU', stock: 5 });
    expect(p.sku).toMatch(/^SKU/);
    expect(p.status).toBe('active');
  });

  // ─── adjustStock ─────────────────────────────────────────────────────────

  test('adjustStock agrega stock (purchase)', () => {
    let p = buildProductRecord(UID, { sku: 'P1', stock: 10, unitPrice: 1000, costPrice: 600 });
    p = adjustStock(p, 20, 'purchase');
    expect(p.stock).toBe(30);
    expect(p.status).toBe('active');
  });

  test('adjustStock reduce stock (sale) y actualiza totalSold + totalRevenue', () => {
    let p = buildProductRecord(UID, { sku: 'P2', stock: 10, unitPrice: 2000, costPrice: 1200 });
    p = adjustStock(p, -3, 'sale');
    expect(p.stock).toBe(7);
    expect(p.totalSold).toBe(3);
    expect(p.totalRevenue).toBe(6000); // 3 * 2000
  });

  test('adjustStock a 0 → out_of_stock', () => {
    let p = buildProductRecord(UID, { sku: 'P3', stock: 5 });
    p = adjustStock(p, -5, 'sale');
    expect(p.stock).toBe(0);
    expect(p.status).toBe('out_of_stock');
  });

  test('adjustStock desde out_of_stock → active al agregar', () => {
    let p = buildProductRecord(UID, { sku: 'P4', stock: 0 });
    expect(p.status).toBe('out_of_stock');
    p = adjustStock(p, 10, 'purchase');
    expect(p.stock).toBe(10);
    expect(p.status).toBe('active');
  });

  test('adjustStock con stock insuficiente lanza error', () => {
    const p = buildProductRecord(UID, { sku: 'P5', stock: 3 });
    expect(() => adjustStock(p, -10, 'sale')).toThrow('insufficient_stock');
  });

  test('adjustStock tipo invalido lanza error', () => {
    const p = buildProductRecord(UID, { sku: 'P6', stock: 10 });
    expect(() => adjustStock(p, 5, 'magico')).toThrow('invalid_movement_type');
  });

  test('adjustStock quantity no numero lanza error', () => {
    const p = buildProductRecord(UID, { sku: 'P7', stock: 10 });
    expect(() => adjustStock(p, 'cinco', 'purchase')).toThrow('invalid_quantity');
  });

  // ─── reserveStock / releaseReservation ───────────────────────────────────

  test('reserveStock reserva cantidad disponible', () => {
    let p = buildProductRecord(UID, { sku: 'R1', stock: 20 });
    p = reserveStock(p, 5);
    expect(p.reservedStock).toBe(5);
    expect(getAvailableStock(p)).toBe(15); // 20 - 5
  });

  test('reserveStock con mas de disponible lanza error', () => {
    const p = buildProductRecord(UID, { sku: 'R2', stock: 3 });
    expect(() => reserveStock(p, 5)).toThrow('insufficient_available_stock');
  });

  test('releaseReservation libera stock reservado', () => {
    let p = buildProductRecord(UID, { sku: 'R3', stock: 10 });
    p = reserveStock(p, 4);
    p = releaseReservation(p, 4);
    expect(p.reservedStock).toBe(0);
    expect(getAvailableStock(p)).toBe(10);
  });

  test('releaseReservation mas de lo reservado no queda negativo', () => {
    let p = buildProductRecord(UID, { sku: 'R4', stock: 10 });
    p = reserveStock(p, 2);
    p = releaseReservation(p, 10);
    expect(p.reservedStock).toBe(0);
  });

  // ─── checkLowStock / isOutOfStock / getAvailableStock ────────────────────

  test('checkLowStock true cuando stock <= umbral', () => {
    const p = buildProductRecord(UID, { sku: 'L1', stock: 3, lowStockThreshold: 5 });
    expect(checkLowStock(p)).toBe(true);
  });

  test('checkLowStock false cuando stock > umbral', () => {
    const p = buildProductRecord(UID, { sku: 'L2', stock: 10, lowStockThreshold: 5 });
    expect(checkLowStock(p)).toBe(false);
  });

  test('checkLowStock false cuando stock == 0 (es out_of_stock, no low)', () => {
    const p = buildProductRecord(UID, { sku: 'L3', stock: 0 });
    expect(checkLowStock(p)).toBe(false);
  });

  test('checkLowStock false cuando trackStock=false', () => {
    const p = buildProductRecord(UID, { sku: 'L4', stock: 2, lowStockThreshold: 5, trackStock: false });
    expect(checkLowStock(p)).toBe(false);
  });

  test('isOutOfStock correcto', () => {
    const pOut = buildProductRecord(UID, { sku: 'OOS1', stock: 0 });
    expect(isOutOfStock(pOut)).toBe(true);
    const pIn = buildProductRecord(UID, { sku: 'OOS2', stock: 5 });
    expect(isOutOfStock(pIn)).toBe(false);
  });

  test('getAvailableStock = stock - reservedStock', () => {
    let p = buildProductRecord(UID, { sku: 'AV1', stock: 15 });
    p = reserveStock(p, 3);
    expect(getAvailableStock(p)).toBe(12);
  });

  // ─── buildMovementRecord ──────────────────────────────────────────────────

  test('buildMovementRecord valores correctos', () => {
    const mov = buildMovementRecord(UID, 'prod_001', {
      type: 'purchase',
      quantity: 50,
      stockBefore: 10,
      stockAfter: 60,
      unitCost: 1200,
      totalCost: 60000,
      reference: 'PO-2026-001',
      performedBy: 'Mariano',
    });
    expect(mov.uid).toBe(UID);
    expect(mov.productId).toBe('prod_001');
    expect(mov.type).toBe('purchase');
    expect(mov.quantity).toBe(50);
    expect(mov.unitCost).toBe(1200);
    expect(mov.reference).toBe('PO-2026-001');
    expect(typeof mov.movementId).toBe('string');
  });

  test('buildMovementRecord tipo invalido cae a adjustment', () => {
    const mov = buildMovementRecord(UID, 'p1', { type: 'magia' });
    expect(mov.type).toBe('adjustment');
  });

  // ─── computeInventoryStats ───────────────────────────────────────────────

  test('computeInventoryStats lista vacia', () => {
    const stats = computeInventoryStats([]);
    expect(stats.total).toBe(0);
    expect(stats.activeCount).toBe(0);
    expect(stats.outOfStockCount).toBe(0);
  });

  test('computeInventoryStats con productos variados', () => {
    let p1 = buildProductRecord(UID, { sku: 'S1', unitPrice: 5000, costPrice: 3000, stock: 20 });
    let p2 = buildProductRecord(UID, { sku: 'S2', unitPrice: 2000, costPrice: 1000, stock: 3, lowStockThreshold: 5 });
    let p3 = buildProductRecord(UID, { sku: 'S3', unitPrice: 10000, costPrice: 6000, stock: 0 });

    // P1: sell 5
    p1 = adjustStock(p1, -5, 'sale'); // totalSold=5, totalRevenue=25000

    const stats = computeInventoryStats([p1, p2, p3]);
    expect(stats.total).toBe(3);
    expect(stats.activeCount).toBe(2); // p1 (stock=15) + p2 (stock=3)
    expect(stats.outOfStockCount).toBe(1); // p3
    expect(stats.lowStockCount).toBe(1); // p2 (3 <= 5)
    expect(stats.totalSold).toBe(5);
    expect(stats.totalRevenue).toBe(25000);
    // stockValue: p1=15*3000=45000, p2=3*1000=3000, p3=0*6000=0
    expect(stats.totalStockValue).toBe(48000);
  });

  // ─── buildProductSummaryText ─────────────────────────────────────────────

  test('buildProductSummaryText null', () => {
    expect(buildProductSummaryText(null)).toContain('no encontrado');
  });

  test('buildProductSummaryText producto activo', () => {
    const p = buildProductRecord(UID, {
      sku: 'PROD-X',
      name: 'Tratamiento Capilar',
      unitPrice: 8500,
      costPrice: 5000,
      stock: 15,
      lowStockThreshold: 5,
      tags: ['capilares', 'premium'],
    });
    const text = buildProductSummaryText(p);
    expect(text).toContain('Tratamiento Capilar');
    expect(text).toContain('PROD-X');
    expect(text).toContain('8.500'); // toLocaleString es-AR
    expect(text).toContain('capilares');
  });

  test('buildProductSummaryText alerta de stock bajo', () => {
    const p = buildProductRecord(UID, { sku: 'LOW1', name: 'Item Critico', stock: 2, lowStockThreshold: 5 });
    const text = buildProductSummaryText(p);
    expect(text).toContain('Stock bajo');
  });

  // ─── CRUD Firestore mock ─────────────────────────────────────────────────

  test('saveProduct y getProduct round-trip', async () => {
    const p = buildProductRecord(UID, { sku: 'CRUD1', name: 'Test Producto', stock: 10, unitPrice: 1000 });
    const id = await saveProduct(UID, p);
    expect(id).toBe(p.productId);

    const retrieved = await getProduct(UID, p.productId);
    expect(retrieved).not.toBeNull();
    expect(retrieved.sku).toBe('CRUD1');
    expect(retrieved.stock).toBe(10);
  });

  test('getProduct inexistente retorna null', async () => {
    const result = await getProduct(UID, 'prod_no_existe_9999');
    expect(result).toBeNull();
  });

  test('updateProduct modifica campos', async () => {
    const p = buildProductRecord(UID, { sku: 'UPD1', stock: 5, unitPrice: 2000 });
    await saveProduct(UID, p);
    await updateProduct(UID, p.productId, { unitPrice: 2500, stock: 10 });
    const updated = await getProduct(UID, p.productId);
    expect(updated.unitPrice).toBe(2500);
    expect(updated.stock).toBe(10);
  });

  test('saveMovement y listMovementsByProduct', async () => {
    const p = buildProductRecord(UID, { sku: 'MOV1', stock: 20 });
    const m1 = buildMovementRecord(UID, p.productId, { type: 'purchase', quantity: 20, stockBefore: 0, stockAfter: 20 });
    const m2 = buildMovementRecord(UID, p.productId, { type: 'sale', quantity: -5, stockBefore: 20, stockAfter: 15 });
    await saveMovement(UID, m1);
    await saveMovement(UID, m2);

    const movements = await listMovementsByProduct(UID, p.productId);
    expect(movements.length).toBe(2);
    expect(movements.map(m => m.type)).toContain('purchase');
    expect(movements.map(m => m.type)).toContain('sale');
  });

  test('listProductsByStatus filtra por status', async () => {
    const p1 = buildProductRecord(UID, { sku: 'ST1', stock: 10 });
    const p2 = buildProductRecord(UID, { sku: 'ST2', stock: 0 }); // out_of_stock
    const p3 = buildProductRecord(UID, { sku: 'ST3', stock: 5 });
    await saveProduct(UID, p1);
    await saveProduct(UID, p2);
    await saveProduct(UID, p3);

    const active = await listProductsByStatus(UID, 'active');
    expect(active.length).toBe(2);
    const oos = await listProductsByStatus(UID, 'out_of_stock');
    expect(oos.length).toBe(1);
  });

  // ─── Pipeline E2E ─────────────────────────────────────────────────────────

  test('Pipeline completo — inventario: compra → reserva → venta → low stock', async () => {
    // 1. Crear producto
    let producto = buildProductRecord(UID, {
      sku: 'TRAT-KERA-500',
      name: 'Tratamiento Keratina 500ml',
      category: 'product',
      unitPrice: 12000,
      costPrice: 7000,
      stock: 0,
      lowStockThreshold: 3,
    });
    expect(producto.status).toBe('out_of_stock');
    expect(producto.margin).toBe(41.67); // (12000-7000)/12000 * 100

    // 2. Recibir compra: 15 unidades
    const movCompra = buildMovementRecord(UID, producto.productId, {
      type: 'purchase',
      quantity: 15,
      stockBefore: 0,
      stockAfter: 15,
      unitCost: 7000,
      totalCost: 105000,
      reference: 'COMPRA-001',
    });
    producto = adjustStock(producto, 15, 'purchase');
    expect(producto.stock).toBe(15);
    expect(producto.status).toBe('active');

    // 3. Reservar 2 para pedido en curso
    producto = reserveStock(producto, 2);
    expect(getAvailableStock(producto)).toBe(13);

    // 4. Vender 10 unidades
    for (let i = 0; i < 10; i++) {
      producto = adjustStock(producto, -1, 'sale');
    }
    expect(producto.stock).toBe(5);
    expect(producto.totalSold).toBe(10);
    expect(producto.totalRevenue).toBe(120000); // 10 * 12000

    // 5. Liberar reserva
    producto = releaseReservation(producto, 2);
    expect(producto.reservedStock).toBe(0);
    expect(getAvailableStock(producto)).toBe(5);

    // 6. Vender 3 mas → stock bajo!
    producto = adjustStock(producto, -3, 'sale');
    expect(producto.stock).toBe(2);
    expect(checkLowStock(producto)).toBe(true);
    expect(isOutOfStock(producto)).toBe(false);

    // 7. Guardar en Firestore
    await saveProduct(UID, producto);
    await saveMovement(UID, movCompra);

    const saved = await getProduct(UID, producto.productId);
    expect(saved.sku).toBe('TRAT-KERA-500');
    expect(saved.stock).toBe(2);

    // 8. Stats
    const stats = computeInventoryStats([producto]);
    expect(stats.lowStockCount).toBe(1);
    expect(stats.totalSold).toBe(13); // 10 + 3
    expect(stats.totalRevenue).toBe(156000); // 13 * 12000
    // stockValue: 2 * 7000 = 14000
    expect(stats.totalStockValue).toBe(14000);

    // 9. Summary
    const text = buildProductSummaryText(producto);
    expect(text).toContain('TRAT-KERA-500');
    expect(text).toContain('Stock bajo');
  });
});
