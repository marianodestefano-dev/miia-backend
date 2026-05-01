'use strict';

/**
 * T295 — payment_engine tests
 * Pagos: métodos, estados, procesamiento, reintegros, expiración,
 * cuotas, stats, summary text, CRUD mock Firestore
 */

const {
  buildPaymentRecord,
  processPayment,
  markProcessing,
  cancelPayment,
  buildRefundRecord,
  applyRefund,
  isExpired,
  computePaymentStats,
  buildPaymentSummaryText,
  savePayment,
  getPayment,
  updatePayment,
  saveRefund,
  listPaymentsByContact,
  listPaymentsByStatus,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  REFUND_STATUSES,
  MAX_INSTALLMENTS,
  PAYMENT_EXPIRY_MS,
  __setFirestoreForTests: setPayDb,
} = require('../core/payment_engine');

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

const UID = 'owner_pay_001';
const PHONE = '+541155554001';

describe('T295 — payment_engine: pagos + reintegros + stats', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setPayDb(mock.db);
  });

  // ─── Constantes ──────────────────────────────────────────────────────────

  test('constantes exportadas correctas', () => {
    expect(PAYMENT_METHODS).toContain('mercadopago');
    expect(PAYMENT_METHODS).toContain('cash');
    expect(PAYMENT_METHODS).toContain('card_credit');
    expect(PAYMENT_STATUSES).toContain('pending');
    expect(PAYMENT_STATUSES).toContain('completed');
    expect(PAYMENT_STATUSES).toContain('refunded');
    expect(REFUND_STATUSES).toContain('pending');
    expect(MAX_INSTALLMENTS).toBeGreaterThanOrEqual(12);
    expect(PAYMENT_EXPIRY_MS).toBeGreaterThan(0);
  });

  // ─── buildPaymentRecord ───────────────────────────────────────────────────

  test('buildPaymentRecord valores por defecto', () => {
    const p = buildPaymentRecord(UID, { amount: 5000 });
    expect(p.uid).toBe(UID);
    expect(p.amount).toBe(5000);
    expect(p.status).toBe('pending');
    expect(p.method).toBe('other');
    expect(p.currency).toBe('ARS');
    expect(p.installments).toBe(1);
    expect(p.installmentAmount).toBe(5000);
    expect(p.amountReceived).toBe(0);
    expect(p.amountRefunded).toBe(0);
    expect(p.paidAt).toBeNull();
    expect(typeof p.paymentId).toBe('string');
    expect(p.expiresAt).toBeGreaterThan(Date.now());
  });

  test('buildPaymentRecord metodo valido', () => {
    const p = buildPaymentRecord(UID, { amount: 10000, method: 'mercadopago' });
    expect(p.method).toBe('mercadopago');
  });

  test('buildPaymentRecord metodo invalido cae a other', () => {
    const p = buildPaymentRecord(UID, { amount: 1000, method: 'monedas_de_fantasía' });
    expect(p.method).toBe('other');
  });

  test('buildPaymentRecord con cuotas calcula installmentAmount', () => {
    const p = buildPaymentRecord(UID, { amount: 12000, method: 'card_credit', installments: 3 });
    expect(p.installments).toBe(3);
    expect(p.installmentAmount).toBe(4000); // 12000/3
  });

  test('buildPaymentRecord cuotas clampeadas a MAX_INSTALLMENTS', () => {
    const p = buildPaymentRecord(UID, { amount: 100000, installments: 100 });
    expect(p.installments).toBe(MAX_INSTALLMENTS);
  });

  test('buildPaymentRecord amount negativo clampeado a 0', () => {
    const p = buildPaymentRecord(UID, { amount: -500 });
    expect(p.amount).toBe(0);
  });

  test('buildPaymentRecord datos de contacto', () => {
    const p = buildPaymentRecord(UID, {
      amount: 8000,
      method: 'transfer',
      contactPhone: PHONE,
      contactName: 'Roberto Sosa',
      orderId: 'order_001',
    });
    expect(p.contactPhone).toBe(PHONE);
    expect(p.contactName).toBe('Roberto Sosa');
    expect(p.orderId).toBe('order_001');
  });

  // ─── markProcessing ───────────────────────────────────────────────────────

  test('markProcessing pending → processing', () => {
    const p = buildPaymentRecord(UID, { amount: 5000, method: 'mercadopago' });
    const processing = markProcessing(p);
    expect(processing.status).toBe('processing');
  });

  test('markProcessing desde estado no-pending lanza error', () => {
    const p = buildPaymentRecord(UID, { amount: 5000, status: 'completed' });
    expect(() => markProcessing(p)).toThrow('only_pending_can_start_processing');
  });

  // ─── processPayment ───────────────────────────────────────────────────────

  test('processPayment exitoso → completed', () => {
    const p = buildPaymentRecord(UID, { amount: 10000, method: 'mercadopago' });
    const completed = processPayment(p, { success: true, amountReceived: 10000, externalId: 'MP-ABC123' });

    expect(completed.status).toBe('completed');
    expect(completed.amountReceived).toBe(10000);
    expect(completed.externalId).toBe('MP-ABC123');
    expect(completed.paidAt).toBeGreaterThan(0);
    expect(completed.errorCode).toBeNull();
  });

  test('processPayment fallido → failed con error', () => {
    const p = buildPaymentRecord(UID, { amount: 10000, method: 'card_credit' });
    const failed = processPayment(p, {
      success: false,
      errorCode: 'insufficient_funds',
      errorMessage: 'Fondos insuficientes en la tarjeta',
    });

    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('insufficient_funds');
    expect(failed.errorMessage).toContain('Fondos');
    expect(failed.failedAt).toBeGreaterThan(0);
  });

  test('processPayment exitoso sin amountReceived usa amount del pago', () => {
    const p = buildPaymentRecord(UID, { amount: 7500, method: 'cash' });
    const completed = processPayment(p, { success: true });
    expect(completed.amountReceived).toBe(7500);
    expect(completed.status).toBe('completed');
  });

  // ─── cancelPayment ────────────────────────────────────────────────────────

  test('cancelPayment desde pending', () => {
    const p = buildPaymentRecord(UID, { amount: 3000 });
    const cancelled = cancelPayment(p);
    expect(cancelled.status).toBe('cancelled');
  });

  test('cancelPayment desde completed lanza error', () => {
    const p = buildPaymentRecord(UID, { amount: 3000, status: 'completed' });
    expect(() => cancelPayment(p)).toThrow('cannot_cancel_completed');
  });

  test('cancelPayment desde cancelled lanza error', () => {
    const p = buildPaymentRecord(UID, { amount: 3000, status: 'cancelled' });
    expect(() => cancelPayment(p)).toThrow('cannot_cancel_cancelled');
  });

  // ─── buildRefundRecord ────────────────────────────────────────────────────

  test('buildRefundRecord valores correctos', () => {
    const r = buildRefundRecord(UID, 'pay_001', {
      amount: 2500,
      currency: 'ARS',
      reason: 'Producto defectuoso',
    });
    expect(r.uid).toBe(UID);
    expect(r.paymentId).toBe('pay_001');
    expect(r.amount).toBe(2500);
    expect(r.reason).toContain('defectuoso');
    expect(r.status).toBe('pending');
    expect(r.processedAt).toBeNull();
    expect(typeof r.refundId).toBe('string');
  });

  // ─── applyRefund ─────────────────────────────────────────────────────────

  test('applyRefund parcial → partially_refunded', () => {
    let p = buildPaymentRecord(UID, { amount: 10000, method: 'card_credit' });
    p = processPayment(p, { success: true, amountReceived: 10000 });

    const refunded = applyRefund(p, 3000);
    expect(refunded.amountRefunded).toBe(3000);
    expect(refunded.status).toBe('partially_refunded');
    expect(refunded.refundedAt).toBeNull(); // no es reintegro total
  });

  test('applyRefund total → refunded', () => {
    let p = buildPaymentRecord(UID, { amount: 5000 });
    p = processPayment(p, { success: true, amountReceived: 5000 });

    const refunded = applyRefund(p, 5000);
    expect(refunded.amountRefunded).toBe(5000);
    expect(refunded.status).toBe('refunded');
    expect(refunded.refundedAt).toBeGreaterThan(0);
  });

  test('applyRefund doble: parcial + completar', () => {
    let p = buildPaymentRecord(UID, { amount: 6000 });
    p = processPayment(p, { success: true, amountReceived: 6000 });

    p = applyRefund(p, 2000);
    expect(p.status).toBe('partially_refunded');
    p = applyRefund(p, 4000);
    expect(p.status).toBe('refunded');
    expect(p.amountRefunded).toBe(6000);
  });

  test('applyRefund excede amountReceived lanza error', () => {
    let p = buildPaymentRecord(UID, { amount: 5000 });
    p = processPayment(p, { success: true, amountReceived: 5000 });
    expect(() => applyRefund(p, 6000)).toThrow('refund_exceeds_amount_received');
  });

  test('applyRefund en pago no completado lanza error', () => {
    const p = buildPaymentRecord(UID, { amount: 5000 });
    expect(() => applyRefund(p, 1000)).toThrow('cannot_refund_pending');
  });

  test('applyRefund amount invalido lanza error', () => {
    let p = buildPaymentRecord(UID, { amount: 5000 });
    p = processPayment(p, { success: true, amountReceived: 5000 });
    expect(() => applyRefund(p, 0)).toThrow('invalid_refund_amount');
    expect(() => applyRefund(p, -100)).toThrow('invalid_refund_amount');
  });

  // ─── isExpired ────────────────────────────────────────────────────────────

  test('isExpired pending con expiresAt pasado → true', () => {
    const p = buildPaymentRecord(UID, { amount: 1000, expiresAt: Date.now() - 1000 });
    expect(isExpired(p)).toBe(true);
  });

  test('isExpired pending con expiresAt futuro → false', () => {
    const p = buildPaymentRecord(UID, { amount: 1000 });
    expect(isExpired(p)).toBe(false);
  });

  test('isExpired completed → false aunque expiresAt pasó', () => {
    const p = buildPaymentRecord(UID, { amount: 1000, status: 'completed', expiresAt: Date.now() - 1000 });
    expect(isExpired(p)).toBe(false);
  });

  // ─── computePaymentStats ─────────────────────────────────────────────────

  test('computePaymentStats lista vacia', () => {
    const stats = computePaymentStats([]);
    expect(stats.total).toBe(0);
    expect(stats.successRate).toBe(0);
    expect(stats.totalCollected).toBe(0);
  });

  test('computePaymentStats con pagos variados', () => {
    let p1 = buildPaymentRecord(UID, { amount: 10000, method: 'mercadopago' });
    let p2 = buildPaymentRecord(UID, { amount: 5000, method: 'mercadopago' });
    let p3 = buildPaymentRecord(UID, { amount: 8000, method: 'cash' });
    let p4 = buildPaymentRecord(UID, { amount: 3000, method: 'transfer' });

    p1 = processPayment(p1, { success: true, amountReceived: 10000 });
    p2 = processPayment(p2, { success: true, amountReceived: 5000 });
    p3 = processPayment(p3, { success: false, errorCode: 'declined' });
    // p4 queda pending

    const stats = computePaymentStats([p1, p2, p3, p4]);
    expect(stats.total).toBe(4);
    expect(stats.completedCount).toBe(2);
    expect(stats.failedCount).toBe(1);
    // successRate: 2/(2+1) = 66.67%
    expect(stats.successRate).toBeCloseTo(66.67, 1);
    expect(stats.totalCollected).toBe(15000); // 10000+5000
    expect(stats.byMethod.mercadopago).toBe(2);
    expect(stats.byMethod.cash).toBe(1);
    expect(stats.avgAmount).toBe(6500); // (10000+5000+8000+3000)/4
  });

  // ─── buildPaymentSummaryText ──────────────────────────────────────────────

  test('buildPaymentSummaryText null', () => {
    expect(buildPaymentSummaryText(null)).toContain('no encontrado');
  });

  test('buildPaymentSummaryText pago completado', () => {
    let p = buildPaymentRecord(UID, {
      amount: 25000,
      method: 'mercadopago',
      contactName: 'Ana Gomez',
      installments: 3,
    });
    p = processPayment(p, { success: true, amountReceived: 25000 });
    const text = buildPaymentSummaryText(p);
    expect(text).toContain('COMPLETED');
    expect(text).toContain('mercadopago');
    expect(text).toContain('25.000');
    expect(text).toContain('Ana Gomez');
    expect(text).toContain('3x');
  });

  test('buildPaymentSummaryText pago fallido con error', () => {
    let p = buildPaymentRecord(UID, { amount: 5000, method: 'card_credit' });
    p = processPayment(p, { success: false, errorCode: 'declined', errorMessage: 'Tarjeta rechazada' });
    const text = buildPaymentSummaryText(p);
    expect(text).toContain('FAILED');
    expect(text).toContain('Tarjeta rechazada');
  });

  // ─── CRUD Firestore mock ─────────────────────────────────────────────────

  test('savePayment y getPayment round-trip', async () => {
    const p = buildPaymentRecord(UID, { amount: 15000, method: 'transfer', contactPhone: PHONE });
    const id = await savePayment(UID, p);
    expect(id).toBe(p.paymentId);

    const retrieved = await getPayment(UID, p.paymentId);
    expect(retrieved).not.toBeNull();
    expect(retrieved.amount).toBe(15000);
    expect(retrieved.method).toBe('transfer');
  });

  test('getPayment inexistente retorna null', async () => {
    const result = await getPayment(UID, 'pay_no_existe_9999');
    expect(result).toBeNull();
  });

  test('updatePayment modifica status', async () => {
    const p = buildPaymentRecord(UID, { amount: 7000, method: 'cash' });
    await savePayment(UID, p);
    await updatePayment(UID, p.paymentId, { status: 'completed', amountReceived: 7000 });
    const updated = await getPayment(UID, p.paymentId);
    expect(updated.status).toBe('completed');
    expect(updated.amountReceived).toBe(7000);
  });

  test('saveRefund y listPaymentsByContact', async () => {
    const p1 = buildPaymentRecord(UID, { amount: 5000, method: 'mercadopago', contactPhone: PHONE });
    const p2 = buildPaymentRecord(UID, { amount: 8000, method: 'cash', contactPhone: PHONE });
    const p3 = buildPaymentRecord(UID, { amount: 3000, method: 'transfer', contactPhone: '+54999' });
    await savePayment(UID, p1);
    await savePayment(UID, p2);
    await savePayment(UID, p3);

    const payments = await listPaymentsByContact(UID, PHONE);
    expect(payments.length).toBe(2);
  });

  test('listPaymentsByStatus filtra pending', async () => {
    const p1 = buildPaymentRecord(UID, { amount: 1000, status: 'pending' });
    let p2 = buildPaymentRecord(UID, { amount: 2000 });
    p2 = processPayment(p2, { success: true, amountReceived: 2000 });
    await savePayment(UID, p1);
    await savePayment(UID, p2);

    const pending = await listPaymentsByStatus(UID, 'pending');
    expect(pending.length).toBe(1);
    const completed = await listPaymentsByStatus(UID, 'completed');
    expect(completed.length).toBe(1);
  });

  // ─── Pipeline E2E ─────────────────────────────────────────────────────────

  test('Pipeline completo — pago MercadoPago con cuotas + reintegro parcial', async () => {
    // 1. Crear pago en cuotas
    let pago = buildPaymentRecord(UID, {
      amount: 36000,
      method: 'mercadopago',
      installments: 3,
      contactPhone: PHONE,
      contactName: 'Maria Gutierrez',
      orderId: 'order_cuotas_001',
      description: 'Tratamiento premium 3 sesiones',
    });

    expect(pago.installments).toBe(3);
    expect(pago.installmentAmount).toBe(12000);
    expect(pago.status).toBe('pending');

    // 2. Iniciar procesamiento
    pago = markProcessing(pago);
    expect(pago.status).toBe('processing');

    // 3. Pago exitoso
    pago = processPayment(pago, {
      success: true,
      amountReceived: 36000,
      externalId: 'MP-12345678',
    });
    expect(pago.status).toBe('completed');
    expect(pago.paidAt).toBeGreaterThan(0);
    expect(pago.externalId).toBe('MP-12345678');

    // 4. Guardar
    await savePayment(UID, pago);
    const saved = await getPayment(UID, pago.paymentId);
    expect(saved.status).toBe('completed');

    // 5. Reintegro parcial (sesion cancelada)
    const refund = buildRefundRecord(UID, pago.paymentId, {
      amount: 12000,
      reason: 'Sesion 3 cancelada por el cliente',
    });
    pago = applyRefund(pago, 12000);
    expect(pago.status).toBe('partially_refunded');
    expect(pago.amountRefunded).toBe(12000);

    await saveRefund(UID, refund);

    // 6. Stats
    const stats = computePaymentStats([pago]);
    expect(stats.totalCollected).toBe(36000);
    expect(stats.totalRefunded).toBe(12000);
    expect(stats.completedCount).toBe(1); // partially_refunded cuenta como completado

    // 7. Summary
    const text = buildPaymentSummaryText(pago);
    expect(text).toContain('mercadopago');
    expect(text).toContain('36.000');
    expect(text).toContain('12.000'); // reintegrado
    expect(text).toContain('Maria Gutierrez');
  });
});
