'use strict';

// T265 payment_processor — suite completa
const {
  buildPaymentRecord,
  validatePaymentData,
  computePaymentTotal,
  savePayment,
  getPayment,
  updatePaymentStatus,
  listPayments,
  computePaymentSummary,
  buildPaymentText,
  buildPaymentSummaryText,
  PAYMENT_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_CURRENCIES,
  PAYMENT_TYPES,
  __setFirestoreForTests: setDb,
} = require('../core/payment_processor');

const UID = 'payment265Uid';
const PHONE = '+5491155554444';

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

beforeEach(() => setDb(null));
afterEach(() => setDb(null));

// ─── CONSTANTES ──────────────────────────────────────────────────────────────
describe('payment_processor — constantes', () => {
  test('PAYMENT_STATUSES incluye pending, confirmed, refunded, failed', () => {
    ['pending', 'processing', 'confirmed', 'failed', 'refunded', 'cancelled', 'disputed'].forEach(s =>
      expect(PAYMENT_STATUSES).toContain(s)
    );
  });
  test('PAYMENT_METHODS incluye cash, card, mercadopago', () => {
    ['cash', 'transfer', 'card', 'mercadopago', 'paypal', 'stripe'].forEach(m =>
      expect(PAYMENT_METHODS).toContain(m)
    );
  });
  test('PAYMENT_CURRENCIES incluye ARS, USD, COP', () => {
    ['ARS', 'USD', 'COP', 'MXN'].forEach(c =>
      expect(PAYMENT_CURRENCIES).toContain(c)
    );
  });
  test('PAYMENT_TYPES incluye sale y subscription', () => {
    ['sale', 'subscription', 'deposit', 'refund', 'tip'].forEach(t =>
      expect(PAYMENT_TYPES).toContain(t)
    );
  });
});

// ─── buildPaymentRecord ───────────────────────────────────────────────────────
describe('buildPaymentRecord', () => {
  test('defaults correctos', () => {
    const p = buildPaymentRecord(UID, { amount: 1500, currency: 'ARS', method: 'transfer' });
    expect(p.uid).toBe(UID);
    expect(p.amount).toBe(1500);
    expect(p.currency).toBe('ARS');
    expect(p.method).toBe('transfer');
    expect(p.status).toBe('pending');
    expect(p.type).toBe('sale');
    expect(p.discountAmount).toBe(0);
    expect(p.taxAmount).toBe(0);
    expect(p.confirmedAt).toBeNull();
    expect(p.metadata).toEqual({});
  });
  test('amount invalido cae a 0', () => {
    const p = buildPaymentRecord(UID, { amount: -100 });
    expect(p.amount).toBe(0);
  });
  test('currency invalida cae a ARS', () => {
    const p = buildPaymentRecord(UID, { amount: 100, currency: 'XYZ' });
    expect(p.currency).toBe('ARS');
  });
  test('method invalido cae a other', () => {
    const p = buildPaymentRecord(UID, { amount: 100, method: 'bitcoin' });
    expect(p.method).toBe('other');
  });
  test('type invalido cae a sale', () => {
    const p = buildPaymentRecord(UID, { amount: 100, type: 'fake_type' });
    expect(p.type).toBe('sale');
  });
  test('status invalido cae a pending', () => {
    const p = buildPaymentRecord(UID, { amount: 100, status: 'borrado' });
    expect(p.status).toBe('pending');
  });
  test('campos de contacto se guardan', () => {
    const p = buildPaymentRecord(UID, { amount: 100, contactPhone: PHONE, contactName: 'Carlos' });
    expect(p.contactPhone).toBe(PHONE);
    expect(p.contactName).toBe('Carlos');
  });
  test('externalReference se trunca a MAX_REFERENCE_LENGTH=100', () => {
    const longRef = 'REF_' + 'X'.repeat(200);
    const p = buildPaymentRecord(UID, { amount: 100, externalReference: longRef });
    expect(p.externalReference.length).toBe(100);
  });
  test('description se trunca a MAX_PAYMENT_NOTES_LENGTH=500', () => {
    const p = buildPaymentRecord(UID, { amount: 100, description: 'D'.repeat(600) });
    expect(p.description.length).toBe(500);
  });
  test('paymentId se puede forzar', () => {
    const p = buildPaymentRecord(UID, { amount: 100, paymentId: 'pay_custom_001' });
    expect(p.paymentId).toBe('pay_custom_001');
  });
  test('appointmentId y couponId se guardan', () => {
    const p = buildPaymentRecord(UID, { amount: 100, appointmentId: 'appt_001', couponId: 'coupon_001' });
    expect(p.appointmentId).toBe('appt_001');
    expect(p.couponId).toBe('coupon_001');
  });
  test('discountAmount y taxAmount validos se guardan', () => {
    const p = buildPaymentRecord(UID, { amount: 100, discountAmount: 20, taxAmount: 10 });
    expect(p.discountAmount).toBe(20);
    expect(p.taxAmount).toBe(10);
  });
});

// ─── computePaymentTotal ──────────────────────────────────────────────────────
describe('computePaymentTotal', () => {
  test('total = amount + tax - discount', () => {
    const p = buildPaymentRecord(UID, { amount: 1000, taxAmount: 100, discountAmount: 50 });
    expect(computePaymentTotal(p)).toBe(1050);
  });
  test('sin tax ni discount = amount', () => {
    const p = buildPaymentRecord(UID, { amount: 500 });
    expect(computePaymentTotal(p)).toBe(500);
  });
  test('descuento mayor que amount no es negativo', () => {
    const p = buildPaymentRecord(UID, { amount: 100, discountAmount: 200 });
    expect(computePaymentTotal(p)).toBe(0);
  });
  test('null retorna 0', () => {
    expect(computePaymentTotal(null)).toBe(0);
  });
});

// ─── validatePaymentData ──────────────────────────────────────────────────────
describe('validatePaymentData', () => {
  test('valido retorna valid=true', () => {
    const r = validatePaymentData({ amount: 500, currency: 'ARS', method: 'card' });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
  test('amount negativo es invalido', () => {
    const r = validatePaymentData({ amount: -100 });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('amount'))).toBe(true);
  });
  test('currency invalida es invalida', () => {
    const r = validatePaymentData({ amount: 100, currency: 'XYZ' });
    expect(r.valid).toBe(false);
  });
  test('method invalido es invalido', () => {
    const r = validatePaymentData({ amount: 100, method: 'bitcoin' });
    expect(r.valid).toBe(false);
  });
  test('amount 0 es valido', () => {
    const r = validatePaymentData({ amount: 0 });
    expect(r.valid).toBe(true);
  });
});

// ─── savePayment + getPayment ─────────────────────────────────────────────────
describe('savePayment + getPayment', () => {
  test('round-trip exitoso', async () => {
    const db = makeMockDb();
    setDb(db);
    const p = buildPaymentRecord(UID, { amount: 2500, currency: 'ARS', method: 'card', contactPhone: PHONE, contactName: 'Ana' });
    const savedId = await savePayment(UID, p);
    expect(savedId).toBe(p.paymentId);
    const loaded = await getPayment(UID, p.paymentId);
    expect(loaded.amount).toBe(2500);
    expect(loaded.contactName).toBe('Ana');
  });
  test('getPayment retorna null si no existe', async () => {
    setDb(makeMockDb());
    const loaded = await getPayment(UID, 'pay_no_existe');
    expect(loaded).toBeNull();
  });
  test('savePayment con throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    const p = buildPaymentRecord(UID, { amount: 100 });
    await expect(savePayment(UID, p)).rejects.toThrow('set error');
  });
  test('getPayment con throwGet retorna null', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const loaded = await getPayment(UID, 'pay_001');
    expect(loaded).toBeNull();
  });
});

// ─── updatePaymentStatus ──────────────────────────────────────────────────────
describe('updatePaymentStatus', () => {
  test('confirma pago y setea confirmedAt', async () => {
    const db = makeMockDb();
    setDb(db);
    const p = buildPaymentRecord(UID, { amount: 100, paymentId: 'pay_001' });
    await savePayment(UID, p);
    await updatePaymentStatus(UID, 'pay_001', 'confirmed');
    const loaded = await getPayment(UID, 'pay_001');
    expect(loaded.status).toBe('confirmed');
    expect(loaded.confirmedAt).toBeDefined();
  });
  test('falla el pago y setea failedAt', async () => {
    const db = makeMockDb();
    setDb(db);
    const p = buildPaymentRecord(UID, { amount: 100, paymentId: 'pay_002' });
    await savePayment(UID, p);
    await updatePaymentStatus(UID, 'pay_002', 'failed');
    const loaded = await getPayment(UID, 'pay_002');
    expect(loaded.status).toBe('failed');
    expect(loaded.failedAt).toBeDefined();
  });
  test('reembolso setea refundedAt', async () => {
    const db = makeMockDb();
    setDb(db);
    const p = buildPaymentRecord(UID, { amount: 100, paymentId: 'pay_003' });
    await savePayment(UID, p);
    await updatePaymentStatus(UID, 'pay_003', 'refunded');
    const loaded = await getPayment(UID, 'pay_003');
    expect(loaded.status).toBe('refunded');
    expect(loaded.refundedAt).toBeDefined();
  });
  test('status invalido lanza error', async () => {
    setDb(makeMockDb());
    await expect(updatePaymentStatus(UID, 'pay_001', 'fake_status')).rejects.toThrow('status invalido');
  });
  test('throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    await expect(updatePaymentStatus(UID, 'pay_001', 'cancelled')).rejects.toThrow('set error');
  });
});

// ─── listPayments ─────────────────────────────────────────────────────────────
describe('listPayments', () => {
  const makePayments = () => {
    const p1 = buildPaymentRecord(UID, { amount: 100, status: 'confirmed', contactPhone: PHONE });
    const p2 = buildPaymentRecord(UID, { amount: 200, status: 'pending', contactPhone: PHONE });
    const p3 = buildPaymentRecord(UID, { amount: 300, status: 'confirmed', contactPhone: '+5491199999999' });
    p1.paymentId = 'pay_p1'; p2.paymentId = 'pay_p2'; p3.paymentId = 'pay_p3';
    return { p1, p2, p3 };
  };
  test('retorna todos sin filtros', async () => {
    const { p1, p2, p3 } = makePayments();
    setDb(makeMockDb({ stored: { [p1.paymentId]: p1, [p2.paymentId]: p2, [p3.paymentId]: p3 } }));
    const results = await listPayments(UID);
    expect(results.length).toBe(3);
  });
  test('filtra por status', async () => {
    const { p1, p2, p3 } = makePayments();
    setDb(makeMockDb({ stored: { [p1.paymentId]: p1, [p2.paymentId]: p2, [p3.paymentId]: p3 } }));
    const confirmed = await listPayments(UID, { status: 'confirmed' });
    expect(confirmed.every(p => p.status === 'confirmed')).toBe(true);
    expect(confirmed.length).toBe(2);
  });
  test('filtra por contactPhone', async () => {
    const { p1, p2, p3 } = makePayments();
    setDb(makeMockDb({ stored: { [p1.paymentId]: p1, [p2.paymentId]: p2, [p3.paymentId]: p3 } }));
    const mine = await listPayments(UID, { contactPhone: PHONE });
    expect(mine.every(p => p.contactPhone === PHONE)).toBe(true);
  });
  test('throwGet retorna array vacio', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const results = await listPayments(UID);
    expect(results).toEqual([]);
  });
});

// ─── computePaymentSummary ────────────────────────────────────────────────────
describe('computePaymentSummary', () => {
  test('vacio retorna ceros', () => {
    const s = computePaymentSummary([]);
    expect(s.total).toBe(0);
    expect(s.count).toBe(0);
  });
  test('calcula totales correctamente', () => {
    const payments = [
      buildPaymentRecord(UID, { amount: 1000, status: 'confirmed' }),
      buildPaymentRecord(UID, { amount: 500, status: 'confirmed' }),
      buildPaymentRecord(UID, { amount: 200, status: 'pending' }),
      buildPaymentRecord(UID, { amount: 300, status: 'failed' }),
    ];
    const s = computePaymentSummary(payments);
    expect(s.total).toBe(1500);
    expect(s.confirmed).toBe(2);
    expect(s.pending).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.count).toBe(4);
  });
  test('avgAmount solo sobre confirmed', () => {
    const payments = [
      buildPaymentRecord(UID, { amount: 1000, status: 'confirmed' }),
      buildPaymentRecord(UID, { amount: 1000, status: 'confirmed' }),
    ];
    const s = computePaymentSummary(payments);
    expect(s.avgAmount).toBe(1000);
  });
  test('null retorna ceros', () => {
    const s = computePaymentSummary(null);
    expect(s.total).toBe(0);
  });
});

// ─── buildPaymentText ─────────────────────────────────────────────────────────
describe('buildPaymentText', () => {
  test('incluye monto, metodo y estado', () => {
    const p = buildPaymentRecord(UID, { amount: 2000, currency: 'ARS', method: 'card', status: 'confirmed', contactName: 'Luis' });
    const text = buildPaymentText(p);
    expect(text).toContain('2000');
    expect(text).toContain('ARS');
    expect(text).toContain('card');
    expect(text).toContain('confirmed');
    expect(text).toContain('Luis');
  });
  test('incluye cupon si existe', () => {
    const p = buildPaymentRecord(UID, { amount: 100, couponId: 'PROMO20' });
    const text = buildPaymentText(p);
    expect(text).toContain('PROMO20');
  });
  test('incluye descuento si > 0', () => {
    const p = buildPaymentRecord(UID, { amount: 500, discountAmount: 50, currency: 'ARS' });
    const text = buildPaymentText(p);
    expect(text).toContain('-50');
  });
  test('null retorna string vacio', () => {
    expect(buildPaymentText(null)).toBe('');
  });
});

// ─── buildPaymentSummaryText ──────────────────────────────────────────────────
describe('buildPaymentSummaryText', () => {
  test('incluye total recaudado', () => {
    const payments = [
      buildPaymentRecord(UID, { amount: 1000, currency: 'ARS', status: 'confirmed' }),
      buildPaymentRecord(UID, { amount: 500, currency: 'ARS', status: 'confirmed' }),
    ];
    const text = buildPaymentSummaryText(payments, { timeframe: 'mes' });
    expect(text).toContain('1500');
    expect(text).toContain('mes');
    expect(text).toContain('ARS');
  });
  test('incluye conteos por estado', () => {
    const payments = [
      buildPaymentRecord(UID, { amount: 100, currency: 'ARS', status: 'confirmed' }),
      buildPaymentRecord(UID, { amount: 50, currency: 'ARS', status: 'pending' }),
    ];
    const text = buildPaymentSummaryText(payments);
    expect(text).toContain('Confirmados: 1');
    expect(text).toContain('Pendientes: 1');
  });
});
