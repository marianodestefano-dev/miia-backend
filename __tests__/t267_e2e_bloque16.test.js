'use strict';

// T267 E2E Bloque 16: payment_processor + inventory_tracker + catalog_manager + coupon_engine
const {
  buildPaymentRecord, validatePaymentData, computePaymentTotal,
  savePayment, getPayment, updatePaymentStatus, computePaymentSummary,
  buildPaymentText, buildPaymentSummaryText,
  __setFirestoreForTests: setPayment,
} = require('../core/payment_processor');

const {
  buildInventoryRecord, buildMovementRecord, applyMovement,
  computeAvailableQuantity, checkStockAlerts,
  saveInventory, getInventory, updateInventoryQuantity, saveMovement,
  buildInventoryText, buildInventorySummaryText,
  __setFirestoreForTests: setInventory,
} = require('../core/inventory_tracker');

const {
  buildProductRecord, saveProduct, listAvailableProducts,
  searchProductsLocal, buildCatalogText, computeProductAvailability,
  updateProductStatus,
  __setFirestoreForTests: setCatalog,
} = require('../core/catalog_manager');

const {
  buildCouponRecord, validateCoupon, redeemCoupon, saveCoupon,
  computeDiscount,
  __setFirestoreForTests: setCoupon,
} = require('../core/coupon_engine');

const UID = 'bloque16Uid';
const PHONE = '+5491155554444';
const NOW = Date.now();

function makeMockDb({ stored = {}, throwGet = false, throwSet = false } = {}) {
  const db_stored = { ...stored };
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              db_stored[id] = opts && opts.merge ? { ...(db_stored[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { exists: !!db_stored[id], data: () => db_stored[id] };
            },
          }),
          where: (field, op, val) => ({
            where: (f2, o2, v2) => ({
              get: async () => {
                if (throwGet) throw new Error('get error');
                const entries = Object.values(db_stored).filter(d => {
                  if (!d) return false;
                  let ok = true;
                  if (field === 'phone') ok = ok && d.phone === val;
                  if (field === 'status') ok = ok && d.status === val;
                  if (f2 === 'phone') ok = ok && d.phone === v2;
                  if (f2 === 'status') ok = ok && d.status === v2;
                  return ok;
                });
                return { empty: entries.length === 0, forEach: fn => entries.forEach(d => fn({ data: () => d })) };
              },
            }),
            get: async () => {
              if (throwGet) throw new Error('get error');
              const entries = Object.values(db_stored).filter(d => d && d[field] === val);
              return { empty: entries.length === 0, forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return { empty: Object.keys(db_stored).length === 0, forEach: fn => Object.values(db_stored).forEach(d => fn({ data: () => d })) };
          },
        }),
      }),
    }),
  };
}

function setAll(db) { setPayment(db); setInventory(db); setCatalog(db); setCoupon(db); }

beforeEach(() => setAll(null));
afterEach(() => setAll(null));

// ─── PAYMENT PROCESSOR ────────────────────────────────────────────────────────
describe('payment_processor — bloque 16', () => {
  test('round-trip save/get payment con cupon', async () => {
    const db = makeMockDb();
    setAll(db);
    const p = buildPaymentRecord(UID, {
      amount: 1000, currency: 'ARS', method: 'transfer',
      contactPhone: PHONE, contactName: 'Ana', couponId: 'PROMO20',
      discountAmount: 200,
    });
    await savePayment(UID, p);
    setAll(db);
    const loaded = await getPayment(UID, p.paymentId);
    expect(loaded.amount).toBe(1000);
    expect(loaded.couponId).toBe('PROMO20');
    expect(computePaymentTotal(loaded)).toBe(800);
  });
  test('confirmacion de pago setea confirmedAt', async () => {
    const db = makeMockDb();
    setAll(db);
    const p = buildPaymentRecord(UID, { amount: 500, paymentId: 'pay_001' });
    await savePayment(UID, p);
    setAll(db);
    await updatePaymentStatus(UID, 'pay_001', 'confirmed');
    setAll(db);
    const loaded = await getPayment(UID, 'pay_001');
    expect(loaded.status).toBe('confirmed');
    expect(loaded.confirmedAt).toBeDefined();
  });
  test('computePaymentSummary calcula total confirmado', () => {
    const payments = [
      buildPaymentRecord(UID, { amount: 1000, status: 'confirmed' }),
      buildPaymentRecord(UID, { amount: 500, status: 'confirmed' }),
      buildPaymentRecord(UID, { amount: 200, status: 'pending' }),
    ];
    const s = computePaymentSummary(payments);
    expect(s.total).toBe(1500);
    expect(s.confirmed).toBe(2);
    expect(s.pending).toBe(1);
  });
  test('buildPaymentText incluye todos los datos clave', () => {
    const p = buildPaymentRecord(UID, {
      amount: 800, currency: 'ARS', method: 'card',
      contactName: 'Carlos', discountAmount: 200, couponId: 'MAYO20',
    });
    const text = buildPaymentText(p);
    expect(text).toContain('600'); // total = 800 - 200 discount
    expect(text).toContain('Carlos');
    expect(text).toContain('MAYO20');
  });
  test('buildPaymentSummaryText con periodo', () => {
    const payments = [buildPaymentRecord(UID, { amount: 3000, currency: 'ARS', status: 'confirmed' })];
    const text = buildPaymentSummaryText(payments, { timeframe: 'semana' });
    expect(text).toContain('semana');
    expect(text).toContain('3000');
  });
});

// ─── INVENTORY TRACKER ────────────────────────────────────────────────────────
describe('inventory_tracker — bloque 16', () => {
  test('applyMovement out reduce stock correctamente', () => {
    const inv = buildInventoryRecord(UID, 'prod_gel', { quantity: 30, productName: 'Gel' });
    const m = buildMovementRecord(UID, 'prod_gel', 'out', 5);
    const updated = applyMovement(inv, m);
    expect(updated.quantity).toBe(25);
  });
  test('checkStockAlerts detecta low_stock', () => {
    const inv = buildInventoryRecord(UID, 'prod_gel', { quantity: 2, lowStockThreshold: 5 });
    const alerts = checkStockAlerts(inv);
    expect(alerts.some(a => a.type === 'low_stock')).toBe(true);
  });
  test('saveInventory + updateInventoryQuantity', async () => {
    const db = makeMockDb();
    setAll(db);
    const inv = buildInventoryRecord(UID, 'prod_gel', { quantity: 30, productName: 'Gel Capilar' });
    await saveInventory(UID, inv);
    setAll(db);
    await updateInventoryQuantity(UID, 'prod_gel', 20);
    setAll(db);
    const loaded = await getInventory(UID, 'prod_gel');
    expect(loaded.quantity).toBe(20);
  });
  test('buildInventoryText describe correctamente stock OK', () => {
    const inv = buildInventoryRecord(UID, 'prod_x', { quantity: 50, productName: 'Producto X', unit: 'kg' });
    const text = buildInventoryText(inv);
    expect(text).toContain('Producto X');
    expect(text).toContain('50');
    expect(text).toContain('OK');
  });
  test('buildInventorySummaryText lista productos sin stock', () => {
    const i1 = buildInventoryRecord(UID, 'p1', { quantity: 0, productName: 'Sin Stock A', lowStockThreshold: 5 });
    const i2 = buildInventoryRecord(UID, 'p2', { quantity: 50, productName: 'B OK', lowStockThreshold: 5 });
    const text = buildInventorySummaryText([i1, i2]);
    expect(text).toContain('Sin stock: 1');
    expect(text).toContain('Sin Stock A');
  });
});

// ─── CATALOG MANAGER ─────────────────────────────────────────────────────────
describe('catalog_manager — bloque 16', () => {
  test('buildCatalogText multiCategoria', () => {
    const products = [
      buildProductRecord(UID, { name: 'Corte', price: 500, category: 'servicios' }),
      buildProductRecord(UID, { name: 'Shampoo', price: 200, category: 'productos_fisicos' }),
      buildProductRecord(UID, { name: 'Pack VIP', price: 2000, category: 'paquetes' }),
    ];
    products.forEach((p, i) => { p.productId = 'p' + i; });
    const text = buildCatalogText(products, { title: 'Salon Menu' });
    expect(text).toContain('Salon Menu');
    expect(text).toContain('servicios');
    expect(text).toContain('Corte');
    expect(text).toContain('Shampoo');
  });
  test('searchProductsLocal filtra por precio y categoria', () => {
    const products = [
      buildProductRecord(UID, { name: 'Basico', price: 200, category: 'servicios' }),
      buildProductRecord(UID, { name: 'Pro', price: 800, category: 'servicios' }),
      buildProductRecord(UID, { name: 'Gel', price: 150, category: 'productos_fisicos' }),
    ];
    products.forEach((p, i) => { p.productId = 'p' + i; });
    const r = searchProductsLocal(products, '', { category: 'servicios', maxPrice: 500 });
    expect(r.length).toBe(1);
    expect(r[0].name).toBe('Basico');
  });
  test('computeProductAvailability con stock 0 no disponible', () => {
    const p = buildProductRecord(UID, { name: 'X', stock: 0 });
    const avail = computeProductAvailability(p);
    expect(avail.available).toBe(false);
    expect(avail.reason).toBe('stock_agotado');
  });
});

// ─── COUPON ENGINE ────────────────────────────────────────────────────────────
describe('coupon_engine — bloque 16', () => {
  test('saveCoupon + validateCoupon round-trip', async () => {
    const db = makeMockDb();
    setAll(db);
    const c = buildCouponRecord(UID, 'PROMO30', 'percentage', 30, { maxUses: 100 });
    await saveCoupon(UID, c);
    setAll(db);
    const v = await validateCoupon(UID, 'PROMO30', 500);
    expect(v.valid).toBe(true);
    expect(v.discount).toBe(150);
  });
  test('computeDiscount fixed con minOrderAmount', () => {
    const c = buildCouponRecord(UID, 'FIXED50', 'fixed', 50, { minOrderAmount: 100 });
    expect(computeDiscount(c, 200)).toBe(50);
    expect(computeDiscount(c, 50)).toBe(0);
  });
  test('redeemCoupon reduce uses y actualiza status', async () => {
    const c = buildCouponRecord(UID, 'USE1', 'percentage', 10, { maxUses: 1 });
    const db = makeMockDb({ stored: { [c.couponId]: c } });
    setAll(db);
    const r = await redeemCoupon(UID, 'USE1', PHONE);
    expect(r.newCount).toBe(1);
    expect(r.newStatus).toBe('depleted');
  });
});

// ─── PIPELINE INTEGRADO ───────────────────────────────────────────────────────
describe('Pipeline P4: venta con descuento, stock actualizado y pago registrado', () => {
  test('flujo completo Piso 4 — venta con cupon + stock + pago', async () => {
    const db = makeMockDb();
    setAll(db);

    // 1. Crear producto en catalogo
    const product = buildProductRecord(UID, {
      name: 'Corte de Pelo Premium', price: 800, currency: 'ARS', category: 'servicios',
    });
    await saveProduct(UID, product);

    // 2. Crear y guardar inventario del producto
    const inventory = buildInventoryRecord(UID, product.productId, {
      quantity: 20, productName: product.name, unit: 'turno',
    });
    setAll(db);
    await saveInventory(UID, inventory);

    // 3. Crear y guardar cupon
    const coupon = buildCouponRecord(UID, 'SALON20', 'percentage', 20, { maxUses: 50 });
    setAll(db);
    await saveCoupon(UID, coupon);

    // 4. Cliente llega: validar cupon
    setAll(db);
    const validation = await validateCoupon(UID, 'SALON20', product.price);
    expect(validation.valid).toBe(true);
    expect(validation.discount).toBe(160);

    // 5. Crear pago con descuento
    const payment = buildPaymentRecord(UID, {
      amount: product.price,
      discountAmount: validation.discount,
      currency: 'ARS',
      method: 'transfer',
      contactPhone: PHONE,
      contactName: 'Ricardo',
      couponId: coupon.couponId,
      appointmentId: 'appt_001',
    });
    expect(computePaymentTotal(payment)).toBe(640);
    const validation2 = validatePaymentData({ amount: payment.amount, currency: payment.currency });
    expect(validation2.valid).toBe(true);
    setAll(db);
    const paymentId = await savePayment(UID, payment);
    expect(paymentId).toBe(payment.paymentId);

    // 6. Confirmar pago
    setAll(db);
    await updatePaymentStatus(UID, paymentId, 'confirmed');

    // 7. Canjear cupon
    setAll(db);
    const redemption = await redeemCoupon(UID, 'SALON20', PHONE);
    expect(redemption.newCount).toBe(1);

    // 8. Descontar stock del producto (out)
    setAll(db);
    const currentInv = await getInventory(UID, product.productId);
    const outMovement = buildMovementRecord(UID, product.productId, 'out', 1, {
      referenceId: paymentId,
      notes: 'Venta con cupon SALON20',
    });
    const updatedInv = applyMovement(currentInv, outMovement);
    expect(updatedInv.quantity).toBe(19);
    setAll(db);
    await updateInventoryQuantity(UID, product.productId, updatedInv.quantity);
    setAll(db);
    await saveMovement(UID, outMovement);

    // 9. Verificar estado final del inventario
    setAll(db);
    const finalInv = await getInventory(UID, product.productId);
    expect(finalInv.quantity).toBe(19);
    const avail = computeAvailableQuantity(finalInv);
    expect(avail).toBe(19);
    const alerts = checkStockAlerts(finalInv);
    expect(alerts).toHaveLength(0);

    // 10. Verificar texto del pago
    setAll(db);
    const loadedPayment = await getPayment(UID, paymentId);
    expect(loadedPayment.status).toBe('confirmed');
    const payText = buildPaymentText(loadedPayment);
    expect(payText).toContain('640');
    expect(payText).toContain('SALON20');

    // 11. Verificar textos
    const invText = buildInventoryText(finalInv);
    expect(invText).toContain('19');
    expect(invText).toContain('OK');

    const paymentSummary = buildPaymentSummaryText([loadedPayment], { timeframe: 'hoy' });
    expect(paymentSummary).toContain('hoy');
  });
});
