'use strict';

/**
 * T298 -- E2E Bloque 27
 * Pipeline: cliente reserva turno (appointment) + verifica disponibilidad
 * → cupon descuento aplicado → pago con tarjeta → factura emitida
 * → loyalty points → suscripcion mensual creada → turno completado
 * → stats (payment + appointment por phone)
 */

const {
  buildAppointmentRecord,
  checkConflict,
  buildAvailableSlots,
  saveAppointment,
  getAppointmentsForDate,
  getAppointmentsByPhone,
  updateAppointmentStatus,
  buildAppointmentText,
  __setFirestoreForTests: setApptDb,
} = require('../core/appointment_engine');

const {
  buildCouponRecord,
  validateCoupon,
  computeDiscount,
  applyRedemption,
  __setFirestoreForTests: setCoupDb,
} = require('../core/coupon_engine');

const {
  buildPaymentRecord,
  processPayment,
  markProcessing,
  computePaymentStats,
  __setFirestoreForTests: setPayDb,
} = require('../core/payment_engine');

const {
  buildInvoiceRecord,
  buildLineItem,
  applyPayment,
  buildInvoiceText,
  __setFirestoreForTests: setInvDb,
} = require('../core/invoice_engine');

const {
  buildLoyaltyAccount,
  earnPoints,
  __setFirestoreForTests: setLoyDb,
} = require('../core/loyalty_engine');

const {
  buildSubscriptionRecord,
  computeSubscriptionPrice,
  recordBilling,
  __setFirestoreForTests: setSubDb,
} = require('../core/subscription_engine');

// Mock DB compartido entre engines

function makeMockDb() {
  const store = {};
  return {
    store,
    db: {
      collection: () => ({
        doc: (uid) => ({
          collection: (subCol) => ({
            doc: (id) => ({
              set: async (data, opts) => {
                if (!store[uid]) store[uid] = {};
                if (!store[uid][subCol]) store[uid][subCol] = {};
                if (opts && opts.merge) {
                  store[uid][subCol][id] = { ...(store[uid][subCol][id] || {}), ...data };
                } else {
                  store[uid][subCol][id] = { ...data };
                }
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

const UID = 'owner_bloque27_001';
const PHONE = '+541166660001';
const DATE = '2026-07-10';

describe('T298 -- E2E Bloque 27: appointment + coupon + payment + invoice + loyalty + subscription', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setApptDb(mock.db);
    setCoupDb(mock.db);
    setPayDb(mock.db);
    setInvDb(mock.db);
    setLoyDb(mock.db);
    setSubDb(mock.db);
  });

  // Paso 1: Slots disponibles

  test('Paso 1 -- slots disponibles para el dia del turno', () => {
    const slots = buildAvailableSlots(DATE, [], { workStartHour: 9, workEndHour: 18, durationMin: 60 });
    // 09:00 a 17:00 con 60 min = 9 slots
    expect(slots.length).toBe(9);
    expect(slots[0].datetime).toBe(DATE + 'T09:00');
    expect(slots[8].datetime).toBe(DATE + 'T17:00');
  });

  // Paso 2: Reservar turno + verificar conflicto

  test('Paso 2 -- turno reservado y sin conflicto con slot libre', () => {
    const turno = buildAppointmentRecord(UID, PHONE, DATE + 'T10:00', {
      contactName: 'Valentina Gomez',
      type: 'in_person',
      durationMin: 60,
      price: 8000,
      currency: 'ARS',
      location: 'Clinica Norte',
    });

    expect(turno.status).toBe('pending');
    expect(turno.durationMin).toBe(60);
    expect(turno.endsAtMs).toBe(turno.timestampMs + 60 * 60 * 1000);

    // Verificar sin conflictos
    const conflict = checkConflict(turno, []);
    expect(conflict).toBeNull();
  });

  // Paso 3: Segundo cliente intenta mismo horario → conflicto

  test('Paso 3 -- segundo cliente en mismo horario detecta conflicto', () => {
    const turno1 = buildAppointmentRecord(UID, PHONE, DATE + 'T10:00', { durationMin: 60 });
    const turno2 = buildAppointmentRecord(UID, '+541166660002', DATE + 'T10:30', { durationMin: 60 });

    const conflict = checkConflict(turno2, [turno1]);
    expect(conflict).not.toBeNull();
    expect(conflict.conflict).toBe(true);
    expect(conflict.conflictWith).toBe(turno1.appointmentId);
  });

  // Paso 4: Cupon descuento 15% sobre turno

  test('Paso 4 -- cupon TURNO15 descuento 15% sobre 8000 ARS', () => {
    const coupon = buildCouponRecord(UID, {
      code: 'TURNO15',
      type: 'percent',
      discountPercent: 15,
      minOrderAmount: 5000,
      maxUses: 50,
    });

    const precio = 8000;
    const validation = validateCoupon(coupon, precio);
    expect(validation.valid).toBe(true);

    const descuento = computeDiscount(coupon, precio);
    expect(descuento).toBe(1200); // 15% de 8000

    const finalAmount = precio - descuento;
    expect(finalAmount).toBe(6800);

    const redeemed = applyRedemption(coupon);
    expect(redeemed.currentUses).toBe(1);
  });

  // Paso 5: Pago con tarjeta

  test('Paso 5 -- pago 6800 con tarjeta de credito completado', () => {
    let pago = buildPaymentRecord(UID, {
      amount: 6800,
      method: 'card_credit',
      contactPhone: PHONE,
      contactName: 'Valentina Gomez',
      description: 'Turno clinica 2026-07-10',
    });

    expect(pago.status).toBe('pending');
    pago = markProcessing(pago);
    expect(pago.status).toBe('processing');

    pago = processPayment(pago, { success: true, amountReceived: 6800, externalId: 'CC-B27-001' });
    expect(pago.status).toBe('completed');
    expect(pago.amountReceived).toBe(6800);
    expect(pago.paidAt).toBeGreaterThan(0);
  });

  // Paso 6: Factura emitida

  test('Paso 6 -- factura emitida para el turno pagado', () => {
    const lineItems = [
      buildLineItem({ description: 'Consulta clinica 60 min', quantity: 1, unitPrice: 8000, taxRate: 0 }),
    ];

    let invoice = buildInvoiceRecord(UID, {
      clientPhone: PHONE,
      clientName: 'Valentina Gomez',
      lineItems,
      globalDiscountAmount: 1200,
    });

    expect(invoice.status).toBe('draft');
    expect(invoice.total).toBe(6800); // 8000 - 1200

    const paid = applyPayment(invoice, 6800);
    expect(paid.status).toBe('paid');
    expect(paid.amountDue).toBe(0);

    const text = buildInvoiceText(paid);
    expect(text).toContain('Valentina Gomez');
    expect(text).toContain('paid');
  });

  // Paso 7: Loyalty por el pago

  test('Paso 7 -- loyalty 6800 puntos por turno pagado', () => {
    let account = buildLoyaltyAccount(UID, PHONE, { contactName: 'Valentina Gomez' });
    const result = earnPoints(account, 6800, { source: 'appointment', appointmentDate: DATE });
    account = result.account;
    expect(account.points).toBe(6800);
    expect(account.tier).toBe('platinum'); // 5000-10000 = platinum
  });

  // Paso 8: Suscripcion mensual creada

  test('Paso 8 -- suscripcion mensual creada con descuento 10%', () => {
    let sub = buildSubscriptionRecord(UID, {
      name: 'Plan Mensual Clinica',
      type: 'service',
      billingCycle: 'monthly',
      price: 8000,
      discountPercent: 10,
      contactPhone: PHONE,
      contactName: 'Valentina Gomez',
    });

    expect(sub.status).toBe('active');
    expect(sub.billingCycle).toBe('monthly');

    const priceFinal = computeSubscriptionPrice(sub);
    expect(priceFinal).toBe(7200); // 8000 - 10%

    // Primer cobro exitoso
    sub = recordBilling(sub, true);
    expect(sub.billingCount).toBe(1);
    expect(sub.lastBilledAt).toBeGreaterThan(0);
    expect(sub.nextBillingAt).toBeGreaterThan(sub.lastBilledAt);
  });

  // Paso 9: Turno confirmado y completado

  test('Paso 9 -- turno confirmado y luego completado', async () => {
    const turno = buildAppointmentRecord(UID, PHONE, DATE + 'T10:00', {
      contactName: 'Valentina Gomez',
      durationMin: 60,
    });
    await saveAppointment(UID, turno);

    await updateAppointmentStatus(UID, turno.appointmentId, 'confirmed');
    let stored = mock.store[UID]['appointments'][turno.appointmentId];
    expect(stored.status).toBe('confirmed');
    expect(stored.confirmedAt).toBeGreaterThan(0);

    await updateAppointmentStatus(UID, turno.appointmentId, 'completed');
    stored = mock.store[UID]['appointments'][turno.appointmentId];
    expect(stored.status).toBe('completed');
    expect(stored.completedAt).toBeGreaterThan(0);
  });

  // Pipeline completo integrado

  test('Pipeline completo -- appointment+coupon+payment+invoice+loyalty+subscription', async () => {
    // A. Slots disponibles
    const slots = buildAvailableSlots(DATE, [], { workStartHour: 9, workEndHour: 12, durationMin: 60 });
    expect(slots.length).toBe(3);

    // B. Turno en slot 10:00
    const turno = buildAppointmentRecord(UID, PHONE, DATE + 'T10:00', {
      contactName: 'Valentina Gomez',
      type: 'in_person',
      durationMin: 60,
      price: 8000,
      currency: 'ARS',
    });
    expect(checkConflict(turno, [])).toBeNull();
    await saveAppointment(UID, turno);

    // C. Cupon 15%
    const coupon = buildCouponRecord(UID, {
      code: 'TURNO15', type: 'percent', discountPercent: 15, minOrderAmount: 5000, maxUses: 50,
    });
    const descuento = computeDiscount(coupon, 8000);
    expect(descuento).toBe(1200);
    const finalAmount = 8000 - descuento;
    expect(finalAmount).toBe(6800);

    // D. Pago tarjeta
    let pago = buildPaymentRecord(UID, { amount: finalAmount, method: 'card_credit', contactPhone: PHONE });
    pago = markProcessing(pago);
    pago = processPayment(pago, { success: true, amountReceived: finalAmount });
    expect(pago.status).toBe('completed');

    // E. Factura
    const lineItems = [buildLineItem({ description: 'Consulta 60 min', quantity: 1, unitPrice: 8000, taxRate: 0 })];
    let invoice = buildInvoiceRecord(UID, { clientPhone: PHONE, clientName: 'Valentina Gomez', lineItems, globalDiscountAmount: 1200 });
    invoice = applyPayment(invoice, finalAmount);
    expect(invoice.status).toBe('paid');
    expect(invoice.total).toBe(6800);

    // F. Loyalty
    let account = buildLoyaltyAccount(UID, PHONE, {});
    const earned = earnPoints(account, finalAmount, { source: 'appointment' });
    account = earned.account;
    expect(account.points).toBe(6800);
    expect(account.tier).toBe('platinum');

    // G. Suscripcion mensual
    let sub = buildSubscriptionRecord(UID, {
      name: 'Plan Mensual', type: 'service', billingCycle: 'monthly',
      price: 8000, discountPercent: 10, contactPhone: PHONE,
    });
    expect(computeSubscriptionPrice(sub)).toBe(7200);
    sub = recordBilling(sub, true);
    expect(sub.billingCount).toBe(1);

    // H. Confirmar y completar turno
    await updateAppointmentStatus(UID, turno.appointmentId, 'confirmed');
    await updateAppointmentStatus(UID, turno.appointmentId, 'completed');
    const stored = mock.store[UID]['appointments'][turno.appointmentId];
    expect(stored.status).toBe('completed');

    // I. Turno en Firestore recuperable por fecha
    const apptsPorFecha = await getAppointmentsForDate(UID, DATE);
    expect(apptsPorFecha.length).toBe(1);
    expect(apptsPorFecha[0].phone).toBe(PHONE);

    // J. Stats pago
    const payStats = computePaymentStats([pago]);
    expect(payStats.totalCollected).toBe(6800);
    expect(payStats.completedCount).toBe(1);
    expect(payStats.successRate).toBe(100);

    // K. Texto del turno
    const text = buildAppointmentText({ ...turno, status: 'completed' });
    expect(text).toContain(PHONE);
    expect(text).toContain('10:00');
  });
});
