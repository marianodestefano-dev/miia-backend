'use strict';

const subs = require('../core/subscriptions_manager');

function makeFirestoreMock(seedSubs) {
  const data = Object.assign({}, seedSubs || {});
  const docFn = jest.fn((product) => ({
    get: jest.fn().mockResolvedValue({
      exists: !!data[product],
      data: () => data[product] || {},
    }),
    set: jest.fn((payload, opts) => {
      data[product] = Object.assign({}, data[product], payload);
      return Promise.resolve();
    }),
  }));
  const subsCollection = {
    doc: docFn,
    get: jest.fn().mockResolvedValue({
      docs: Object.keys(data).map(k => ({ id: k, data: () => data[k] })),
    }),
  };
  const userDocFn = jest.fn(() => ({
    collection: jest.fn((name) => name === 'subscriptions' ? subsCollection : null),
  }));
  return {
    collection: jest.fn((name) => ({ doc: userDocFn })),
    _data: data,
  };
}

beforeEach(() => {
  subs.__setFirestoreForTests(null);
  subs.__setNowForTests(null);
});

describe('subscriptions_manager', () => {
  describe('writeSubscription', () => {
    test('rechaza uid invalido', async () => {
      await expect(subs.writeSubscription(null, 'miia', {})).rejects.toThrow('invalid_uid');
      await expect(subs.writeSubscription(123, 'miia', {})).rejects.toThrow('invalid_uid');
    });
    test('rechaza producto invalido', async () => {
      await expect(subs.writeSubscription('uid1', 'foo', {})).rejects.toThrow('invalid_product');
      await expect(subs.writeSubscription('uid1', 123, {})).rejects.toThrow('invalid_product');
    });
    test('escribe con merge y updatedAt', async () => {
      const mock = makeFirestoreMock({});
      subs.__setFirestoreForTests(mock);
      subs.__setNowForTests(() => new Date('2026-05-12T20:00:00Z'));
      const out = await subs.writeSubscription('uid1', 'miia', { active: true, plan: 'monthly' });
      expect(out.active).toBe(true);
      expect(out.plan).toBe('monthly');
      expect(out.updatedAt).toBe('2026-05-12T20:00:00.000Z');
    });
  });

  describe('readSubscription', () => {
    test('uid invalido devuelve null', async () => {
      expect(await subs.readSubscription(null, 'miia')).toBe(null);
    });
    test('producto invalido devuelve null', async () => {
      expect(await subs.readSubscription('uid1', 'foo')).toBe(null);
    });
    test('no existe devuelve null', async () => {
      subs.__setFirestoreForTests(makeFirestoreMock({}));
      expect(await subs.readSubscription('uid1', 'miia')).toBe(null);
    });
    test('existe devuelve data', async () => {
      subs.__setFirestoreForTests(makeFirestoreMock({ miia: { active: true, plan: 'monthly' } }));
      const r = await subs.readSubscription('uid1', 'miia');
      expect(r.active).toBe(true);
      expect(r.plan).toBe('monthly');
    });
  });

  describe('isProductActive', () => {
    test('sin subscription -> false', async () => {
      subs.__setFirestoreForTests(makeFirestoreMock({}));
      expect(await subs.isProductActive('uid1', 'miia')).toBe(false);
    });
    test('active=false -> false', async () => {
      subs.__setFirestoreForTests(makeFirestoreMock({ miia: { active: false } }));
      expect(await subs.isProductActive('uid1', 'miia')).toBe(false);
    });
    test('active=true sin expiresAt -> true', async () => {
      subs.__setFirestoreForTests(makeFirestoreMock({ miia: { active: true } }));
      expect(await subs.isProductActive('uid1', 'miia')).toBe(true);
    });
    test('active=true con expiresAt futuro -> true', async () => {
      subs.__setFirestoreForTests(makeFirestoreMock({ miia: { active: true, expiresAt: '2030-01-01' } }));
      subs.__setNowForTests(() => new Date('2026-05-12'));
      expect(await subs.isProductActive('uid1', 'miia')).toBe(true);
    });
    test('active=true con expiresAt pasado -> false', async () => {
      subs.__setFirestoreForTests(makeFirestoreMock({ miia: { active: true, expiresAt: '2020-01-01' } }));
      subs.__setNowForTests(() => new Date('2026-05-12'));
      expect(await subs.isProductActive('uid1', 'miia')).toBe(false);
    });
    test('active=true con expiresAt invalido -> true (no descalifica)', async () => {
      subs.__setFirestoreForTests(makeFirestoreMock({ miia: { active: true, expiresAt: 'fecha-rota' } }));
      expect(await subs.isProductActive('uid1', 'miia')).toBe(true);
    });
  });

  describe('addProductPermission', () => {
    test('uid invalido', async () => {
      await expect(subs.addProductPermission(null, 'miia')).rejects.toThrow('invalid_uid');
    });
    test('producto invalido', async () => {
      await expect(subs.addProductPermission('uid1', 'foo')).rejects.toThrow('invalid_product');
    });
    test('agrega permission con plan default', async () => {
      const mock = makeFirestoreMock({});
      subs.__setFirestoreForTests(mock);
      subs.__setNowForTests(() => new Date('2026-05-12T20:00:00Z'));
      const out = await subs.addProductPermission('uid1', 'miiadt');
      expect(out.active).toBe(true);
      expect(out.plan).toBe('monthly');
      expect(out.expiresAt).toBe(null);
      expect(out.activatedAt).toBe('2026-05-12T20:00:00.000Z');
    });
    test('agrega permission con plan + expiresAt custom', async () => {
      subs.__setFirestoreForTests(makeFirestoreMock({}));
      const out = await subs.addProductPermission('uid1', 'ludomiia', 'annual', '2027-01-01');
      expect(out.plan).toBe('annual');
      expect(out.expiresAt).toBe('2027-01-01');
    });
  });

  describe('listActiveProducts', () => {
    test('uid invalido -> []', async () => {
      expect(await subs.listActiveProducts(null)).toEqual([]);
      expect(await subs.listActiveProducts(123)).toEqual([]);
    });
    test('sin subscriptions -> []', async () => {
      subs.__setFirestoreForTests(makeFirestoreMock({}));
      expect(await subs.listActiveProducts('uid1')).toEqual([]);
    });
    test('mix activos + inactivos -> solo activos vigentes', async () => {
      subs.__setFirestoreForTests(makeFirestoreMock({
        miia:     { active: true },
        miiadt:   { active: true, expiresAt: '2030-01-01' },
        ludomiia: { active: false },
        miiaf1:   { active: true, expiresAt: '2020-01-01' },
      }));
      subs.__setNowForTests(() => new Date('2026-05-12'));
      const list = await subs.listActiveProducts('uid1');
      expect(list.sort()).toEqual(['miia', 'miiadt']);
    });
    test('expiresAt invalido NO descalifica', async () => {
      subs.__setFirestoreForTests(makeFirestoreMock({
        miia: { active: true, expiresAt: 'fecha-rota' },
      }));
      const list = await subs.listActiveProducts('uid1');
      expect(list).toEqual(['miia']);
    });
  });

  test('VALID_PRODUCTS export', () => {
    expect(subs.VALID_PRODUCTS).toEqual(['miia', 'miiadt', 'ludomiia', 'miiaf1']);
  });
});
