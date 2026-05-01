'use strict';

/**
 * T357 -- E2E Bloque 54
 * Pipeline: inventory_engine -> payment_tracker -> subscription_engine
 */

const {
  buildProductRecord, adjustStock,
  checkLowStock, isOutOfStock, computeInventoryStats,
} = require('../core/inventory_engine');

const {
  buildPaymentRecord, computePaymentSummary, isOverdue,
} = require('../core/payment_tracker');

const {
  buildSubscriptionRecord, computeSubscriptionPrice,
  pauseSubscription, resumeSubscription, cancelSubscription,
  recordBilling, computeNextBillingDate, CYCLE_DAYS,
} = require('../core/subscription_engine');

const UID = 'owner_bloque54_001';
const PHONE = '+5718889999';

describe('T357 -- E2E Bloque 54: inventory_engine + payment_tracker + subscription_engine', () => {

  test('Paso 1 -- agregar producto al inventario con stock 50', () => {
    const p = buildProductRecord(UID, { sku: 'SERV001', stock: 50, unitPrice: 200 });
    expect(p.status).toBe('active');
    expect(p.stock).toBe(50);
  });

  test('Paso 2 -- vender 5 unidades, verificar stock y totalSold', () => {
    const p = buildProductRecord(UID, { sku: 'SERV002', stock: 10, unitPrice: 150 });
    const updated = adjustStock(p, -5, 'sale');
    expect(updated.stock).toBe(5);
    expect(updated.totalSold).toBe(5);
    expect(updated.totalRevenue).toBeCloseTo(750, 1);
  });

  test('Paso 3 -- registrar pago por la venta', () => {
    const payment = buildPaymentRecord(UID, PHONE, 750, { method: 'transfer', currency: 'COP', status: 'confirmed' });
    expect(payment.status).toBe('confirmed');
    expect(payment.amount).toBe(750);
    expect(payment.currency).toBe('COP');
  });

  test('Paso 4 -- computePaymentSummary de 3 pagos', () => {
    const payments = [
      buildPaymentRecord(UID, PHONE, 100, { status: 'confirmed', currency: 'USD' }),
      buildPaymentRecord(UID, PHONE, 200, { status: 'pending', currency: 'USD' }),
      buildPaymentRecord(UID, PHONE, 150, { status: 'confirmed', currency: 'USD' }),
    ];
    const summary = computePaymentSummary(payments);
    expect(summary.confirmed).toBe(2);
    expect(summary.pending).toBe(1);
    expect(summary.currencies.USD.confirmed).toBe(250);
  });

  test('Paso 5 -- crear suscripcion mensual con descuento', () => {
    const sub = buildSubscriptionRecord(UID, { price: 49, billingCycle: 'monthly', discountPercent: 20 });
    expect(sub.status).toBe('active');
    expect(sub.billingCycle).toBe('monthly');
    const price = computeSubscriptionPrice(sub);
    expect(price).toBeCloseTo(39.2, 1); // 49 * 0.8
  });

  test('Paso 6 -- ciclo de vida suscripcion: active -> paused -> active -> cancelled', () => {
    const sub = buildSubscriptionRecord(UID, { price: 99, billingCycle: 'monthly' });
    const paused = pauseSubscription(sub);
    expect(paused.status).toBe('paused');
    const resumed = resumeSubscription(paused);
    expect(resumed.status).toBe('active');
    const cancelled = cancelSubscription(resumed);
    expect(cancelled.status).toBe('cancelled');
  });

  test('Pipeline completo -- inventario + pago + suscripcion', () => {
    // A: Producto con stock bajo
    const prod = buildProductRecord(UID, { stock: 3, lowStockThreshold: 5, unitPrice: 100 });
    expect(checkLowStock(prod)).toBe(true);

    // B: Vender hasta agotar
    const sold = adjustStock(prod, -3, 'sale');
    expect(isOutOfStock(sold)).toBe(true);

    // C: Stats de inventario
    const stats = computeInventoryStats([prod, sold]);
    expect(stats.total).toBe(2);

    // D: Pago por suscripcion
    const pay = buildPaymentRecord(UID, PHONE, 49, { method: 'card', status: 'pending', dueDate: new Date(Date.now() - 1000).toISOString() });
    expect(isOverdue(pay)).toBe(true); // vencido ayer

    // E: Suscripcion con trial
    const sub = buildSubscriptionRecord(UID, { trialDays: 14, price: 29, billingCycle: 'weekly' });
    expect(sub.status).toBe('trial');

    // F: Facturar suscripcion
    const billed = recordBilling(sub, true);
    expect(billed.billingCount).toBe(1);
    const expectedNext = billed.lastBilledAt + CYCLE_DAYS.weekly * 24 * 60 * 60 * 1000;
    expect(billed.nextBillingAt).toBeCloseTo(expectedNext, -3);
  });
});
