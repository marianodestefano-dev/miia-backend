'use strict';

const {
  buildProductRecord, adjustStock, reserveStock, releaseReservation,
  checkLowStock, isOutOfStock, getAvailableStock,
  buildMovementRecord, computeInventoryStats,
  PRODUCT_STATUSES, MOVEMENT_TYPES, PRODUCT_CATEGORIES,
  DEFAULT_LOW_STOCK_THRESHOLD, DEFAULT_TAX_RATE,
} = require('../core/inventory_engine');

const {
  buildPaymentRecord, computePaymentSummary, isOverdue, getOverduePayments,
  isValidStatus, isValidMethod, isValidCurrency,
  PAYMENT_STATUSES, PAYMENT_METHODS, PAYMENT_CURRENCIES,
  OVERDUE_THRESHOLD_MS,
} = require('../core/payment_tracker');

const {
  buildSubscriptionRecord, computeSubscriptionPrice,
  computeNextBillingDate, pauseSubscription, resumeSubscription,
  cancelSubscription, recordBilling, isInGracePeriod,
  SUBSCRIPTION_STATUSES, BILLING_CYCLES, SUBSCRIPTION_TYPES,
  CYCLE_DAYS, TRIAL_DAYS_DEFAULT, GRACE_PERIOD_DAYS,
} = require('../core/subscription_engine');

const UID = 'uid_t356';
const PHONE = '+5716667777';

describe('T356 -- inventory_engine + payment_tracker + subscription_engine (33 tests)', () => {

  // ── INVENTORY ENGINE ─────────────────────────────────────────────────────────

  test('PRODUCT_STATUSES/MOVEMENT_TYPES/PRODUCT_CATEGORIES frozen', () => {
    expect(() => { PRODUCT_STATUSES.push('x'); }).toThrow();
    expect(PRODUCT_STATUSES).toContain('active');
    expect(PRODUCT_STATUSES).toContain('out_of_stock');
    expect(() => { MOVEMENT_TYPES.push('x'); }).toThrow();
    expect(MOVEMENT_TYPES).toContain('sale');
    expect(MOVEMENT_TYPES).toContain('purchase');
    expect(() => { PRODUCT_CATEGORIES.push('x'); }).toThrow();
    expect(PRODUCT_CATEGORIES).toContain('product');
    expect(PRODUCT_CATEGORIES).toContain('service');
  });

  test('DEFAULT_LOW_STOCK_THRESHOLD=5, DEFAULT_TAX_RATE=0.21', () => {
    expect(DEFAULT_LOW_STOCK_THRESHOLD).toBe(5);
    expect(DEFAULT_TAX_RATE).toBe(0.21);
  });

  test('buildProductRecord: stock=0 -> out_of_stock', () => {
    const p = buildProductRecord(UID, { sku: 'PROD001', stock: 0 });
    expect(p.status).toBe('out_of_stock');
    expect(p.stock).toBe(0);
  });

  test('buildProductRecord: stock>0 -> active, priceWithTax correcto', () => {
    const p = buildProductRecord(UID, { sku: 'PROD002', stock: 10, unitPrice: 100, taxRate: 0.21 });
    expect(p.status).toBe('active');
    expect(p.stock).toBe(10);
    expect(p.priceWithTax).toBeCloseTo(121, 1);
  });

  test('buildProductRecord: margin calculado', () => {
    const p = buildProductRecord(UID, { unitPrice: 100, costPrice: 60 });
    expect(p.margin).toBeCloseTo(40, 0); // (100-60)/100*100 = 40%
  });

  test('adjustStock: invalid_movement_type lanza', () => {
    const p = buildProductRecord(UID, { stock: 10 });
    expect(() => adjustStock(p, 5, 'invalid_type')).toThrow('invalid_movement_type');
  });

  test('adjustStock: resultado negativo lanza insufficient_stock', () => {
    const p = buildProductRecord(UID, { stock: 3 });
    expect(() => adjustStock(p, -10, 'sale')).toThrow('insufficient_stock');
  });

  test('adjustStock: sale actualiza totalSold y totalRevenue', () => {
    const p = buildProductRecord(UID, { stock: 10, unitPrice: 50 });
    const updated = adjustStock(p, -2, 'sale');
    expect(updated.stock).toBe(8);
    expect(updated.totalSold).toBe(2);
    expect(updated.totalRevenue).toBeCloseTo(100, 1); // 2 * 50
  });

  test('adjustStock: purchase suma stock, no cambia totalSold', () => {
    const p = buildProductRecord(UID, { stock: 5, unitPrice: 50 });
    const updated = adjustStock(p, 20, 'purchase');
    expect(updated.stock).toBe(25);
    expect(updated.totalSold).toBe(0);
  });

  test('reserveStock: mas que disponible lanza insufficient_available_stock', () => {
    const p = buildProductRecord(UID, { stock: 5, reservedStock: 3 });
    // available = 5 - 3 = 2, quiere reservar 3
    expect(() => reserveStock(p, 3)).toThrow('insufficient_available_stock');
  });

  test('checkLowStock/isOutOfStock/getAvailableStock', () => {
    const p = buildProductRecord(UID, { stock: 4, lowStockThreshold: 5 });
    expect(checkLowStock(p)).toBe(true); // stock <= threshold
    expect(isOutOfStock(p)).toBe(false);

    const oos = buildProductRecord(UID, { stock: 0 });
    expect(isOutOfStock(oos)).toBe(true);

    const p2 = buildProductRecord(UID, { stock: 10, reservedStock: 3 });
    expect(getAvailableStock(p2)).toBe(7);
  });

  test('computeInventoryStats: empty array -> zeros', () => {
    const stats = computeInventoryStats([]);
    expect(stats.total).toBe(0);
    expect(stats.activeCount).toBe(0);
    expect(stats.outOfStockCount).toBe(0);
  });

  // ── PAYMENT TRACKER ─────────────────────────────────────────────────────────

  test('PAYMENT_STATUSES/METHODS/CURRENCIES frozen', () => {
    expect(() => { PAYMENT_STATUSES.push('hack'); }).toThrow();
    expect(PAYMENT_STATUSES).toContain('pending');
    expect(PAYMENT_STATUSES).toContain('confirmed');
    expect(PAYMENT_STATUSES).toContain('refunded');
    expect(() => { PAYMENT_METHODS.push('hack'); }).toThrow();
    expect(PAYMENT_METHODS).toContain('cash');
    expect(PAYMENT_METHODS).toContain('mercadopago');
    expect(() => { PAYMENT_CURRENCIES.push('hack'); }).toThrow();
    expect(PAYMENT_CURRENCIES).toContain('USD');
    expect(PAYMENT_CURRENCIES).toContain('COP');
  });

  test('OVERDUE_THRESHOLD_MS = 7 dias en ms', () => {
    expect(OVERDUE_THRESHOLD_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test('buildPaymentRecord: uid null lanza', () => {
    expect(() => buildPaymentRecord(null, PHONE, 100, {})).toThrow('uid requerido');
  });

  test('buildPaymentRecord: amount < 0 lanza', () => {
    expect(() => buildPaymentRecord(UID, PHONE, -50, {})).toThrow('amount invalido');
  });

  test('buildPaymentRecord: defaults method=other, currency=USD, status=pending', () => {
    const p = buildPaymentRecord(UID, PHONE, 500, {});
    expect(p.uid).toBe(UID);
    expect(p.contactPhone).toBe(PHONE);
    expect(p.amount).toBe(500);
    expect(p.method).toBe('other');
    expect(p.currency).toBe('USD');
    expect(p.status).toBe('pending');
    expect(p.paymentId).toBeDefined();
  });

  test('buildPaymentRecord: method/currency validos se respetan', () => {
    const p = buildPaymentRecord(UID, PHONE, 100000, { method: 'mercadopago', currency: 'COP', status: 'confirmed' });
    expect(p.method).toBe('mercadopago');
    expect(p.currency).toBe('COP');
    expect(p.status).toBe('confirmed');
  });

  test('computePaymentSummary: empty -> zeros', () => {
    const s = computePaymentSummary([]);
    expect(s.total).toBe(0);
    expect(s.confirmed).toBe(0);
    expect(s.pending).toBe(0);
  });

  test('computePaymentSummary: 2 confirmed + 1 pending -> correct counts', () => {
    const payments = [
      buildPaymentRecord(UID, PHONE, 100, { status: 'confirmed', currency: 'ARS' }),
      buildPaymentRecord(UID, PHONE, 200, { status: 'confirmed', currency: 'ARS' }),
      buildPaymentRecord(UID, PHONE, 50, { status: 'pending', currency: 'ARS' }),
    ];
    const s = computePaymentSummary(payments);
    expect(s.total).toBe(3);
    expect(s.confirmed).toBe(2);
    expect(s.pending).toBe(1);
    expect(s.currencies.ARS.confirmed).toBe(300);
    expect(s.currencies.ARS.pending).toBe(50);
  });

  test('isOverdue: sin dueDate -> false', () => {
    const p = buildPaymentRecord(UID, PHONE, 100, {});
    expect(isOverdue(p)).toBe(false);
  });

  test('isOverdue: confirmed -> false aunque vencido', () => {
    const past = new Date(Date.now() - 1000000).toISOString();
    const p = buildPaymentRecord(UID, PHONE, 100, { status: 'confirmed', dueDate: past });
    expect(isOverdue(p)).toBe(false);
  });

  test('isOverdue: pending + dueDate pasado -> true', () => {
    const pastDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const p = buildPaymentRecord(UID, PHONE, 100, { dueDate: pastDate });
    expect(isOverdue(p)).toBe(true);
  });

  // ── SUBSCRIPTION ENGINE ─────────────────────────────────────────────────────

  test('SUBSCRIPTION_STATUSES/BILLING_CYCLES/SUBSCRIPTION_TYPES frozen', () => {
    expect(() => { SUBSCRIPTION_STATUSES.push('hack'); }).toThrow();
    expect(SUBSCRIPTION_STATUSES).toContain('active');
    expect(SUBSCRIPTION_STATUSES).toContain('trial');
    expect(SUBSCRIPTION_STATUSES).toContain('cancelled');
    expect(() => { BILLING_CYCLES.push('hack'); }).toThrow();
    expect(BILLING_CYCLES).toContain('monthly');
    expect(BILLING_CYCLES).toContain('annual');
    expect(() => { SUBSCRIPTION_TYPES.push('hack'); }).toThrow();
    expect(SUBSCRIPTION_TYPES).toContain('service');
  });

  test('CYCLE_DAYS frozen: weekly=7, monthly=30, annual=365', () => {
    expect(() => { CYCLE_DAYS.hack = 1; }).toThrow();
    expect(CYCLE_DAYS.weekly).toBe(7);
    expect(CYCLE_DAYS.monthly).toBe(30);
    expect(CYCLE_DAYS.annual).toBe(365);
  });

  test('TRIAL_DAYS_DEFAULT=7, GRACE_PERIOD_DAYS=3', () => {
    expect(TRIAL_DAYS_DEFAULT).toBe(7);
    expect(GRACE_PERIOD_DAYS).toBe(3);
  });

  test('buildSubscriptionRecord: con trialDays -> status=trial', () => {
    const s = buildSubscriptionRecord(UID, { trialDays: 7, price: 100 });
    expect(s.status).toBe('trial');
    expect(s.trialEndsAt).toBeDefined();
    expect(s.trialDays).toBe(7);
  });

  test('buildSubscriptionRecord: sin trial -> status=active', () => {
    const s = buildSubscriptionRecord(UID, { price: 50, billingCycle: 'monthly' });
    expect(s.status).toBe('active');
    expect(s.billingCycle).toBe('monthly');
    expect(s.price).toBe(50);
  });

  test('computeNextBillingDate: invalid cycle lanza', () => {
    expect(() => computeNextBillingDate(Date.now(), 'decennial')).toThrow('cycle invalido');
  });

  test('computeNextBillingDate: monthly = +30 dias', () => {
    const now = 1000000000000;
    const next = computeNextBillingDate(now, 'monthly');
    expect(next).toBe(now + 30 * 24 * 60 * 60 * 1000);
  });

  test('computeSubscriptionPrice: con descuento 10% sobre 100 -> 90', () => {
    const s = buildSubscriptionRecord(UID, { price: 100, discountPercent: 10 });
    expect(computeSubscriptionPrice(s)).toBe(90);
  });

  test('pauseSubscription: cancelled lanza; active -> paused', () => {
    const s = buildSubscriptionRecord(UID, {});
    const cancelled = cancelSubscription(s);
    expect(() => pauseSubscription(cancelled)).toThrow();
    // active se puede pausar
    const paused = pauseSubscription(s);
    expect(paused.status).toBe('paused');
  });

  test('resumeSubscription: active lanza; paused -> active', () => {
    const s = buildSubscriptionRecord(UID, {});
    expect(() => resumeSubscription(s)).toThrow('no esta pausada');
    const paused = pauseSubscription(s);
    const resumed = resumeSubscription(paused);
    expect(resumed.status).toBe('active');
  });

  test('cancelSubscription: cancelled lanza; active -> cancelled', () => {
    const s = buildSubscriptionRecord(UID, {});
    const cancelled = cancelSubscription(s);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).toBeDefined();
    expect(() => cancelSubscription(cancelled)).toThrow('ya esta cancelada');
  });

  test('recordBilling: success -> billingCount+1; failure x3 -> expired', () => {
    const s = buildSubscriptionRecord(UID, { price: 50, billingCycle: 'monthly' });
    const billed = recordBilling(s, true);
    expect(billed.billingCount).toBe(1);
    expect(billed.lastBilledAt).toBeDefined();

    // 3 failures -> expired
    let sub = buildSubscriptionRecord(UID, {});
    sub = recordBilling(sub, false);
    sub = recordBilling(sub, false);
    sub = recordBilling(sub, false);
    expect(sub.failedBillingCount).toBe(3);
    expect(sub.status).toBe('expired');
  });
});
