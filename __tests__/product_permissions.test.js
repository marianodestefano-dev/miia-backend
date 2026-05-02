'use strict';

const pp = require('../core/product_permissions');

const UID = 'test_uid_pp';

function makeMockDb({ existing = null, throwGet = false } = {}) {
  let stored = existing;
  return {
    collection: () => ({ doc: () => ({
      get: async () => {
        if (throwGet) throw new Error('get error');
        return { exists: !!stored, data: () => stored };
      },
      set: async (d) => { stored = Object.assign(stored || {}, d); },
    })})
  };
}

beforeEach(() => { pp.__setFirestoreForTests(null); });

describe('PRODUCTS y SOURCES', () => {
  test('PRODUCTS frozen', () => { expect(() => { pp.PRODUCTS.push('x'); }).toThrow(); });
  test('SOURCES frozen', () => { expect(() => { pp.SOURCES.push('x'); }).toThrow(); });
  test('PRODUCTS contiene miia/miiadt/ludomiia/f1', () => {
    expect(pp.PRODUCTS).toEqual(['miia', 'miiadt', 'ludomiia', 'f1']);
  });
});

describe('getProductPermissions', () => {
  test('uid undefined throw', async () => {
    await expect(pp.getProductPermissions(undefined)).rejects.toThrow('uid');
  });
  test('sin doc -> defaults inactive', async () => {
    pp.__setFirestoreForTests(makeMockDb());
    const r = await pp.getProductPermissions(UID);
    for (const p of pp.PRODUCTS) {
      expect(r[p].active).toBe(false);
    }
  });
  test('con doc partial -> merge con defaults', async () => {
    pp.__setFirestoreForTests(makeMockDb({ existing: {
      miia: { active: true, plan: 'monthly' },
    }}));
    const r = await pp.getProductPermissions(UID);
    expect(r.miia.active).toBe(true);
    expect(r.miiadt.active).toBe(false);
  });
  test('Firestore throw -> defaults', async () => {
    pp.__setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await pp.getProductPermissions(UID);
    expect(r.miia.active).toBe(false);
  });
  test('doc.exists pero sin data fn -> defaults', async () => {
    pp.__setFirestoreForTests({
      collection: () => ({ doc: () => ({
        get: async () => ({ exists: true }),
        set: async () => {},
      })})
    });
    const r = await pp.getProductPermissions(UID);
    expect(r.miia.active).toBe(false);
  });
  test('doc data tiene producto no-objeto -> default', async () => {
    pp.__setFirestoreForTests(makeMockDb({ existing: { miia: 'string' } }));
    const r = await pp.getProductPermissions(UID);
    expect(r.miia.active).toBe(false);
  });
});

describe('isProductActive', () => {
  test('uid undefined throw', async () => {
    await expect(pp.isProductActive(undefined, 'miia')).rejects.toThrow('uid');
  });
  test('product invalido throw', async () => {
    await expect(pp.isProductActive(UID, 'invalido')).rejects.toThrow('product invalido');
  });
  test('producto inactive -> false', async () => {
    pp.__setFirestoreForTests(makeMockDb());
    expect(await pp.isProductActive(UID, 'miia')).toBe(false);
  });
  test('producto active sin expiresAt -> true', async () => {
    pp.__setFirestoreForTests(makeMockDb({ existing: { miia: { active: true } } }));
    expect(await pp.isProductActive(UID, 'miia')).toBe(true);
  });
  test('producto active con expiresAt futuro -> true', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    pp.__setFirestoreForTests(makeMockDb({ existing: { miia: { active: true, expiresAt: future } } }));
    expect(await pp.isProductActive(UID, 'miia')).toBe(true);
  });
  test('producto active con expiresAt pasado -> false', async () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    pp.__setFirestoreForTests(makeMockDb({ existing: { miia: { active: true, expiresAt: past } } }));
    expect(await pp.isProductActive(UID, 'miia')).toBe(false);
  });
  test('producto active con expiresAt invalido (NaN) -> true (no aplica filtro)', async () => {
    pp.__setFirestoreForTests(makeMockDb({ existing: { miia: { active: true, expiresAt: 'invalid-date' } } }));
    expect(await pp.isProductActive(UID, 'miia')).toBe(true);
  });
});

describe('setProductPermission', () => {
  test('uid undefined throw', async () => {
    await expect(pp.setProductPermission(undefined, 'miia', {})).rejects.toThrow('uid');
  });
  test('product invalido throw', async () => {
    await expect(pp.setProductPermission(UID, 'invalido', {})).rejects.toThrow('product invalido');
  });
  test('perm null throw', async () => {
    await expect(pp.setProductPermission(UID, 'miia', null)).rejects.toThrow('perm');
  });
  test('source invalida throw', async () => {
    await expect(pp.setProductPermission(UID, 'miia', { source: 'wrong' })).rejects.toThrow('source');
  });
  test('set OK con todos los campos', async () => {
    pp.__setFirestoreForTests(makeMockDb());
    const r = await pp.setProductPermission(UID, 'miia', {
      active: true, plan: 'monthly', expiresAt: '2026-12-31', source: 'standalone',
    });
    expect(r.active).toBe(true);
    expect(r.plan).toBe('monthly');
  });
  test('set sin source ok', async () => {
    pp.__setFirestoreForTests(makeMockDb());
    const r = await pp.setProductPermission(UID, 'miia', { active: true });
    expect(r.source).toBeNull();
  });
});

describe('grantMiiaIncludedAddons', () => {
  test('uid undefined throw', async () => {
    await expect(pp.grantMiiaIncludedAddons(undefined)).rejects.toThrow('uid');
  });
  test('otorga 3 addons (miiadt, ludomiia, f1) con source miia_included', async () => {
    pp.__setFirestoreForTests(makeMockDb());
    const r = await pp.grantMiiaIncludedAddons(UID, 'monthly');
    expect(r.miiadt.active).toBe(true);
    expect(r.miiadt.source).toBe('miia_included');
    expect(r.ludomiia.active).toBe(true);
    expect(r.f1.active).toBe(true);
    expect(r.miia).toBeUndefined();
  });
  test('parentPlan default miia_included si no se pasa', async () => {
    pp.__setFirestoreForTests(makeMockDb());
    const r = await pp.grantMiiaIncludedAddons(UID);
    expect(r.miiadt.plan).toBe('miia_included');
  });
});
