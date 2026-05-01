'use strict';

const {
  saveStoreConfig, getStoreConfig, syncCatalog, getSyncedCatalog,
  normalizeWooProduct, normalizeShopifyProduct,
  SUPPORTED_PLATFORMS, ORDER_STATUSES, MAX_PRODUCTS_SYNC,
  __setFirestoreForTests, __setHttpClientForTests,
} = require('../core/ecommerce_connector');

const UID = 'testUid1234567890';
const WOO_CONFIG = { platform: 'woocommerce', storeUrl: 'https://mitienda.com', apiKey: 'ck_xxx', apiSecret: 'cs_xxx' };
const SHOPIFY_CONFIG = { platform: 'shopify', storeUrl: 'https://mitienda.myshopify.com', apiKey: 'shpat_xxx' };

const WOO_PRODUCT = { id: 1, name: 'Remera', short_description: 'Linda', price: '100', regular_price: '120', sale_price: '100', sku: 'REM001', stock_quantity: 5, in_stock: true, categories: [{ name: 'Ropa' }], images: [{ src: 'https://img.jpg' }] };
const SHOPIFY_PRODUCT = { id: 1001, title: 'T-Shirt', body_html: '<p>Nice shirt</p>', variants: [{ price: '29.99', compare_at_price: '39.99', sku: 'TS001', inventory_quantity: 10 }], product_type: 'Clothing', images: [{ src: 'https://img.jpg' }] };

function makeMockDb({ storedConfig = null, storedCatalog = null, throwSet = false } = {}) {
  const configDoc = {
    get: async () => storedConfig ? { exists: true, data: () => storedConfig } : { exists: false },
    set: async (data) => { if (throwSet) throw new Error('set error'); },
  };
  const catalogDoc = {
    get: async () => storedCatalog ? { exists: true, data: () => ({ products: storedCatalog }) } : { exists: false, data: () => null },
    set: async (data) => { if (throwSet) throw new Error('set error'); },
  };
  return {
    collection: (name) => {
      if (name === 'store_configs') return { doc: () => configDoc };
      return { doc: () => catalogDoc };
    },
  };
}

function makeHttpClient(response) {
  return async (url, headers, signal) => response;
}

beforeEach(() => { __setFirestoreForTests(null); __setHttpClientForTests(null); });
afterEach(() => { __setFirestoreForTests(null); __setHttpClientForTests(null); });

describe('SUPPORTED_PLATFORMS y constants', () => {
  test('incluye woocommerce y shopify', () => {
    expect(SUPPORTED_PLATFORMS).toContain('woocommerce');
    expect(SUPPORTED_PLATFORMS).toContain('shopify');
  });
  test('es frozen', () => {
    expect(() => { SUPPORTED_PLATFORMS.push('x'); }).toThrow();
  });
  test('MAX_PRODUCTS_SYNC es 500', () => {
    expect(MAX_PRODUCTS_SYNC).toBe(500);
  });
  test('ORDER_STATUSES incluye completed y cancelled', () => {
    expect(ORDER_STATUSES).toContain('completed');
    expect(ORDER_STATUSES).toContain('cancelled');
  });
});

describe('saveStoreConfig', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveStoreConfig(undefined, WOO_CONFIG)).rejects.toThrow('uid requerido');
  });
  test('lanza si config undefined', async () => {
    await expect(saveStoreConfig(UID, null)).rejects.toThrow('config requerido');
  });
  test('lanza si platform faltante', async () => {
    await expect(saveStoreConfig(UID, { storeUrl: 'x', apiKey: 'y' })).rejects.toThrow('platform requerido');
  });
  test('lanza si platform no soportada', async () => {
    await expect(saveStoreConfig(UID, { platform: 'magento', storeUrl: 'x', apiKey: 'y' })).rejects.toThrow('no soportada');
  });
  test('lanza si storeUrl faltante', async () => {
    await expect(saveStoreConfig(UID, { platform: 'woocommerce', apiKey: 'y' })).rejects.toThrow('storeUrl requerido');
  });
  test('lanza si apiKey faltante', async () => {
    await expect(saveStoreConfig(UID, { platform: 'woocommerce', storeUrl: 'x' })).rejects.toThrow('apiKey requerido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveStoreConfig(UID, WOO_CONFIG)).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(saveStoreConfig(UID, WOO_CONFIG)).rejects.toThrow('set error');
  });
});

describe('getStoreConfig', () => {
  test('lanza si uid undefined', async () => {
    await expect(getStoreConfig(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna null si no hay config', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getStoreConfig(UID)).toBeNull();
  });
  test('retorna config guardada', async () => {
    __setFirestoreForTests(makeMockDb({ storedConfig: WOO_CONFIG }));
    const c = await getStoreConfig(UID);
    expect(c.platform).toBe('woocommerce');
  });
  test('fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => { throw new Error('err'); } }) }) });
    expect(await getStoreConfig(UID)).toBeNull();
  });
});


describe('normalizeWooProduct', () => {
  test('normaliza producto WooCommerce', () => {
    const p = normalizeWooProduct(WOO_PRODUCT);
    expect(p.platform).toBe('woocommerce');
    expect(p.name).toBe('Remera');
    expect(p.price).toBe(100);
    expect(p.sku).toBe('REM001');
    expect(p.stock).toBe(5);
    expect(p.categories).toContain('Ropa');
    expect(p.images.length).toBe(1);
  });
  test('maneja producto sin campos opcionales', () => {
    const p = normalizeWooProduct({ id: 2, name: 'Test' });
    expect(p.id).toBe('2');
    expect(p.categories).toEqual([]);
    expect(p.images).toEqual([]);
    expect(p.salePrice).toBeNull();
  });
});

describe('normalizeShopifyProduct', () => {
  test('normaliza producto Shopify', () => {
    const p = normalizeShopifyProduct(SHOPIFY_PRODUCT);
    expect(p.platform).toBe('shopify');
    expect(p.name).toBe('T-Shirt');
    expect(p.price).toBe(29.99);
    expect(p.sku).toBe('TS001');
    expect(p.stock).toBe(10);
    expect(p.categories).toContain('Clothing');
    expect(p.description).toBe('Nice shirt');
  });
  test('maneja producto sin variantes', () => {
    const p = normalizeShopifyProduct({ id: 99, title: 'Sin variante' });
    expect(p.id).toBe('99');
    expect(p.price).toBe(0);
    expect(p.categories).toEqual([]);
  });
});

describe('syncCatalog', () => {
  test('lanza si uid undefined', async () => {
    await expect(syncCatalog(undefined)).rejects.toThrow('uid requerido');
  });
  test('lanza si sin config guardada y sin override', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(syncCatalog(UID)).rejects.toThrow('configuracion de tienda no encontrada');
  });
  test('sincroniza catalogo WooCommerce', async () => {
    __setFirestoreForTests(makeMockDb());
    __setHttpClientForTests(makeHttpClient([WOO_PRODUCT]));
    const r = await syncCatalog(UID, WOO_CONFIG);
    expect(r.synced).toBe(1);
    expect(r.platform).toBe('woocommerce');
    expect(r.products[0].name).toBe('Remera');
  });
  test('sincroniza catalogo Shopify', async () => {
    __setFirestoreForTests(makeMockDb());
    __setHttpClientForTests(makeHttpClient({ products: [SHOPIFY_PRODUCT] }));
    const r = await syncCatalog(UID, SHOPIFY_CONFIG);
    expect(r.synced).toBe(1);
    expect(r.platform).toBe('shopify');
    expect(r.products[0].name).toBe('T-Shirt');
  });
  test('propaga error HTTP', async () => {
    __setFirestoreForTests(makeMockDb());
    __setHttpClientForTests(async () => { throw new Error('HTTP 401'); });
    await expect(syncCatalog(UID, WOO_CONFIG)).rejects.toThrow('HTTP 401');
  });
  test('limita a MAX_PRODUCTS_SYNC items', async () => {
    __setFirestoreForTests(makeMockDb());
    const many = Array.from({ length: 600 }, (_, i) => ({ ...WOO_PRODUCT, id: i }));
    __setHttpClientForTests(makeHttpClient(many));
    const r = await syncCatalog(UID, WOO_CONFIG);
    expect(r.synced).toBe(MAX_PRODUCTS_SYNC);
  });
});

describe('getSyncedCatalog', () => {
  test('lanza si uid undefined', async () => {
    await expect(getSyncedCatalog(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si sin catalogo', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getSyncedCatalog(UID);
    expect(r).toEqual([]);
  });
  test('retorna catalogo guardado', async () => {
    const cat = [{ id: '1', name: 'Test', platform: 'woocommerce' }];
    __setFirestoreForTests(makeMockDb({ storedCatalog: cat }));
    const r = await getSyncedCatalog(UID);
    expect(r.length).toBe(1);
    expect(r[0].name).toBe('Test');
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => { throw new Error('err'); } }) }) });
    expect(await getSyncedCatalog(UID)).toEqual([]);
  });
});
