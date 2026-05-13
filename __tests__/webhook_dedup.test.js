'use strict';

const dedup = require('../core/webhook_dedup');

function makeFirestoreMock(seedEvents) {
  const store = Object.assign({}, seedEvents || {});
  const docFn = jest.fn((key) => ({
    get: jest.fn().mockResolvedValue({
      exists: !!store[key],
      data: () => store[key] || {},
    }),
    set: jest.fn((payload) => {
      store[key] = payload;
      return Promise.resolve();
    }),
  }));
  return {
    collection: jest.fn(() => ({ doc: docFn })),
    _store: store,
  };
}

beforeEach(() => {
  dedup.__setFirestoreForTests(null);
  dedup.__setNowForTests(null);
});

describe('webhook_dedup', () => {
  describe('wasProcessed', () => {
    test('provider null -> false', async () => {
      expect(await dedup.wasProcessed(null, 'e1')).toBe(false);
    });
    test('eventId null -> false', async () => {
      expect(await dedup.wasProcessed('paypal', null)).toBe(false);
    });
    test('no existe -> false', async () => {
      dedup.__setFirestoreForTests(makeFirestoreMock({}));
      expect(await dedup.wasProcessed('paypal', 'e1')).toBe(false);
    });
    test('existe -> true', async () => {
      dedup.__setFirestoreForTests(makeFirestoreMock({ 'paypal__e1': { eventId: 'e1' } }));
      expect(await dedup.wasProcessed('paypal', 'e1')).toBe(true);
    });
  });

  describe('markProcessed', () => {
    test('provider invalido -> skipped', async () => {
      const r = await dedup.markProcessed(null, 'e1');
      expect(r.skipped).toBe(true);
      expect(r.duplicate).toBe(false);
    });
    test('eventId invalido -> skipped', async () => {
      const r = await dedup.markProcessed('paypal', null);
      expect(r.skipped).toBe(true);
    });
    test('primera vez -> duplicate=false + escribe', async () => {
      const mock = makeFirestoreMock({});
      dedup.__setFirestoreForTests(mock);
      dedup.__setNowForTests(() => new Date('2026-05-12T20:00:00Z'));
      const r = await dedup.markProcessed('paypal', 'e1', { uid: 'u1', eventType: 'ACTIVATED' });
      expect(r.duplicate).toBe(false);
      expect(mock._store['paypal__e1'].provider).toBe('paypal');
      expect(mock._store['paypal__e1'].eventId).toBe('e1');
      expect(mock._store['paypal__e1'].uid).toBe('u1');
      expect(mock._store['paypal__e1'].receivedAt).toBe('2026-05-12T20:00:00.000Z');
    });
    test('segunda vez (mismo eventId) -> duplicate=true', async () => {
      dedup.__setFirestoreForTests(makeFirestoreMock({ 'paypal__e1': { eventId: 'e1' } }));
      const r = await dedup.markProcessed('paypal', 'e1');
      expect(r.duplicate).toBe(true);
    });
    test('markProcessed sin meta funciona', async () => {
      dedup.__setFirestoreForTests(makeFirestoreMock({}));
      const r = await dedup.markProcessed('mercadopago', 'pay123');
      expect(r.duplicate).toBe(false);
    });
    test('provider distinto con mismo eventId NO es duplicate', async () => {
      const mock = makeFirestoreMock({ 'paypal__e1': { eventId: 'e1' } });
      dedup.__setFirestoreForTests(mock);
      const r = await dedup.markProcessed('mercadopago', 'e1');
      expect(r.duplicate).toBe(false);
    });
  });
});
