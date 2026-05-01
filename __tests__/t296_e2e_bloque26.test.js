'use strict';

/**
 * T296 — E2E Bloque 26
 * Pipeline: cliente pide productos → inventario reserva → pago MercadoPago
 * con cupon → pago completado → stock ajustado → factura emitida →
 * loyalty points → reintegro parcial por producto defectuoso → stats
 */

const {
  buildProductRecord,
  adjustStock,
  reserveStock,
  releaseReservation,
  getAvailableStock,
  buildMovementRecord,
  computeInventoryStats,
  __setFirestoreForTests: setInvDb,
} = require('../core/inventory_engine');

const {
  buildPaymentRecord,
  processPayment,
  markProcessing,
  applyRefund,
  buildRefundRecord,
  computePaymentStats,
  buildPaymentSummaryText,
  __setFirestoreForTests: setPayDb,
} = require('../core/payment_engine');

const {
  buildInvoiceRecord,
  buildLineItem,
  computeInvoiceTotals,
  applyPayment,
  buildInvoiceText,
  __setFirestoreForTests: setInvEngDb,
} = require('../core/invoice_engine');

const {
  buildCouponRecord,
  validateCoupon,
  computeDiscount,
  applyRedemption,
  __setFirestoreForTests: setCoupDb,
} = require('../core/coupon_engine');

const {
  buildLoyaltyAccount,
  earnPoints,
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

const UID = 'owner_bloque26_001';
const PHONE = '+541155555001';

describe('T296 — E2E Bloque 26: pago + inventario + factura + cupon + loyalty', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setInvDb(mock.db);
    setPayDb(mock.db);
    setInvEngDb(mock.db);
    setCoupDb(mock.db);
    setLoyDb(mock.db);
  });

  // ─── Paso 1: Productos en catálogo ───────────────────────────────────────

  test('Paso 1 — productos disponibles en inventario', () => {
    const prod1 = buildProductRecord(UID, { sku: 'CREMA-200', name: 'Crema Hidratante', unitPrice: 4500, costPrice: 2000, stock: 20 });
    const prod2 = buildProductRecord(UID, { sku: 'TONICO-100', name: 'Tonico Facial', unitPrice: 6500, costPrice: 3000, stock: 10 });

    expect(prod1.status).toBe('active');
    expect(prod2.status).toBe('active');
    expect(getAvailableStock(prod1)).toBe(20);
    expect(getAvailableStock(prod2)).toBe(10);
  });

  // ─── Paso 2: Cliente pide → inventario reserva ───────────────────────────

  test('Paso 2 — cliente pide 2 cremas + 1 tonico → stock reservado', () => {
    let crema = buildProductRecord(UID, { sku: 'CREMA-200', unitPrice: 4500, stock: 20 });
    let tonico = buildProductRecord(UID, { sku: 'TONICO-100', unitPrice: 6500, stock: 10 });

    crema = reserveStock(crema, 2);
    tonico = reserveStock(tonico, 1);

    expect(crema.reservedStock).toBe(2);
    expect(getAvailableStock(crema)).toBe(18);
    expect(tonico.reservedStock).toBe(1);
    expect(getAvailableStock(tonico)).toBe(9);

    // Total pedido: 2*4500 + 1*6500 = 15500
    const orderTotal = 2 * 4500 + 1 * 6500;
    expect(orderTotal).toBe(15500);
  });

  // ─── Paso 3: Cupon 10% aplicado ──────────────────────────────────────────

  test('Paso 3 — cupon WELCOME10 aplicado al pedido', () => {
    const coupon = buildCouponRecord(UID, {
      code: 'WELCOME10',
      type: 'percent',
      discountPercent: 10,
      minOrderAmount: 10000,
      maxUses: 1,
    });

    const orderTotal = 15500;
    expect(validateCoupon(coupon, orderTotal).valid).toBe(true);
    const discount = computeDiscount(coupon, orderTotal);
    expect(discount).toBe(1550); // 10% de 15500

    const finalAmount = orderTotal - discount;
    expect(finalAmount).toBe(13950);

    const redeemed = applyRedemption(coupon);
    expect(redeemed.status).toBe('exhausted');
  });

  // ─── Paso 4: Pago MercadoPago ────────────────────────────────────────────

  test('Paso 4 — pago 13950 via MercadoPago completado', () => {
    let pago = buildPaymentRecord(UID, {
      amount: 13950,
      method: 'mercadopago',
      contactPhone: PHONE,
      contactName: 'Daniela Perez',
      orderId: 'order_bloque26_001',
    });

    expect(pago.status).toBe('pending');
    pago = markProcessing(pago);
    expect(pago.status).toBe('processing');

    pago = processPayment(pago, { success: true, amountReceived: 13950, externalId: 'MP-B26-001' });
    expect(pago.status).toBe('completed');
    expect(pago.amountReceived).toBe(13950);
    expect(pago.paidAt).toBeGreaterThan(0);
  });

  // ─── Paso 5: Stock ajustado post-pago ────────────────────────────────────

  test('Paso 5 — stock ajustado: reserva liberada y venta registrada', () => {
    let crema = buildProductRecord(UID, { sku: 'CREMA-200', unitPrice: 4500, costPrice: 2000, stock: 20 });
    let tonico = buildProductRecord(UID, { sku: 'TONICO-100', unitPrice: 6500, costPrice: 3000, stock: 10 });

    // Reservar
    crema = reserveStock(crema, 2);
    tonico = reserveStock(tonico, 1);

    // Pago completado → liberar reserva y registrar venta
    crema = releaseReservation(crema, 2);
    tonico = releaseReservation(tonico, 1);
    crema = adjustStock(crema, -2, 'sale');
    tonico = adjustStock(tonico, -1, 'sale');

    expect(crema.stock).toBe(18);
    expect(crema.totalSold).toBe(2);
    expect(crema.totalRevenue).toBe(9000); // 2 * 4500
    expect(tonico.stock).toBe(9);
    expect(tonico.totalSold).toBe(1);
    expect(tonico.totalRevenue).toBe(6500);
  });

  // ─── Paso 6: Factura emitida ──────────────────────────────────────────────

  test('Paso 6 — factura emitida por la venta', () => {
    const lineItems = [
      buildLineItem({ description: 'Crema Hidratante x2', quantity: 2, unitPrice: 4500, taxRate: 0 }),
      buildLineItem({ description: 'Tonico Facial x1', quantity: 1, unitPrice: 6500, taxRate: 0 }),
    ];

    const totals = computeInvoiceTotals(lineItems, { globalDiscountAmount: 1550 });
    expect(totals.subtotal).toBe(15500); // 9000+6500
    expect(totals.total).toBe(13950); // 15500 - 1550, sin IVA

    let invoice = buildInvoiceRecord(UID, {
      clientPhone: PHONE,
      clientName: 'Daniela Perez',
      lineItems,
      globalDiscountAmount: 1550,
    });
    expect(invoice.status).toBe('draft');
    expect(invoice.total).toBe(13950);

    // Marcar como pagada
    const paid = applyPayment(invoice, 13950);
    expect(paid.status).toBe('paid');
    expect(paid.amountDue).toBe(0);

    const text = buildInvoiceText(paid);
    expect(text).toContain('Daniela Perez');
    expect(text).toContain('paid');
  });

  // ─── Paso 7: Loyalty por la compra ───────────────────────────────────────

  test('Paso 7 — loyalty 13950 puntos por compra', () => {
    let account = buildLoyaltyAccount(UID, PHONE, { contactName: 'Daniela Perez' });
    const result = earnPoints(account, 13950, { source: 'purchase', orderId: 'order_bloque26_001' });
    account = result.account;
    expect(account.points).toBe(13950);
    expect(account.tier).toBe('diamond'); // >10000
  });

  // ─── Paso 8: Reintegro parcial por producto defectuoso ───────────────────

  test('Paso 8 — reintegro 4500 (1 crema defectuosa) + stock devuelto', () => {
    let pago = buildPaymentRecord(UID, { amount: 13950, method: 'mercadopago' });
    pago = processPayment(pago, { success: true, amountReceived: 13950 });

    // Reintegro de 1 crema
    pago = applyRefund(pago, 4500);
    expect(pago.status).toBe('partially_refunded');
    expect(pago.amountRefunded).toBe(4500);

    const refund = buildRefundRecord(UID, pago.paymentId, {
      amount: 4500,
      reason: 'Crema defectuosa, envio erroneo',
    });
    expect(refund.amount).toBe(4500);

    // Devolver stock
    let crema = buildProductRecord(UID, { sku: 'CREMA-200', unitPrice: 4500, stock: 18 });
    crema = adjustStock(crema, 1, 'return');
    expect(crema.stock).toBe(19);
  });

  // ─── Pipeline completo integrado ─────────────────────────────────────────

  test('Pipeline completo — inventario+pago+factura+cupon+loyalty+reintegro', () => {
    // A. Productos
    let crema = buildProductRecord(UID, { sku: 'CREMA-200', name: 'Crema', unitPrice: 4500, costPrice: 2000, stock: 20 });
    let tonico = buildProductRecord(UID, { sku: 'TONICO-100', name: 'Tonico', unitPrice: 6500, costPrice: 3000, stock: 10 });

    // B. Pedido: 2 cremas + 1 tonico
    crema = reserveStock(crema, 2);
    tonico = reserveStock(tonico, 1);
    const orderTotal = 2 * 4500 + 1 * 6500; // 15500
    expect(orderTotal).toBe(15500);

    // C. Cupon 10%
    const coupon = buildCouponRecord(UID, {
      code: 'BIENVE10', type: 'percent', discountPercent: 10, minOrderAmount: 10000, maxUses: 1,
    });
    const discount = computeDiscount(coupon, orderTotal);
    expect(discount).toBe(1550);
    const finalAmount = orderTotal - discount;
    expect(finalAmount).toBe(13950);

    // D. Pago
    let pago = buildPaymentRecord(UID, { amount: finalAmount, method: 'mercadopago', contactPhone: PHONE });
    pago = markProcessing(pago);
    pago = processPayment(pago, { success: true, amountReceived: finalAmount });
    expect(pago.status).toBe('completed');

    // E. Liberar reservas y vender
    crema = releaseReservation(crema, 2);
    tonico = releaseReservation(tonico, 1);
    crema = adjustStock(crema, -2, 'sale');
    tonico = adjustStock(tonico, -1, 'sale');
    expect(crema.reservedStock).toBe(0);
    expect(tonico.reservedStock).toBe(0);

    // F. Factura
    const lineItems = [
      buildLineItem({ description: 'Crema x2', quantity: 2, unitPrice: 4500, taxRate: 0 }),
      buildLineItem({ description: 'Tonico x1', quantity: 1, unitPrice: 6500, taxRate: 0 }),
    ];
    let invoice = buildInvoiceRecord(UID, { contactPhone: PHONE, lineItems, globalDiscountAmount: discount });
    expect(invoice.total).toBe(finalAmount); // 15500 - 1550 = 13950
    invoice = applyPayment(invoice, finalAmount);
    expect(invoice.status).toBe('paid');

    // G. Loyalty
    let account = buildLoyaltyAccount(UID, PHONE, {});
    const earned = earnPoints(account, finalAmount, { source: 'purchase' });
    account = earned.account;
    expect(account.points).toBe(13950);
    expect(account.tier).toBe('diamond');

    // H. Reintegro por defecto
    pago = applyRefund(pago, 4500);
    expect(pago.amountRefunded).toBe(4500);
    expect(pago.status).toBe('partially_refunded');

    // I. Stats inventario
    const invStats = computeInventoryStats([crema, tonico]);
    expect(invStats.totalSold).toBe(3); // 2+1
    expect(invStats.totalRevenue).toBe(15500); // 9000+6500

    // J. Stats pago
    const payStats = computePaymentStats([pago]);
    expect(payStats.totalCollected).toBe(13950);
    expect(payStats.totalRefunded).toBe(4500);

    // K. Summary
    const text = buildPaymentSummaryText(pago);
    expect(text).toContain('mercadopago');
    expect(text).toContain('13.950');
  });
});
