'use strict';

/**
 * T294 — E2E Bloque 25
 * Pipeline: inventario productos → venta registrada → cupon por compra minima →
 * stock bajo dispara automation → CRM contacto comprador tageado → loyalty
 * points por compra → stats inventario + automation logs
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
  __setFirestoreForTests: setInvDb,
} = require('../core/inventory_engine');

const {
  buildAutomationRule,
  buildCondition,
  buildActionRecord,
  shouldTrigger,
  recordExecution,
  buildExecutionLog,
  computeAutomationStats,
  __setFirestoreForTests: setAutoDb,
} = require('../core/automation_engine');

const {
  buildCouponRecord,
  validateCoupon,
  computeDiscount,
  applyRedemption,
  __setFirestoreForTests: setCoupDb,
} = require('../core/coupon_engine');

const {
  buildCrmContact,
  addTag,
  computeLeadScore,
  __setFirestoreForTests: setCrmDb,
} = require('../core/crm_engine');

const {
  buildLoyaltyAccount,
  earnPoints,
  computeTier,
  __setFirestoreForTests: setLoyDb,
} = require('../core/loyalty_engine');

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

const UID = 'owner_bloque25_001';
const PHONE_CLIENT = '+541155553001';

describe('T294 — E2E Bloque 25: inventario + automation + coupon + CRM + loyalty', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setInvDb(mock.db);
    setAutoDb(mock.db);
    setCoupDb(mock.db);
    setCrmDb(mock.db);
    setLoyDb(mock.db);
  });

  // ─── Paso 1: Productos en inventario ────────────────────────────────────

  test('Paso 1 — catálogo de 3 productos creado', () => {
    const p1 = buildProductRecord(UID, { sku: 'MASK-500', name: 'Mascarilla Hidratante', unitPrice: 8500, costPrice: 4500, stock: 30 });
    const p2 = buildProductRecord(UID, { sku: 'SERUM-30', name: 'Serum Vitamina C', unitPrice: 15000, costPrice: 8000, stock: 15 });
    const p3 = buildProductRecord(UID, { sku: 'TONER-100', name: 'Toner Equilibrante', unitPrice: 6000, costPrice: 3000, stock: 0 });

    expect(p1.status).toBe('active');
    expect(p2.status).toBe('active');
    expect(p3.status).toBe('out_of_stock');

    const stats = computeInventoryStats([p1, p2, p3]);
    expect(stats.total).toBe(3);
    expect(stats.activeCount).toBe(2);
    expect(stats.outOfStockCount).toBe(1);
  });

  // ─── Paso 2: Venta de productos ──────────────────────────────────────────

  test('Paso 2 — venta de 3 mascarillas + 2 serums', () => {
    let mask = buildProductRecord(UID, { sku: 'MASK-500', unitPrice: 8500, costPrice: 4500, stock: 30 });
    let serum = buildProductRecord(UID, { sku: 'SERUM-30', unitPrice: 15000, costPrice: 8000, stock: 15 });

    mask = adjustStock(mask, -3, 'sale');
    serum = adjustStock(serum, -2, 'sale');

    expect(mask.totalSold).toBe(3);
    expect(mask.totalRevenue).toBe(25500); // 3 * 8500
    expect(serum.totalSold).toBe(2);
    expect(serum.totalRevenue).toBe(30000); // 2 * 15000

    // Total de la venta del cliente
    const orderTotal = mask.unitPrice * 3 + serum.unitPrice * 2;
    expect(orderTotal).toBe(55500);
  });

  // ─── Paso 3: Cupon por compra minima ─────────────────────────────────────

  test('Paso 3 — cupon 10% activado por compra >= 50000 ARS', () => {
    const coupon = buildCouponRecord(UID, {
      code: 'COMPRA50K',
      type: 'percent',
      discountPercent: 10,
      minOrderAmount: 50000,
      maxUses: 100,
    });

    // Compra de 55500 califica
    const validation = validateCoupon(coupon, 55500);
    expect(validation.valid).toBe(true);

    const discount = computeDiscount(coupon, 55500);
    expect(discount).toBe(5550); // 10% de 55500

    const finalAmount = 55500 - discount;
    expect(finalAmount).toBe(49950);
  });

  // ─── Paso 4: Stock bajo → automation dispara alerta ──────────────────────

  test('Paso 4 — serum cae a stock bajo → automation dispara', () => {
    let serum = buildProductRecord(UID, { sku: 'SERUM-30', unitPrice: 15000, stock: 5, lowStockThreshold: 3 });

    // Vender 3: stock = 2 → low stock
    serum = adjustStock(serum, -3, 'sale');
    expect(serum.stock).toBe(2);
    expect(checkLowStock(serum)).toBe(true);

    // Regla automation para stock bajo
    const ruleLowStock = buildAutomationRule(UID, {
      name: 'Alerta Stock Bajo',
      triggerType: 'custom',
      conditions: [
        buildCondition({ field: 'stockLevel', operator: '<=', value: 3 }),
        buildCondition({ field: 'sku', operator: '==', value: 'SERUM-30' }),
      ],
      actions: [
        buildActionRecord({ type: 'send_notification', params: { channel: 'email', message: 'Stock bajo de SERUM-30!' } }),
        buildActionRecord({ type: 'create_task', params: { task: 'Reordenar SERUM-30', priority: 'high' } }),
      ],
    });

    const ctx = { stockLevel: serum.stock, sku: serum.sku };
    expect(shouldTrigger(ruleLowStock, 'custom', ctx, null)).toBe(true);

    const executed = recordExecution(ruleLowStock);
    expect(executed.executionCount).toBe(1);
  });

  // ─── Paso 5: CRM contacto tageado como cliente VIP ───────────────────────

  test('Paso 5 — comprador tageado como cliente VIP en CRM', () => {
    let contact = buildCrmContact(UID, {
      phone: PHONE_CLIENT,
      name: 'Valentina Lopez',
      source: 'whatsapp',
      stage: 'won',
      dealValue: 55500,
    });

    contact = addTag(contact, 'cliente_recurrente');
    contact = addTag(contact, 'compra_premium');
    expect(contact.tags).toContain('cliente_recurrente');
    expect(contact.tags).toContain('compra_premium');

    const score = computeLeadScore(contact);
    expect(score).toBeGreaterThan(80); // won + deal + tags
  });

  // ─── Paso 6: Loyalty por compra ──────────────────────────────────────────

  test('Paso 6 — loyalty 49950 puntos por compra final (post-cupon)', () => {
    // Compra 55500 - cupon 5550 = 49950
    let account = buildLoyaltyAccount(UID, PHONE_CLIENT, { contactName: 'Valentina Lopez' });
    const result = earnPoints(account, 49950, { source: 'purchase', orderId: 'order_bloque25_001' });
    account = result.account;

    expect(account.points).toBe(49950);
    expect(computeTier(49950)).toBe('diamond'); // >10000
    expect(account.tier).toBe('diamond');
  });

  // ─── Paso 7: Reorden de stock → automation desactivada ───────────────────

  test('Paso 7 — reorden recibido → stock repuesto → automation en pausa', () => {
    let serum = buildProductRecord(UID, { sku: 'SERUM-30', stock: 2, lowStockThreshold: 3 });
    expect(checkLowStock(serum)).toBe(true);

    // Reorden: +20 unidades
    const mov = buildMovementRecord(UID, serum.productId, {
      type: 'purchase',
      quantity: 20,
      stockBefore: 2,
      stockAfter: 22,
      reference: 'REORDEN-SERUM-001',
    });
    serum = adjustStock(serum, 20, 'purchase');
    expect(serum.stock).toBe(22);
    expect(checkLowStock(serum)).toBe(false);
    expect(isOutOfStock(serum)).toBe(false);

    expect(mov.type).toBe('purchase');
    expect(mov.reference).toBe('REORDEN-SERUM-001');
  });

  // ─── Paso 8: Stats inventario completo ───────────────────────────────────

  test('Paso 8 — stats inventario post-ventas y reorden', () => {
    let mask = buildProductRecord(UID, { sku: 'MASK-500', unitPrice: 8500, costPrice: 4500, stock: 30 });
    let serum = buildProductRecord(UID, { sku: 'SERUM-30', unitPrice: 15000, costPrice: 8000, stock: 15 });
    let toner = buildProductRecord(UID, { sku: 'TONER-100', unitPrice: 6000, costPrice: 3000, stock: 0 });

    // Ventas
    mask = adjustStock(mask, -3, 'sale');
    serum = adjustStock(serum, -5, 'sale');

    const stats = computeInventoryStats([mask, serum, toner]);
    expect(stats.totalSold).toBe(8); // 3 + 5
    expect(stats.totalRevenue).toBe(25500 + 75000); // 3*8500 + 5*15000 = 25500+75000 = 100500
    expect(stats.outOfStockCount).toBe(1); // toner
    // stockValue: mask=(27*4500=121500) + serum=(10*8000=80000) + toner=0
    expect(stats.totalStockValue).toBe(201500);
  });

  // ─── Paso 9: Automation logs stats ───────────────────────────────────────

  test('Paso 9 — automation stats: 5 alertas stock + 3 campanas', () => {
    const ruleId1 = 'rule_stock_alert';
    const ruleId2 = 'rule_campaign_trigger';
    const logs = [];

    for (let i = 0; i < 5; i++) {
      logs.push(buildExecutionLog(UID, ruleId1, {
        triggerType: 'custom',
        success: true,
        actionsExecuted: ['send_notification', 'create_task'],
        durationMs: 50,
      }));
    }
    for (let i = 0; i < 3; i++) {
      logs.push(buildExecutionLog(UID, ruleId2, {
        triggerType: 'first_purchase',
        success: i < 2, // 2 ok, 1 fail
        durationMs: 100,
      }));
    }

    const stats = computeAutomationStats(logs);
    expect(stats.total).toBe(8);
    expect(stats.successCount).toBe(7);
    expect(stats.failureCount).toBe(1);
    expect(stats.successRate).toBe(87.5);
    expect(stats.byTrigger.custom).toBe(5);
    expect(stats.byTrigger.first_purchase).toBe(3);
  });

  // ─── Pipeline completo integrado ─────────────────────────────────────────

  test('Pipeline completo — inventario+automation+coupon+CRM+loyalty', () => {
    // A. Catálogo
    let mask = buildProductRecord(UID, { sku: 'MASK-500', name: 'Mascarilla', unitPrice: 8500, costPrice: 4500, stock: 10, lowStockThreshold: 3 });
    expect(mask.status).toBe('active');
    expect(mask.priceWithTax).toBeCloseTo(10285, 0); // 8500 * 1.21

    // B. Reservar para pedido
    mask = reserveStock(mask, 3);
    expect(getAvailableStock(mask)).toBe(7);

    // C. Vender 8 (3 reservadas + 5 mas)
    mask = releaseReservation(mask, 3);
    mask = adjustStock(mask, -8, 'sale');
    expect(mask.stock).toBe(2);
    expect(checkLowStock(mask)).toBe(true); // 2 <= 3

    // D. Automation: stock bajo → alerta
    const rule = buildAutomationRule(UID, {
      triggerType: 'custom',
      conditions: [buildCondition({ field: 'stockLevel', operator: '<=', value: 3 })],
      actions: [buildActionRecord({ type: 'create_task', params: { task: 'Reordenar' } })],
      cooldownMs: 0,
    });
    expect(shouldTrigger(rule, 'custom', { stockLevel: mask.stock }, null)).toBe(true);
    const ruleExecuted = recordExecution(rule);
    expect(ruleExecuted.executionCount).toBe(1);

    // E. Cupon por total de compra
    const orderTotal = 8 * mask.unitPrice; // 8 * 8500 = 68000
    const coupon = buildCouponRecord(UID, {
      code: 'BULK10',
      type: 'percent',
      discountPercent: 10,
      minOrderAmount: 50000,
      maxUses: 1,
    });
    expect(validateCoupon(coupon, orderTotal).valid).toBe(true);
    const discount = computeDiscount(coupon, orderTotal);
    expect(discount).toBe(6800); // 10% de 68000
    const finalAmount = orderTotal - discount;
    expect(finalAmount).toBe(61200);

    // F. CRM
    let contact = buildCrmContact(UID, { phone: PHONE_CLIENT, name: 'Cliente Test', stage: 'won', dealValue: finalAmount });
    contact = addTag(contact, 'compra_bulk');
    expect(contact.tags).toContain('compra_bulk');
    expect(computeLeadScore(contact)).toBeGreaterThan(80);

    // G. Loyalty: 61200 puntos
    let account = buildLoyaltyAccount(UID, PHONE_CLIENT, {});
    const earned = earnPoints(account, finalAmount, { source: 'purchase' });
    account = earned.account;
    expect(account.points).toBe(61200);
    expect(account.tier).toBe('diamond');

    // H. Inventory stats
    const stats = computeInventoryStats([mask]);
    expect(stats.totalSold).toBe(8);
    expect(stats.totalRevenue).toBe(68000);
    expect(stats.lowStockCount).toBe(1);

    // I. Movement record
    const mov = buildMovementRecord(UID, mask.productId, {
      type: 'sale',
      quantity: -8,
      stockBefore: 10,
      stockAfter: 2,
      reference: 'SALE-BULK-001',
    });
    expect(mov.type).toBe('sale');
    expect(mov.reference).toBe('SALE-BULK-001');

    // J. Summary
    const text = buildProductSummaryText(mask);
    expect(text).toContain('MASK-500');
    expect(text).toContain('Stock bajo');
  });
});
