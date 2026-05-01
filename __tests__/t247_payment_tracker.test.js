'use strict';

const {
  buildPaymentRecord, savePayment, updatePaymentStatus,
  getPayments, getPaymentsByPhone, computePaymentSummary,
  isOverdue, getOverduePayments, buildPaymentStatusText, buildPaymentSummaryText,
  isValidStatus, isValidMethod, isValidCurrency,
  PAYMENT_STATUSES, PAYMENT_METHODS, PAYMENT_CURRENCIES,
  MAX_PAYMENTS_PER_QUERY, OVERDUE_THRESHOLD_MS,
  __setFirestoreForTests,
} = require('../core/payment_tracker');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';

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
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return {
              forEach: fn => Object.entries(db_stored).forEach(([id, data]) => fn({ data: () => data })),
            };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

describe('Constantes', () => {
  test('PAYMENT_STATUSES tiene 6', () => { expect(PAYMENT_STATUSES.length).toBe(6); });
  test('frozen PAYMENT_STATUSES', () => { expect(() => { PAYMENT_STATUSES.push('x'); }).toThrow(); });
  test('PAYMENT_METHODS tiene 7', () => { expect(PAYMENT_METHODS.length).toBe(7); });
  test('frozen PAYMENT_METHODS', () => { expect(() => { PAYMENT_METHODS.push('x'); }).toThrow(); });
  test('PAYMENT_CURRENCIES tiene 7', () => { expect(PAYMENT_CURRENCIES.length).toBe(7); });
  test('frozen PAYMENT_CURRENCIES', () => { expect(() => { PAYMENT_CURRENCIES.push('x'); }).toThrow(); });
  test('MAX_PAYMENTS_PER_QUERY es 100', () => { expect(MAX_PAYMENTS_PER_QUERY).toBe(100); });
  test('OVERDUE_THRESHOLD_MS es 7 dias', () => { expect(OVERDUE_THRESHOLD_MS).toBe(7 * 24 * 60 * 60 * 1000); });
});

describe('isValidStatus / isValidMethod / isValidCurrency', () => {
  test('pending es status valido', () => { expect(isValidStatus('pending')).toBe(true); });
  test('deleted no es valido', () => { expect(isValidStatus('deleted')).toBe(false); });
  test('cash es method valido', () => { expect(isValidMethod('cash')).toBe(true); });
  test('bitcoin no es method valido', () => { expect(isValidMethod('bitcoin')).toBe(false); });
  test('ARS es currency valida', () => { expect(isValidCurrency('ARS')).toBe(true); });
  test('EUR no es currency valida', () => { expect(isValidCurrency('EUR')).toBe(false); });
});

describe('buildPaymentRecord', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildPaymentRecord(undefined, PHONE, 100)).toThrow('uid requerido');
  });
  test('lanza si contactPhone undefined', () => {
    expect(() => buildPaymentRecord(UID, undefined, 100)).toThrow('contactPhone requerido');
  });
  test('lanza si amount invalido (negativo)', () => {
    expect(() => buildPaymentRecord(UID, PHONE, -10)).toThrow('amount invalido');
  });
  test('lanza si amount no es numero', () => {
    expect(() => buildPaymentRecord(UID, PHONE, 'cien')).toThrow('amount invalido');
  });
  test('construye record con defaults', () => {
    const r = buildPaymentRecord(UID, PHONE, 1000);
    expect(r.paymentId).toMatch(/^pay_/);
    expect(r.uid).toBe(UID);
    expect(r.contactPhone).toBe(PHONE);
    expect(r.amount).toBe(1000);
    expect(r.currency).toBe('USD');
    expect(r.method).toBe('other');
    expect(r.status).toBe('pending');
    expect(r.paidAt).toBeNull();
    expect(r.createdAt).toBeDefined();
  });
  test('acepta amount = 0', () => {
    const r = buildPaymentRecord(UID, PHONE, 0);
    expect(r.amount).toBe(0);
  });
  test('aplica opts correctamente', () => {
    const r = buildPaymentRecord(UID, PHONE, 5000, {
      currency: 'ARS', method: 'mercadopago', status: 'confirmed',
      description: 'Pago mensual plan pro', reference: 'REF-001',
    });
    expect(r.currency).toBe('ARS');
    expect(r.method).toBe('mercadopago');
    expect(r.status).toBe('confirmed');
    expect(r.description).toBe('Pago mensual plan pro');
    expect(r.reference).toBe('REF-001');
  });
  test('method invalido cae a other', () => {
    const r = buildPaymentRecord(UID, PHONE, 100, { method: 'barter' });
    expect(r.method).toBe('other');
  });
});

describe('savePayment', () => {
  test('lanza si uid undefined', async () => {
    await expect(savePayment(undefined, { paymentId: 'x' })).rejects.toThrow('uid requerido');
  });
  test('lanza si record invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(savePayment(UID, null)).rejects.toThrow('record invalido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = buildPaymentRecord(UID, PHONE, 2000, { currency: 'ARS' });
    const id = await savePayment(UID, r);
    expect(id).toBe(r.paymentId);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const r = buildPaymentRecord(UID, PHONE, 100);
    await expect(savePayment(UID, r)).rejects.toThrow('set error');
  });
});

describe('updatePaymentStatus', () => {
  test('lanza si uid undefined', async () => {
    await expect(updatePaymentStatus(undefined, 'pay1', 'confirmed')).rejects.toThrow('uid requerido');
  });
  test('lanza si paymentId undefined', async () => {
    await expect(updatePaymentStatus(UID, undefined, 'confirmed')).rejects.toThrow('paymentId requerido');
  });
  test('lanza si status invalido', async () => {
    await expect(updatePaymentStatus(UID, 'pay1', 'paid')).rejects.toThrow('status invalido');
  });
  test('actualiza a confirmed sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updatePaymentStatus(UID, 'pay1', 'confirmed')).resolves.toBeUndefined();
  });
  test('acepta notes en opts', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updatePaymentStatus(UID, 'pay1', 'partial', { notes: 'Pago parcial 50%' })).resolves.toBeUndefined();
  });
});

describe('getPayments', () => {
  test('lanza si uid undefined', async () => {
    await expect(getPayments(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna vacio si no hay pagos', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getPayments(UID)).toEqual([]);
  });
  test('filtra por status', async () => {
    const stored = {
      'pay_1': buildPaymentRecord(UID, PHONE, 1000),
      'pay_2': { ...buildPaymentRecord(UID, PHONE, 500), status: 'confirmed' },
    };
    __setFirestoreForTests(makeMockDb({ stored }));
    const r = await getPayments(UID, { status: 'confirmed' });
    expect(r.length).toBe(1);
    expect(r[0].status).toBe('confirmed');
  });
  test('filtra por phone', async () => {
    const p1 = buildPaymentRecord(UID, PHONE, 1000);
    const p2 = buildPaymentRecord(UID, '+541199999999', 500);
    __setFirestoreForTests(makeMockDb({ stored: { [p1.paymentId]: p1, [p2.paymentId]: p2 } }));
    const r = await getPayments(UID, { phone: PHONE });
    expect(r.length).toBe(1);
    expect(r[0].contactPhone).toBe(PHONE);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getPayments(UID)).toEqual([]);
  });
});

describe('getPaymentsByPhone', () => {
  test('lanza si phone undefined', async () => {
    await expect(getPaymentsByPhone(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('retorna pagos del phone', async () => {
    const p = buildPaymentRecord(UID, PHONE, 300);
    __setFirestoreForTests(makeMockDb({ stored: { [p.paymentId]: p } }));
    const r = await getPaymentsByPhone(UID, PHONE);
    expect(r.length).toBe(1);
  });
});

describe('computePaymentSummary', () => {
  test('array vacio retorna zeros', () => {
    const s = computePaymentSummary([]);
    expect(s.total).toBe(0);
    expect(s.confirmed).toBe(0);
    expect(s.pending).toBe(0);
  });
  test('null retorna zeros', () => {
    const s = computePaymentSummary(null);
    expect(s.total).toBe(0);
  });
  test('calcula correctamente por status y currency', () => {
    const payments = [
      { amount: 1000, currency: 'ARS', status: 'confirmed' },
      { amount: 500, currency: 'ARS', status: 'pending' },
      { amount: 100, currency: 'USD', status: 'confirmed' },
      { amount: 200, currency: 'USD', status: 'failed' },
    ];
    const s = computePaymentSummary(payments);
    expect(s.total).toBe(4);
    expect(s.confirmed).toBe(2);
    expect(s.pending).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.currencies.ARS.confirmed).toBe(1000);
    expect(s.currencies.ARS.pending).toBe(500);
    expect(s.currencies.USD.confirmed).toBe(100);
  });
  test('partial cuenta como confirmed', () => {
    const payments = [{ amount: 750, currency: 'USD', status: 'partial' }];
    const s = computePaymentSummary(payments);
    expect(s.confirmed).toBe(1);
    expect(s.currencies.USD.confirmed).toBe(750);
  });
});

describe('isOverdue / getOverduePayments', () => {
  test('retorna false si payment null', () => {
    expect(isOverdue(null)).toBe(false);
  });
  test('retorna false si sin dueDate', () => {
    expect(isOverdue({ status: 'pending' })).toBe(false);
  });
  test('retorna false si confirmado aunque vencido', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(isOverdue({ dueDate: past, status: 'confirmed' })).toBe(false);
  });
  test('retorna true si vencido y pendiente', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(isOverdue({ dueDate: past, status: 'pending' })).toBe(true);
  });
  test('retorna false si no vencido', () => {
    const future = new Date(Date.now() + 100000).toISOString();
    expect(isOverdue({ dueDate: future, status: 'pending' })).toBe(false);
  });
  test('getOverduePayments filtra vencidos', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 100000).toISOString();
    const payments = [
      { paymentId: 'p1', dueDate: past, status: 'pending', amount: 100, currency: 'USD' },
      { paymentId: 'p2', dueDate: future, status: 'pending', amount: 200, currency: 'USD' },
      { paymentId: 'p3', dueDate: past, status: 'confirmed', amount: 50, currency: 'USD' },
    ];
    const overdue = getOverduePayments(payments);
    expect(overdue.length).toBe(1);
    expect(overdue[0].paymentId).toBe('p1');
  });
});

describe('buildPaymentStatusText / buildPaymentSummaryText', () => {
  test('buildPaymentStatusText retorna vacio si null', () => {
    expect(buildPaymentStatusText(null)).toBe('');
  });
  test('buildPaymentStatusText incluye info clave', () => {
    const p = buildPaymentRecord(UID, PHONE, 5000, { currency: 'ARS', method: 'transfer', description: 'Plan anual' });
    const text = buildPaymentStatusText(p);
    expect(text).toContain(PHONE);
    expect(text).toContain('5');
    expect(text).toContain('ARS');
    expect(text).toContain('transfer');
    expect(text).toContain('Plan anual');
  });
  test('buildPaymentStatusText tiene emoji por status', () => {
    const confirmed = buildPaymentRecord(UID, PHONE, 100, { status: 'confirmed' });
    confirmed.amount = 100;
    expect(buildPaymentStatusText(confirmed)).toContain('✅');
  });
  test('buildPaymentSummaryText retorna vacio si null', () => {
    expect(buildPaymentSummaryText(UID, null)).toBe('');
  });
  test('buildPaymentSummaryText incluye resumen', () => {
    const summary = computePaymentSummary([
      { amount: 1000, currency: 'ARS', status: 'confirmed' },
      { amount: 500, currency: 'ARS', status: 'pending' },
    ]);
    const text = buildPaymentSummaryText(UID, summary);
    expect(text).toContain('2');
    expect(text).toContain('ARS');
    expect(text).toContain('1');
  });
});
