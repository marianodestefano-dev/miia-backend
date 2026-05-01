'use strict';

// T266 inventory_tracker — suite completa
const {
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
  __setFirestoreForTests: setDb,
} = require('../core/inventory_tracker');

const UID = 'inventory266Uid';
const PRODUCT_ID = 'prod_corte_001';

function makeMockDb({ stored = {}, movStored = {}, throwGet = false, throwSet = false } = {}) {
  const db_stored = { ...stored };
  const mov_stored = { ...movStored };
  return {
    collection: (col) => ({
      doc: () => ({
        collection: (subCol) => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              const target = subCol === 'inventory_movements' ? mov_stored : db_stored;
              target[id] = opts && opts.merge ? { ...(target[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              const target = subCol === 'inventory_movements' ? mov_stored : db_stored;
              return { exists: !!target[id], data: () => target[id] };
            },
          }),
          where: (field, op, val) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const target = subCol === 'inventory_movements' ? mov_stored : db_stored;
              const entries = Object.values(target).filter(d => d && d[field] === val);
              return { empty: entries.length === 0, forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            const target = subCol === 'inventory_movements' ? mov_stored : db_stored;
            return { empty: Object.keys(target).length === 0, forEach: fn => Object.values(target).forEach(d => fn({ data: () => d })) };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => setDb(null));
afterEach(() => setDb(null));

// ─── CONSTANTES ──────────────────────────────────────────────────────────────
describe('inventory_tracker — constantes', () => {
  test('MOVEMENT_TYPES incluye in, out, adjustment, return', () => {
    ['in', 'out', 'adjustment', 'return', 'damaged', 'reserved', 'unreserved'].forEach(t =>
      expect(MOVEMENT_TYPES).toContain(t)
    );
  });
  test('ALERT_TYPES incluye low_stock, out_of_stock, overstock', () => {
    ['low_stock', 'out_of_stock', 'overstock', 'expiry_approaching'].forEach(t =>
      expect(ALERT_TYPES).toContain(t)
    );
  });
  test('ALERT_STATUSES incluye active, resolved', () => {
    expect(ALERT_STATUSES).toContain('active');
    expect(ALERT_STATUSES).toContain('resolved');
  });
  test('DEFAULT_LOW_STOCK_THRESHOLD es 5', () => {
    expect(DEFAULT_LOW_STOCK_THRESHOLD).toBe(5);
  });
});

// ─── buildInventoryRecord ─────────────────────────────────────────────────────
describe('buildInventoryRecord', () => {
  test('defaults correctos', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 50, productName: 'Shampoo' });
    expect(inv.uid).toBe(UID);
    expect(inv.productId).toBe(PRODUCT_ID);
    expect(inv.quantity).toBe(50);
    expect(inv.productName).toBe('Shampoo');
    expect(inv.unit).toBe('unidad');
    expect(inv.reservedQuantity).toBe(0);
    expect(inv.lowStockThreshold).toBe(DEFAULT_LOW_STOCK_THRESHOLD);
    expect(inv.metadata).toEqual({});
  });
  test('quantity negativa cae a 0', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: -10 });
    expect(inv.quantity).toBe(0);
  });
  test('quantity decimal se redondea', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 7.9 });
    expect(inv.quantity).toBe(7);
  });
  test('lowStockThreshold personalizado', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 20, lowStockThreshold: 3 });
    expect(inv.lowStockThreshold).toBe(3);
  });
  test('unit y location se guardan', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 10, unit: 'kg', location: 'Deposito A' });
    expect(inv.unit).toBe('kg');
    expect(inv.location).toBe('Deposito A');
  });
  test('inventoryId generado correctamente', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID);
    expect(inv.inventoryId).toContain(UID.slice(0, 8));
  });
});

// ─── buildMovementRecord ──────────────────────────────────────────────────────
describe('buildMovementRecord', () => {
  test('ingreso (in) correcto', () => {
    const m = buildMovementRecord(UID, PRODUCT_ID, 'in', 10, { notes: 'Reposicion' });
    expect(m.type).toBe('in');
    expect(m.quantity).toBe(10);
    expect(m.notes).toBe('Reposicion');
    expect(m.uid).toBe(UID);
    expect(m.productId).toBe(PRODUCT_ID);
  });
  test('egreso (out) correcto', () => {
    const m = buildMovementRecord(UID, PRODUCT_ID, 'out', 3);
    expect(m.type).toBe('out');
    expect(m.quantity).toBe(3);
  });
  test('type invalido lanza error', () => {
    expect(() => buildMovementRecord(UID, PRODUCT_ID, 'compra', 5)).toThrow('movement type invalido');
  });
  test('movementId se puede forzar', () => {
    const m = buildMovementRecord(UID, PRODUCT_ID, 'in', 5, { movementId: 'mov_custom_001' });
    expect(m.movementId).toBe('mov_custom_001');
  });
  test('referenceId se guarda', () => {
    const m = buildMovementRecord(UID, PRODUCT_ID, 'out', 2, { referenceId: 'sale_001' });
    expect(m.referenceId).toBe('sale_001');
  });
  test('notes se truncan a MAX=300', () => {
    const m = buildMovementRecord(UID, PRODUCT_ID, 'in', 1, { notes: 'N'.repeat(400) });
    expect(m.notes.length).toBe(300);
  });
});

// ─── applyMovement ────────────────────────────────────────────────────────────
describe('applyMovement', () => {
  const makeInv = (qty) => buildInventoryRecord(UID, PRODUCT_ID, { quantity: qty, productName: 'X' });

  test('in suma al stock', () => {
    const inv = makeInv(10);
    const m = buildMovementRecord(UID, PRODUCT_ID, 'in', 5);
    const updated = applyMovement(inv, m);
    expect(updated.quantity).toBe(15);
  });
  test('out resta del stock', () => {
    const inv = makeInv(10);
    const m = buildMovementRecord(UID, PRODUCT_ID, 'out', 3);
    const updated = applyMovement(inv, m);
    expect(updated.quantity).toBe(7);
  });
  test('out no puede ir negativo', () => {
    const inv = makeInv(2);
    const m = buildMovementRecord(UID, PRODUCT_ID, 'out', 10);
    const updated = applyMovement(inv, m);
    expect(updated.quantity).toBe(0);
  });
  test('adjustment setea cantidad absoluta', () => {
    const inv = makeInv(50);
    const m = buildMovementRecord(UID, PRODUCT_ID, 'adjustment', 30);
    const updated = applyMovement(inv, m);
    expect(updated.quantity).toBe(30);
  });
  test('damaged resta', () => {
    const inv = makeInv(10);
    const m = buildMovementRecord(UID, PRODUCT_ID, 'damaged', 2);
    const updated = applyMovement(inv, m);
    expect(updated.quantity).toBe(8);
  });
  test('return suma', () => {
    const inv = makeInv(5);
    const m = buildMovementRecord(UID, PRODUCT_ID, 'return', 3);
    const updated = applyMovement(inv, m);
    expect(updated.quantity).toBe(8);
  });
  test('reserved no cambia cantidad', () => {
    const inv = makeInv(10);
    const m = buildMovementRecord(UID, PRODUCT_ID, 'reserved', 3);
    const updated = applyMovement(inv, m);
    expect(updated.quantity).toBe(10);
  });
  test('null inventory lanza error', () => {
    const m = buildMovementRecord(UID, PRODUCT_ID, 'in', 5);
    expect(() => applyMovement(null, m)).toThrow();
  });
});

// ─── computeAvailableQuantity ─────────────────────────────────────────────────
describe('computeAvailableQuantity', () => {
  test('disponible = quantity - reservedQuantity', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 10, reservedQuantity: 3 });
    expect(computeAvailableQuantity(inv)).toBe(7);
  });
  test('no puede ser negativo', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 2, reservedQuantity: 10 });
    expect(computeAvailableQuantity(inv)).toBe(0);
  });
  test('null retorna 0', () => {
    expect(computeAvailableQuantity(null)).toBe(0);
  });
});

// ─── checkStockAlerts ─────────────────────────────────────────────────────────
describe('checkStockAlerts', () => {
  test('sin alertas si stock OK', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 50, lowStockThreshold: 5 });
    expect(checkStockAlerts(inv)).toHaveLength(0);
  });
  test('alerta low_stock si avail <= threshold', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 3, lowStockThreshold: 5 });
    const alerts = checkStockAlerts(inv);
    expect(alerts.some(a => a.type === 'low_stock')).toBe(true);
  });
  test('alerta out_of_stock si avail = 0', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 0, lowStockThreshold: 5 });
    const alerts = checkStockAlerts(inv);
    expect(alerts.some(a => a.type === 'out_of_stock')).toBe(true);
  });
  test('alerta overstock si >= overstockThreshold', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 1000, overstockThreshold: 1000 });
    const alerts = checkStockAlerts(inv);
    expect(alerts.some(a => a.type === 'overstock')).toBe(true);
  });
  test('null retorna array vacio', () => {
    expect(checkStockAlerts(null)).toEqual([]);
  });
});

// ─── saveInventory + getInventory ─────────────────────────────────────────────
describe('saveInventory + getInventory', () => {
  test('round-trip exitoso', async () => {
    const db = makeMockDb();
    setDb(db);
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 50, productName: 'Gel Capilar', unit: 'frasco' });
    const savedId = await saveInventory(UID, inv);
    expect(savedId).toBe(inv.inventoryId);
    const loaded = await getInventory(UID, PRODUCT_ID);
    expect(loaded.quantity).toBe(50);
    expect(loaded.productName).toBe('Gel Capilar');
    expect(loaded.unit).toBe('frasco');
  });
  test('getInventory retorna null si no existe', async () => {
    setDb(makeMockDb());
    const loaded = await getInventory(UID, 'prod_no_existe');
    expect(loaded).toBeNull();
  });
  test('saveInventory con throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 10 });
    await expect(saveInventory(UID, inv)).rejects.toThrow('set error');
  });
  test('getInventory con throwGet retorna null', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const loaded = await getInventory(UID, PRODUCT_ID);
    expect(loaded).toBeNull();
  });
});

// ─── updateInventoryQuantity ──────────────────────────────────────────────────
describe('updateInventoryQuantity', () => {
  test('actualiza cantidad exitosamente', async () => {
    const db = makeMockDb();
    setDb(db);
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 10 });
    await saveInventory(UID, inv);
    await updateInventoryQuantity(UID, PRODUCT_ID, 25);
    const loaded = await getInventory(UID, PRODUCT_ID);
    expect(loaded.quantity).toBe(25);
  });
  test('cantidad negativa se normaliza a 0', async () => {
    const db = makeMockDb();
    setDb(db);
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 10 });
    await saveInventory(UID, inv);
    await updateInventoryQuantity(UID, PRODUCT_ID, -5);
    const loaded = await getInventory(UID, PRODUCT_ID);
    expect(loaded.quantity).toBe(0);
  });
  test('throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    await expect(updateInventoryQuantity(UID, PRODUCT_ID, 10)).rejects.toThrow('set error');
  });
});

// ─── saveMovement + listMovements ─────────────────────────────────────────────
describe('saveMovement + listMovements', () => {
  test('round-trip exitoso', async () => {
    const db = makeMockDb();
    setDb(db);
    const m = buildMovementRecord(UID, PRODUCT_ID, 'in', 10, { notes: 'Reposicion semanal' });
    const savedId = await saveMovement(UID, m);
    expect(savedId).toBe(m.movementId);
    const movements = await listMovements(UID, PRODUCT_ID);
    expect(movements.length).toBe(1);
    expect(movements[0].type).toBe('in');
  });
  test('filtra por tipo', async () => {
    const m1 = buildMovementRecord(UID, PRODUCT_ID, 'in', 10);
    const m2 = buildMovementRecord(UID, PRODUCT_ID, 'out', 3);
    m2.movementId = m2.movementId + '_out';
    setDb(makeMockDb({ movStored: { [m1.movementId]: m1, [m2.movementId]: m2 } }));
    const outs = await listMovements(UID, PRODUCT_ID, { type: 'out' });
    expect(outs.length).toBe(1);
    expect(outs[0].type).toBe('out');
  });
  test('throwGet retorna array vacio', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const movements = await listMovements(UID, PRODUCT_ID);
    expect(movements).toEqual([]);
  });
  test('saveMovement con throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    const m = buildMovementRecord(UID, PRODUCT_ID, 'in', 5);
    await expect(saveMovement(UID, m)).rejects.toThrow('set error');
  });
});

// ─── listLowStockItems ────────────────────────────────────────────────────────
describe('listLowStockItems', () => {
  test('retorna items con stock bajo', async () => {
    const i1 = buildInventoryRecord(UID, 'p1', { quantity: 2, lowStockThreshold: 5, productName: 'Producto A' });
    const i2 = buildInventoryRecord(UID, 'p2', { quantity: 50, lowStockThreshold: 5, productName: 'Producto B' });
    i1.inventoryId = UID.slice(0,8) + '_stock_p1';
    i2.inventoryId = UID.slice(0,8) + '_stock_p2';
    setDb(makeMockDb({ stored: { [i1.inventoryId]: i1, [i2.inventoryId]: i2 } }));
    const low = await listLowStockItems(UID);
    expect(low.length).toBe(1);
    expect(low[0].productName).toBe('Producto A');
  });
  test('throwGet retorna array vacio', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const low = await listLowStockItems(UID);
    expect(low).toEqual([]);
  });
});

// ─── buildInventoryText ───────────────────────────────────────────────────────
describe('buildInventoryText', () => {
  test('incluye nombre, stock y disponible', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 20, reservedQuantity: 3, productName: 'Gel Capilar', unit: 'frasco' });
    const text = buildInventoryText(inv);
    expect(text).toContain('Gel Capilar');
    expect(text).toContain('20');
    expect(text).toContain('17');
  });
  test('indica sin stock si out_of_stock', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 0, productName: 'X' });
    const text = buildInventoryText(inv);
    expect(text).toContain('SIN STOCK');
  });
  test('indica stock bajo si low_stock', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 3, lowStockThreshold: 5, productName: 'X' });
    const text = buildInventoryText(inv);
    expect(text).toContain('bajo');
  });
  test('indica stock OK si normal', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 50, productName: 'X' });
    const text = buildInventoryText(inv);
    expect(text).toContain('OK');
  });
  test('incluye ubicacion si existe', () => {
    const inv = buildInventoryRecord(UID, PRODUCT_ID, { quantity: 10, productName: 'X', location: 'Estante 3' });
    const text = buildInventoryText(inv);
    expect(text).toContain('Estante 3');
  });
  test('null retorna string vacio', () => {
    expect(buildInventoryText(null)).toBe('');
  });
});

// ─── buildInventorySummaryText ────────────────────────────────────────────────
describe('buildInventorySummaryText', () => {
  test('vacio retorna mensaje', () => {
    expect(buildInventorySummaryText([])).toContain('No hay productos');
  });
  test('incluye totales', () => {
    const i1 = buildInventoryRecord(UID, 'p1', { quantity: 50, productName: 'A', lowStockThreshold: 5 });
    const i2 = buildInventoryRecord(UID, 'p2', { quantity: 2, productName: 'B', lowStockThreshold: 5 });
    const text = buildInventorySummaryText([i1, i2]);
    expect(text).toContain('Total productos: 2');
    expect(text).toContain('Con stock bajo: 1');
  });
  test('lista productos sin stock', () => {
    const i1 = buildInventoryRecord(UID, 'p1', { quantity: 0, productName: 'Sin Stock X', lowStockThreshold: 5 });
    const text = buildInventorySummaryText([i1]);
    expect(text).toContain('Sin Stock X');
  });
});
