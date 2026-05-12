'use strict';

const ec = require('../core/ecommerce_integrations');
const {
  connectShopify,
  connectWooCommerce,
  shopifyGetProducts,
  shopifyUpdateStock,
  shopifyGetOrders,
  wooGetProducts,
  wooUpdateStock,
  wooGetOrders,
  wooUpdateOrderStatus,
  isConnected,
  PLATFORM,
  __setFirestoreForTests,
  __setFetchForTests,
} = ec;

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeFetch(status, jsonBody) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue('error text'),
    json: jest.fn().mockResolvedValue(jsonBody !== undefined ? jsonBody : {}),
  });
}

function makeFetchFail(status) {
  return jest.fn().mockResolvedValue({
    ok: false, status,
    text: jest.fn().mockResolvedValue('api error'),
    json: jest.fn().mockResolvedValue({}),
  });
}

function makeDb(shopifyExists, shopifyData, wooExists, wooData) {
  const mockSet = jest.fn().mockResolvedValue({});
  const integrations = {
    shopify: {
      exists: shopifyExists !== undefined ? shopifyExists : true,
      data: () => shopifyData || { access_token: 'tok', shop_domain: 'mystore.myshopify.com' },
    },
    woocommerce: {
      exists: wooExists !== undefined ? wooExists : true,
      data: () => wooData || { consumer_key: 'ck_key', consumer_secret: 'cs_secret', store_url: 'https://mystore.com' },
    },
  };
  const docFn = jest.fn((platform) => ({
    get: jest.fn().mockResolvedValue(integrations[platform] || { exists: false, data: () => ({}) }),
    set: mockSet,
  }));
  const collFn = jest.fn(() => ({ doc: docFn }));
  const ownerDoc = jest.fn(() => ({ collection: collFn }));
  const db = { collection: jest.fn(() => ({ doc: ownerDoc })) };
  return { db, mockSet, docFn };
}

beforeEach(() => {
  __setFetchForTests(null);
  __setFirestoreForTests(null);
});

// ── connectShopify ────────────────────────────────────────────────────────────

describe('connectShopify', () => {
  test('uid null -> throw', async () => {
    await expect(connectShopify(null, { access_token: 'tok', shop_domain: 'x' })).rejects.toThrow('uid_requerido');
  });
  test('creds null -> throw', async () => {
    await expect(connectShopify('uid1', null)).rejects.toThrow('shopify_creds_requeridos');
  });
  test('sin access_token -> throw', async () => {
    await expect(connectShopify('uid1', { shop_domain: 'x' })).rejects.toThrow('shopify_creds_requeridos');
  });
  test('sin shop_domain -> throw', async () => {
    await expect(connectShopify('uid1', { access_token: 'tok' })).rejects.toThrow('shopify_creds_requeridos');
  });

  test('OK - shop_domain con https:// -> normaliza', async () => {
    const { db, mockSet } = makeDb();
    __setFirestoreForTests(db);
    const r = await connectShopify('uid123456', { access_token: 'tok', shop_domain: 'https://mystore.myshopify.com/' });
    expect(r.ok).toBe(true);
    expect(r.platform).toBe('shopify');
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      shop_domain: 'mystore.myshopify.com',
    }));
  });

  test('OK - shop_domain sin https -> sin cambio', async () => {
    const { db, mockSet } = makeDb();
    __setFirestoreForTests(db);
    await connectShopify('uid123456', { access_token: 'tok', shop_domain: 'mystore.myshopify.com' });
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      shop_domain: 'mystore.myshopify.com',
    }));
  });
});

// ── connectWooCommerce ────────────────────────────────────────────────────────

describe('connectWooCommerce', () => {
  test('uid null -> throw', async () => {
    await expect(connectWooCommerce(null, { consumer_key: 'k', consumer_secret: 's', store_url: 'u' })).rejects.toThrow('uid_requerido');
  });
  test('creds null -> throw', async () => {
    await expect(connectWooCommerce('uid1', null)).rejects.toThrow('woocommerce_creds_requeridos');
  });
  test('sin consumer_key -> throw', async () => {
    await expect(connectWooCommerce('uid1', { consumer_secret: 's', store_url: 'u' })).rejects.toThrow('woocommerce_creds_requeridos');
  });
  test('sin consumer_secret -> throw', async () => {
    await expect(connectWooCommerce('uid1', { consumer_key: 'k', store_url: 'u' })).rejects.toThrow('woocommerce_creds_requeridos');
  });
  test('sin store_url -> throw', async () => {
    await expect(connectWooCommerce('uid1', { consumer_key: 'k', consumer_secret: 's' })).rejects.toThrow('woocommerce_creds_requeridos');
  });

  test('OK', async () => {
    const { db, mockSet } = makeDb();
    __setFirestoreForTests(db);
    const r = await connectWooCommerce('uid123456', { consumer_key: 'ck_k', consumer_secret: 'cs_s', store_url: 'https://mystore.com' });
    expect(r.ok).toBe(true);
    expect(r.platform).toBe('woocommerce');
    expect(mockSet).toHaveBeenCalled();
  });
});

// ── shopifyGetProducts ────────────────────────────────────────────────────────

describe('shopifyGetProducts', () => {
  test('no conectado -> throw', async () => {
    const { db } = makeDb(false, null, false, null);
    __setFirestoreForTests(db);
    await expect(shopifyGetProducts('uid123456')).rejects.toThrow('shopify_no_conectado');
  });

  test('creds incompletos (sin shop_domain) -> throw', async () => {
    const { db } = makeDb(true, { access_token: 'tok' });
    __setFirestoreForTests(db);
    await expect(shopifyGetProducts('uid123456')).rejects.toThrow('shopify_creds_incompletos');
  });

  test('API error -> throw', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetchFail(401));
    await expect(shopifyGetProducts('uid123456')).rejects.toThrow('shopify_api_error:401');
  });

  test('OK - lista productos con defaults', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    const shopifyProducts = {
      products: [
        { id: 1, title: 'Prod A', status: 'active', variants: [{ price: '10.00', inventory_quantity: 5 }], vendor: 'VendorX' },
        { id: 2, title: 'Prod B', status: 'draft', variants: [], vendor: null },
      ]
    };
    __setFetchForTests(makeFetch(200, shopifyProducts));
    const prods = await shopifyGetProducts('uid123456');
    expect(prods).toHaveLength(2);
    expect(prods[0].price).toBe('10.00');
    expect(prods[0].inventory).toBe(5);
    expect(prods[0].vendor).toBe('VendorX');
    expect(prods[1].price).toBe('0'); // no variants -> default
    expect(prods[1].inventory).toBe(0);
    expect(prods[1].vendor).toBeNull();
  });

  test('OK - productos vacio -> []', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, {}));
    const prods = await shopifyGetProducts('uid123456');
    expect(prods).toEqual([]);
  });

  test('OK - con page_info opts', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    const fetchMock = makeFetch(200, { products: [] });
    __setFetchForTests(fetchMock);
    await shopifyGetProducts('uid123456', { limit: 50, page_info: 'abc123' });
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('page_info=abc123');
    expect(url).toContain('limit=50');
  });

  test('limit mayor a 250 -> capped a 250', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    const fetchMock = makeFetch(200, { products: [] });
    __setFetchForTests(fetchMock);
    await shopifyGetProducts('uid123456', { limit: 500 });
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('limit=250');
  });

  test('producto con variants[0] sin price -> 0', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, { products: [{ id: 3, title: 'X', variants: [{}] }] }));
    const prods = await shopifyGetProducts('uid123456');
    expect(prods[0].price).toBe('0');
    expect(prods[0].inventory).toBe(0);
  });
});

// ── shopifyUpdateStock ────────────────────────────────────────────────────────

describe('shopifyUpdateStock', () => {
  test('inventoryItemId null -> throw', async () => {
    await expect(shopifyUpdateStock('uid1', null, 5, 'loc1')).rejects.toThrow('inventoryItemId_requerido');
  });
  test('quantity invalida (string) -> throw', async () => {
    await expect(shopifyUpdateStock('uid1', 'item1', 'five', 'loc1')).rejects.toThrow('quantity_invalida');
  });
  test('quantity negativa -> throw', async () => {
    await expect(shopifyUpdateStock('uid1', 'item1', -1, 'loc1')).rejects.toThrow('quantity_invalida');
  });
  test('locationId null -> throw', async () => {
    await expect(shopifyUpdateStock('uid1', 'item1', 5, null)).rejects.toThrow('locationId_requerido');
  });

  test('OK', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, {}));
    const r = await shopifyUpdateStock('uid123456', 'item-id-1', 10, 'loc-id-1');
    expect(r.ok).toBe(true);
  });

  test('API error en PUT -> throw', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetchFail(422));
    await expect(shopifyUpdateStock('uid123456', 'item1', 5, 'loc1')).rejects.toThrow('shopify_api_error:422');
  });
});

// ── shopifyGetOrders ──────────────────────────────────────────────────────────

describe('shopifyGetOrders', () => {
  test('API error -> throw', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetchFail(500));
    await expect(shopifyGetOrders('uid123456')).rejects.toThrow('shopify_api_error:500');
  });

  test('OK - orden con customer', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    const shopifyOrders = {
      orders: [{
        id: 101, order_number: 1001, financial_status: 'paid', fulfillment_status: 'fulfilled',
        total_price: '50.00', currency: 'USD',
        customer: { email: 'a@b.com', first_name: 'John', last_name: 'Doe' },
        created_at: '2026-05-01',
      }]
    };
    __setFetchForTests(makeFetch(200, shopifyOrders));
    const orders = await shopifyGetOrders('uid123456');
    expect(orders).toHaveLength(1);
    expect(orders[0].customer.email).toBe('a@b.com');
    expect(orders[0].customer.name).toBe('John Doe');
  });

  test('OK - orden sin customer -> null', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, { orders: [{ id: 102, financial_status: 'pending' }] }));
    const orders = await shopifyGetOrders('uid123456');
    expect(orders[0].customer).toBeNull();
  });

  test('OK - ordenes vacio -> []', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, {}));
    const orders = await shopifyGetOrders('uid123456');
    expect(orders).toEqual([]);
  });

  test('con status y limit opts', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    const fetchMock = makeFetch(200, { orders: [] });
    __setFetchForTests(fetchMock);
    await shopifyGetOrders('uid123456', { status: 'open', limit: 10 });
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('status=open');
    expect(url).toContain('limit=10');
  });

  test('orden con customer sin first_name/last_name -> name con espacios vacios', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, { orders: [{ id: 103, customer: { email: 'x@y.com' } }] }));
    const orders = await shopifyGetOrders('uid123456');
    expect(orders[0].customer.name).toBe(' ');
  });
});

// ── wooGetProducts ────────────────────────────────────────────────────────────

describe('wooGetProducts', () => {
  test('no conectado -> throw', async () => {
    const { db } = makeDb(true, null, false, null);
    __setFirestoreForTests(db);
    await expect(wooGetProducts('uid123456')).rejects.toThrow('woocommerce_no_conectado');
  });

  test('creds incompletos -> throw', async () => {
    const { db } = makeDb(true, null, true, { consumer_key: 'k' });
    __setFirestoreForTests(db);
    await expect(wooGetProducts('uid123456')).rejects.toThrow('woocommerce_creds_incompletos');
  });

  test('API error -> throw', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetchFail(403));
    await expect(wooGetProducts('uid123456')).rejects.toThrow('woocommerce_api_error:403');
  });

  test('OK - lista productos', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    const wooProds = [
      { id: 1, name: 'Prod A', status: 'publish', price: '15.00', stock_quantity: 10, sku: 'SKU-001' },
      { id: 2, name: 'Prod B', price: null, stock_quantity: null },
    ];
    __setFetchForTests(makeFetch(200, wooProds));
    const prods = await wooGetProducts('uid123456');
    expect(prods).toHaveLength(2);
    expect(prods[0].sku).toBe('SKU-001');
    expect(prods[1].price).toBe('0');
    expect(prods[1].stock_quantity).toBe(0);
    expect(prods[1].sku).toBeNull();
  });

  test('respuesta null -> []', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, null));
    const prods = await wooGetProducts('uid123456');
    expect(prods).toEqual([]);
  });

  test('store_url con trailing slash -> normaliza', async () => {
    const { db } = makeDb(true, null, true, { consumer_key: 'k', consumer_secret: 's', store_url: 'https://mystore.com/' });
    __setFirestoreForTests(db);
    const fetchMock = makeFetch(200, []);
    __setFetchForTests(fetchMock);
    await wooGetProducts('uid123456');
    const url = fetchMock.mock.calls[0][0];
    expect(url).not.toContain('//wp-json');
  });

  test('per_page mayor a 100 -> capped a 100', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    const fetchMock = makeFetch(200, []);
    __setFetchForTests(fetchMock);
    await wooGetProducts('uid123456', { per_page: 200 });
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('per_page=100');
  });

  test('page y per_page opts', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    const fetchMock = makeFetch(200, []);
    __setFetchForTests(fetchMock);
    await wooGetProducts('uid123456', { per_page: 10, page: 3 });
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('per_page=10');
    expect(url).toContain('page=3');
  });
});

// ── wooUpdateStock ────────────────────────────────────────────────────────────

describe('wooUpdateStock', () => {
  test('productId null -> throw', async () => {
    await expect(wooUpdateStock('uid1', null, 5)).rejects.toThrow('productId_requerido');
  });
  test('stockQuantity invalido (string) -> throw', async () => {
    await expect(wooUpdateStock('uid1', 'p1', 'five')).rejects.toThrow('stock_invalido');
  });
  test('stockQuantity negativo -> throw', async () => {
    await expect(wooUpdateStock('uid1', 'p1', -1)).rejects.toThrow('stock_invalido');
  });

  test('OK', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, {}));
    const r = await wooUpdateStock('uid123456', '42', 20);
    expect(r.ok).toBe(true);
  });

  test('API error en PUT -> throw', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetchFail(500));
    await expect(wooUpdateStock('uid123456', '42', 5)).rejects.toThrow('woocommerce_api_error:500');
  });
});

// ── wooGetOrders ──────────────────────────────────────────────────────────────

describe('wooGetOrders', () => {
  test('API error -> throw', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetchFail(401));
    await expect(wooGetOrders('uid123456')).rejects.toThrow('woocommerce_api_error:401');
  });

  test('OK - orden con billing', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    const wooOrds = [
      { id: 201, status: 'completed', total: '80.00', currency: 'ARS', date_created: '2026-05-10',
        billing: { first_name: 'Ana', email: 'ana@test.com' } },
    ];
    __setFetchForTests(makeFetch(200, wooOrds));
    const orders = await wooGetOrders('uid123456');
    expect(orders).toHaveLength(1);
    expect(orders[0].billing.email).toBe('ana@test.com');
  });

  test('OK - orden sin billing -> null', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, [{ id: 202, status: 'pending' }]));
    const orders = await wooGetOrders('uid123456');
    expect(orders[0].billing).toBeNull();
  });

  test('OK - respuesta null -> []', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, null));
    const orders = await wooGetOrders('uid123456');
    expect(orders).toEqual([]);
  });

  test('con status y per_page opts', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    const fetchMock = makeFetch(200, []);
    __setFetchForTests(fetchMock);
    await wooGetOrders('uid123456', { status: 'processing', per_page: 5 });
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('status=processing');
  });

  test('orden sin campos opcionales -> defaults', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, [{ id: 203 }]));
    const orders = await wooGetOrders('uid123456');
    expect(orders[0].status).toBe('');
    expect(orders[0].total).toBe('0');
    expect(orders[0].currency).toBe('USD');
    expect(orders[0].date_created).toBeNull();
    expect(orders[0].billing).toBeNull();
  });

  test('billing sin campos -> empty strings', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, [{ id: 204, billing: {} }]));
    const orders = await wooGetOrders('uid123456');
    expect(orders[0].billing.first_name).toBe('');
    expect(orders[0].billing.email).toBe('');
  });
});

// ── wooUpdateOrderStatus ──────────────────────────────────────────────────────

describe('wooUpdateOrderStatus', () => {
  test('orderId null -> throw', async () => {
    await expect(wooUpdateOrderStatus('uid1', null, 'completed')).rejects.toThrow('orderId_requerido');
  });
  test('status null -> throw', async () => {
    await expect(wooUpdateOrderStatus('uid1', '201', null)).rejects.toThrow('status_requerido');
  });

  test('OK - retorna status del response', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, { status: 'completed' }));
    const r = await wooUpdateOrderStatus('uid123456', '201', 'completed');
    expect(r.ok).toBe(true);
    expect(r.status).toBe('completed');
  });

  test('OK - response sin status -> usa el parametro', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, {}));
    const r = await wooUpdateOrderStatus('uid123456', '201', 'processing');
    expect(r.status).toBe('processing');
  });

  test('API error -> throw', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetchFail(404));
    await expect(wooUpdateOrderStatus('uid123456', '999', 'completed')).rejects.toThrow('woocommerce_api_error:404');
  });
});

// ── isConnected ───────────────────────────────────────────────────────────────

describe('gap branches: || falsy en map returns', () => {
  test('shopifyGetProducts - producto sin id/title -> strings vacios', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, { products: [{}] }));
    const prods = await shopifyGetProducts('uid123456');
    expect(prods[0].id).toBe('');
    expect(prods[0].title).toBe('');
    expect(prods[0].status).toBe('active');
    expect(prods[0].price).toBe('0');
  });

  test('shopifyGetOrders - orden sin id ni campos -> defaults', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, { orders: [{}] }));
    const orders = await shopifyGetOrders('uid123456');
    expect(orders[0].id).toBe('');
    expect(orders[0].order_number).toBe('');
    expect(orders[0].financial_status).toBe('');
    expect(orders[0].fulfillment_status).toBeNull();
    expect(orders[0].total_price).toBe('0');
    expect(orders[0].currency).toBe('USD');
    expect(orders[0].customer).toBeNull();
    expect(orders[0].created_at).toBeNull();
  });

  test('shopifyGetOrders - customer sin email -> empty', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, { orders: [{ id: 1, customer: { first_name: 'X', last_name: 'Y' } }] }));
    const orders = await shopifyGetOrders('uid123456');
    expect(orders[0].customer.email).toBe('');
  });

  test('wooGetProducts - producto sin campos -> defaults', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, [{}]));
    const prods = await wooGetProducts('uid123456');
    expect(prods[0].id).toBe('');
    expect(prods[0].name).toBe('');
    expect(prods[0].status).toBe('publish');
  });

  test('wooGetOrders - orden sin id -> empty', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, [{}]));
    const orders = await wooGetOrders('uid123456');
    expect(orders[0].id).toBe('');
  });
});

describe('isConnected', () => {
  test('uid null -> false', async () => {
    expect(await isConnected(null, 'shopify')).toBe(false);
  });
  test('platform null -> false', async () => {
    expect(await isConnected('uid1', null)).toBe(false);
  });
  test('platform invalida -> false', async () => {
    expect(await isConnected('uid1', 'magento')).toBe(false);
  });

  test('shopify doc no existe -> false', async () => {
    const { db } = makeDb(false, null, false, null);
    __setFirestoreForTests(db);
    expect(await isConnected('uid123456', 'shopify')).toBe(false);
  });

  test('shopify creds completos -> true', async () => {
    const { db } = makeDb(true, { access_token: 'tok', shop_domain: 'store.myshopify.com' });
    __setFirestoreForTests(db);
    expect(await isConnected('uid123456', 'shopify')).toBe(true);
  });

  test('shopify sin access_token -> false', async () => {
    const { db } = makeDb(true, { shop_domain: 'store.myshopify.com' });
    __setFirestoreForTests(db);
    expect(await isConnected('uid123456', 'shopify')).toBe(false);
  });

  test('woocommerce creds completos -> true', async () => {
    const { db } = makeDb(false, null, true, { consumer_key: 'k', consumer_secret: 's', store_url: 'u' });
    __setFirestoreForTests(db);
    expect(await isConnected('uid123456', 'woocommerce')).toBe(true);
  });

  test('woocommerce sin consumer_key -> false', async () => {
    const { db } = makeDb(false, null, true, { consumer_secret: 's', store_url: 'u' });
    __setFirestoreForTests(db);
    expect(await isConnected('uid123456', 'woocommerce')).toBe(false);
  });

  test('Firestore error -> false (catch)', async () => {
    const db = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            doc: jest.fn(() => ({
              get: jest.fn().mockRejectedValue(new Error('firestore error')),
            })),
          })),
        })),
      })),
    };
    __setFirestoreForTests(db);
    expect(await isConnected('uid123456', 'shopify')).toBe(false);
  });
});
