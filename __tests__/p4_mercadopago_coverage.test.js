'use strict';

let mp;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
  mp = require('../core/mercadopago_v2');
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  mp.__setFirestoreForTests(null);
  mp.__setHttpClientForTests(null);
  delete process.env.MERCADOPAGO_ACCESS_TOKEN;
  delete global.fetch;
  jest.restoreAllMocks();
});

function makeSetDb({ throwSet = false } = {}) {
  return {
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({
        collection: jest.fn().mockReturnValue({
          doc: jest.fn().mockReturnValue({
            get: jest.fn().mockResolvedValue({ exists: false, data: () => null }),
            set: throwSet
              ? jest.fn().mockRejectedValue(new Error('set fail'))
              : jest.fn().mockResolvedValue({}),
          }),
          get: jest.fn().mockResolvedValue({ forEach: fn => [] }),
        }),
      }),
    }),
  };
}

describe('P4 -- mercadopago_v2 branches sin cubrir', () => {
  test('createPreference: > 50 items -> throw maximo items (line 43)', async () => {
    const items = Array.from({ length: 51 }, (_, i) => ({
      title: 'Prod' + i, unit_price: 100, quantity: 1,
    }));
    await expect(mp.createPreference('uid1', { items })).rejects.toThrow(/maximo/);
  });

  test('_defaultPost: resp.ok=false -> throws MercadoPago HTTP 403 (lines 99-107)', async () => {
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'tok-test';
    mp.__setHttpClientForTests(null);
    mp.__setFirestoreForTests(makeSetDb());
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: jest.fn(),
    });
    const items = [{ title: 'X', unit_price: 10, quantity: 1 }];
    await expect(mp.createPreference('uid1', { items })).rejects.toThrow(/MercadoPago HTTP 403/);
  });

  test('_defaultGet: resp.ok=false -> throws MercadoPago HTTP 401 (lines 109-116)', async () => {
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'tok-test';
    mp.__setHttpClientForTests(null);
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: jest.fn(),
    });
    await expect(mp.getPaymentStatus('uid1', 'pay123')).rejects.toThrow(/MercadoPago HTTP 401/);
  });

  test('processWebhook: db set falla -> loguea error pero retorna processed:true (line 199)', async () => {
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'tok-test';
    mp.__setHttpClientForTests(async () => ({
      id: 'pay789', status: 'approved',
      transaction_amount: 100, currency_id: 'ARS', payer: {},
    }));
    mp.__setFirestoreForTests(makeSetDb({ throwSet: true }));
    const result = await mp.processWebhook('uid1', { type: 'payment', data: { id: 'pay789' } });
    expect(result.processed).toBe(true);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error guardando webhook'));
  });

  test('getPaymentHistory: pagos con y sin receivedAt -> branches ternario (lines 219-221)', async () => {
    const payments = [
      { id: 'p1', data: () => ({ status: 'approved', receivedAt: '2026-01-01T00:00:00Z' }) },
      { id: 'p2', data: () => ({ status: 'pending' }) },
      { id: 'p3', data: () => ({ status: 'approved', receivedAt: '2026-02-01T00:00:00Z' }) },
    ];
    const db = {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            get: jest.fn().mockResolvedValue({ forEach: fn => payments.forEach(fn) }),
          }),
        }),
      }),
    };
    mp.__setFirestoreForTests(db);
    const history = await mp.getPaymentHistory('uid1');
    expect(history.length).toBe(3);
    expect(history[0].receivedAt).toBe('2026-02-01T00:00:00Z');
  });
});
