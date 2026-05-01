'use strict';

const {
  createPreference, getPaymentStatus, processWebhook,
  getPaymentHistory, isPaymentApproved,
  PAYMENT_STATUSES, SUPPORTED_CURRENCIES, MAX_ITEMS_PER_PREFERENCE,
  __setFirestoreForTests, __setHttpClientForTests,
} = require('../core/mercadopago_v2');

const UID = 'testUid1234567890';
const ITEM = { title: 'Producto test', unit_price: 100, quantity: 1 };
const PREFERENCE = { items: [ITEM] };
const MP_PREF_RESP = { id: 'pref123', init_point: 'https://mp.com/pay', sandbox_init_point: 'https://sandbox.mp.com/pay' };
const MP_PAYMENT_RESP = { id: 'pay456', status: 'approved', transaction_amount: 100, currency_id: 'ARS', payer: { email: 'test@test.com' } };

function makeMockDb({ throwSet = false } = {}) {
  const payDoc = {
    set: async (data, opts) => { if (throwSet) throw new Error('set error'); },
    get: async () => ({ forEach: fn => {} }),
  };
  const paymentsColl = {
    doc: () => payDoc,
    get: async () => ({ forEach: fn => {} }),
  };
  const prefsColl = {
    doc: () => payDoc,
    get: async () => ({ forEach: fn => {} }),
  };
  const subDoc = {
    collection: (name) => {
      if (name === 'payments') return paymentsColl;
      return prefsColl;
    },
  };
  return {
    collection: (name) => ({ doc: () => subDoc }),
  };
}

function makeHttpClient(response) {
  return async (url, body, headers, signal) => response;
}

beforeEach(() => {
  __setFirestoreForTests(null);
  __setHttpClientForTests(null);
  delete process.env.MERCADOPAGO_ACCESS_TOKEN;
});
afterEach(() => {
  __setFirestoreForTests(null);
  __setHttpClientForTests(null);
  delete process.env.MERCADOPAGO_ACCESS_TOKEN;
});

describe('PAYMENT_STATUSES y constants', () => {
  test('incluye approved y rejected', () => {
    expect(PAYMENT_STATUSES).toContain('approved');
    expect(PAYMENT_STATUSES).toContain('rejected');
  });
  test('es frozen', () => {
    expect(() => { PAYMENT_STATUSES.push('nuevo'); }).toThrow();
  });
  test('SUPPORTED_CURRENCIES incluye ARS y BRL', () => {
    expect(SUPPORTED_CURRENCIES).toContain('ARS');
    expect(SUPPORTED_CURRENCIES).toContain('BRL');
  });
  test('MAX_ITEMS_PER_PREFERENCE es 50', () => {
    expect(MAX_ITEMS_PER_PREFERENCE).toBe(50);
  });
});

describe('createPreference', () => {
  test('lanza si uid undefined', async () => {
    await expect(createPreference(undefined, PREFERENCE)).rejects.toThrow('uid requerido');
  });
  test('lanza si preference undefined', async () => {
    await expect(createPreference(UID, null)).rejects.toThrow('preference requerido');
  });
  test('lanza si items vacio', async () => {
    await expect(createPreference(UID, { items: [] })).rejects.toThrow('items requerido');
  });
  test('lanza si item sin title', async () => {
    await expect(createPreference(UID, { items: [{ unit_price: 10, quantity: 1 }] })).rejects.toThrow('item.title requerido');
  });
  test('lanza si item.unit_price invalido', async () => {
    await expect(createPreference(UID, { items: [{ title: 'X', unit_price: 0, quantity: 1 }] })).rejects.toThrow('unit_price');
  });
  test('lanza si item.quantity invalido', async () => {
    await expect(createPreference(UID, { items: [{ title: 'X', unit_price: 10, quantity: 0 }] })).rejects.toThrow('quantity');
  });
  test('lanza si sin ACCESS_TOKEN', async () => {
    await expect(createPreference(UID, PREFERENCE)).rejects.toThrow('MERCADOPAGO_ACCESS_TOKEN');
  });
  test('crea preferencia con cliente inyectado', async () => {
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'test-token';
    __setFirestoreForTests(makeMockDb());
    __setHttpClientForTests(makeHttpClient(MP_PREF_RESP));
    const r = await createPreference(UID, PREFERENCE);
    expect(r.preferenceId).toBe('pref123');
    expect(r.initPoint).toBeDefined();
  });
  test('lanza si respuesta sin id', async () => {
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'test-token';
    __setFirestoreForTests(makeMockDb());
    __setHttpClientForTests(makeHttpClient({ no_id: true }));
    await expect(createPreference(UID, PREFERENCE)).rejects.toThrow('sin id');
  });
});


describe('getPaymentStatus', () => {
  test('lanza si uid undefined', async () => {
    await expect(getPaymentStatus(undefined, 'pay1')).rejects.toThrow('uid requerido');
  });
  test('lanza si paymentId undefined', async () => {
    await expect(getPaymentStatus(UID, undefined)).rejects.toThrow('paymentId requerido');
  });
  test('lanza si sin ACCESS_TOKEN', async () => {
    await expect(getPaymentStatus(UID, 'pay1')).rejects.toThrow('MERCADOPAGO_ACCESS_TOKEN');
  });
  test('retorna status del pago', async () => {
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'test-token';
    __setHttpClientForTests(makeHttpClient(MP_PAYMENT_RESP));
    const r = await getPaymentStatus(UID, 'pay456');
    expect(r.status).toBe('approved');
    expect(r.paymentId).toBe('pay456');
    expect(r.amount).toBe(100);
  });
  test('propaga error si HTTP falla', async () => {
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'test-token';
    __setHttpClientForTests(async () => { throw new Error('network error'); });
    await expect(getPaymentStatus(UID, 'pay1')).rejects.toThrow('network error');
  });
});

describe('processWebhook', () => {
  test('lanza si uid undefined', async () => {
    await expect(processWebhook(undefined, {})).rejects.toThrow('uid requerido');
  });
  test('lanza si payload undefined', async () => {
    await expect(processWebhook(UID, null)).rejects.toThrow('payload requerido');
  });
  test('ignora tipo que no es payment', async () => {
    const r = await processWebhook(UID, { type: 'merchant_order' });
    expect(r.processed).toBe(false);
    expect(r.reason).toContain('no procesable');
  });
  test('lanza si sin paymentId en data', async () => {
    await expect(processWebhook(UID, { type: 'payment', data: {} })).rejects.toThrow('data.id requerido');
  });
  test('procesa webhook payment con exito', async () => {
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'test-token';
    __setFirestoreForTests(makeMockDb());
    __setHttpClientForTests(makeHttpClient(MP_PAYMENT_RESP));
    const r = await processWebhook(UID, { type: 'payment', data: { id: 'pay456' } });
    expect(r.processed).toBe(true);
    expect(r.status).toBe('approved');
    expect(r.paymentId).toBe('pay456');
  });
  test('retorna processed=false si error consultando pago', async () => {
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'test-token';
    __setFirestoreForTests(makeMockDb());
    __setHttpClientForTests(async () => { throw new Error('network'); });
    const r = await processWebhook(UID, { type: 'payment', data: { id: 'pay1' } });
    expect(r.processed).toBe(false);
  });
});

describe('getPaymentHistory', () => {
  test('lanza si uid undefined', async () => {
    await expect(getPaymentHistory(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si sin pagos', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getPaymentHistory(UID);
    expect(r).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ get: async () => { throw new Error('get error'); } }) }) }),
    });
    const r = await getPaymentHistory(UID);
    expect(r).toEqual([]);
  });
});

describe('isPaymentApproved', () => {
  test('retorna true para approved', () => {
    expect(isPaymentApproved('approved')).toBe(true);
  });
  test('retorna false para rejected', () => {
    expect(isPaymentApproved('rejected')).toBe(false);
  });
  test('retorna false para pending', () => {
    expect(isPaymentApproved('pending')).toBe(false);
  });
});
