'use strict';

// T278: ecommerce_bridge
const {
  buildEcommerceConnection, buildSyncRecord, buildExternalProduct, buildExternalOrder,
  mapProductToInternal, computeSyncStats, buildConnectionSummaryText,
  saveConnection, getConnection, updateConnection, saveSyncRecord, getSyncRecord,
  PLATFORM_TYPES, SYNC_STATUSES, ORDER_STATUSES, SYNC_DIRECTIONS,
  MAX_PRODUCTS_PER_SYNC, SYNC_COOLDOWN_MS,
  __setFirestoreForTests,
} = require('../core/ecommerce_bridge');

const UID = 'testEcomUid';

function makeMockDb({ stored = {}, syncStored = {}, throwGet = false, throwSet = false } = {}) {
  const stores = { stored, syncStored };
  function getStore(subCol) {
    return subCol === 'ecom_syncs' ? stores.syncStored : stores.stored;
  }
  return {
    collection: () => ({
      doc: () => ({
        collection: (subCol) => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              const s = getStore(subCol);
              s[id] = opts && opts.merge ? { ...(s[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              const s = getStore(subCol);
              return { exists: !!s[id], data: () => s[id] };
            },
          }),
          where: (field, op, val) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const s = getStore(subCol);
              const entries = Object.values(s).filter(d => d && d[field] === val);
              return { empty: entries.length === 0, forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            const s = getStore(subCol);
            return { empty: Object.keys(s).length === 0, forEach: fn => Object.values(s).forEach(d => fn({ data: () => d })) };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
describe('constants', () => {
  test('PLATFORM_TYPES frozen 5 valores', () => {
    expect(PLATFORM_TYPES).toHaveLength(5);
    expect(PLATFORM_TYPES).toContain('woocommerce');
    expect(PLATFORM_TYPES).toContain('shopify');
    expect(Object.isFrozen(PLATFORM_TYPES)).toBe(true);
  });
  test('SYNC_STATUSES frozen 5 valores', () => {
    expect(SYNC_STATUSES).toHaveLength(5);
    expect(SYNC_STATUSES).toContain('pending');
    expect(SYNC_STATUSES).toContain('synced');
    expect(Object.isFrozen(SYNC_STATUSES)).toBe(true);
  });
  test('ORDER_STATUSES frozen 6 valores', () => {
    expect(ORDER_STATUSES).toHaveLength(6);
    expect(ORDER_STATUSES).toContain('delivered');
    expect(Object.isFrozen(ORDER_STATUSES)).toBe(true);
  });
  test('MAX_PRODUCTS_PER_SYNC es 500', () => {
    expect(MAX_PRODUCTS_PER_SYNC).toBe(500);
  });
});

// ─── buildEcommerceConnection ─────────────────────────────────────────────────
describe('buildEcommerceConnection', () => {
  test('defaults correctos para woocommerce', () => {
    const c = buildEcommerceConnection(UID, 'woocommerce', {
      storeUrl: 'https://mystore.com', storeName: 'Mi Tienda',
    });
    expect(c.uid).toBe(UID);
    expect(c.platform).toBe('woocommerce');
    expect(c.connected).toBe(false);
    expect(c.direction).toBe('bidirectional');
    expect(c.syncProducts).toBe(true);
    expect(c.syncOrders).toBe(true);
    expect(c.totalProductsSynced).toBe(0);
    expect(c.connectionId).toContain('ecom_woocommerce');
  });
  test('platform invalido → error', () => {
    expect(() => buildEcommerceConnection(UID, 'amazon', {})).toThrow('invalido');
  });
  test('apiSecret nunca se guarda en texto plano', () => {
    const c = buildEcommerceConnection(UID, 'shopify', { apiSecret: 'mysecret123' });
    expect(c.apiSecret).toBe('***');
  });
  test('direction invalido cae a bidirectional', () => {
    const c = buildEcommerceConnection(UID, 'tiendanube', { direction: 'INVALID' });
    expect(c.direction).toBe('bidirectional');
  });
});

// ─── buildSyncRecord ──────────────────────────────────────────────────────────
describe('buildSyncRecord', () => {
  test('defaults correctos', () => {
    const s = buildSyncRecord(UID, 'conn_001', {});
    expect(s.uid).toBe(UID);
    expect(s.connectionId).toBe('conn_001');
    expect(s.status).toBe('pending');
    expect(s.productCount).toBe(0);
    expect(s.orderCount).toBe(0);
    expect(s.errors).toHaveLength(0);
    expect(s.syncId).toContain('_sync_');
  });
  test('direction custom', () => {
    const s = buildSyncRecord(UID, 'conn_001', { direction: 'export' });
    expect(s.direction).toBe('export');
  });
});

// ─── buildExternalProduct ─────────────────────────────────────────────────────
describe('buildExternalProduct', () => {
  test('construye producto externo con defaults', () => {
    const p = buildExternalProduct({
      externalId: '123', name: 'Shampoo Hidratante', price: 1500,
      stock: 50, currency: 'ars', category: 'cuidado',
    });
    expect(p.externalId).toBe('123');
    expect(p.name).toBe('Shampoo Hidratante');
    expect(p.currency).toBe('ARS'); // normalizado
    expect(p.stock).toBe(50);
    expect(p.active).toBe(true);
    expect(p.syncedAt).toBeDefined();
  });
  test('price negativo → 0', () => {
    const p = buildExternalProduct({ price: -100 });
    expect(p.price).toBe(0);
  });
  test('images se limita a 5', () => {
    const imgs = ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg', '6.jpg', '7.jpg'];
    const p = buildExternalProduct({ images: imgs });
    expect(p.images).toHaveLength(5);
  });
});

// ─── buildExternalOrder ───────────────────────────────────────────────────────
describe('buildExternalOrder', () => {
  test('construye orden externa con defaults', () => {
    const o = buildExternalOrder({
      externalId: 'ORD-001', total: 2500, currency: 'ars',
      customerName: 'Laura', customerPhone: '+5491155550001',
      status: 'processing',
      items: [{ name: 'Shampoo', qty: 2, price: 1250 }],
    });
    expect(o.externalId).toBe('ORD-001');
    expect(o.total).toBe(2500);
    expect(o.currency).toBe('ARS');
    expect(o.status).toBe('processing');
    expect(o.itemCount).toBe(1);
    expect(o.customerName).toBe('Laura');
  });
  test('status invalido cae a pending', () => {
    const o = buildExternalOrder({ status: 'INVALID' });
    expect(o.status).toBe('pending');
  });
  test('total negativo → 0', () => {
    const o = buildExternalOrder({ total: -500 });
    expect(o.total).toBe(0);
  });
});

// ─── mapProductToInternal ─────────────────────────────────────────────────────
describe('mapProductToInternal', () => {
  test('mapea producto externo al formato interno', () => {
    const ext = buildExternalProduct({
      externalId: '456', externalSku: 'SKU-123', name: 'Gel Capilar',
      price: 800, stock: 20, currency: 'ars', active: true,
      platform: 'woocommerce', category: 'cuidado',
    });
    const internal = mapProductToInternal(ext, UID);
    expect(internal.uid).toBe(UID);
    expect(internal.name).toBe('Gel Capilar');
    expect(internal.price).toBe(800);
    expect(internal.status).toBe('available');
    expect(internal.externalId).toBe('456');
    expect(internal.externalPlatform).toBe('woocommerce');
  });
  test('producto inactivo → status discontinued', () => {
    const ext = buildExternalProduct({ name: 'X', active: false });
    const internal = mapProductToInternal(ext, UID);
    expect(internal.status).toBe('discontinued');
  });
});

// ─── computeSyncStats ─────────────────────────────────────────────────────────
describe('computeSyncStats', () => {
  test('sync completado sin errores → success true', () => {
    const sync = {
      ...buildSyncRecord(UID, 'c', {}),
      status: 'synced', startedAt: 1000, completedAt: 5000,
      productCount: 25, orderCount: 10, errorCount: 0,
    };
    const stats = computeSyncStats(sync);
    expect(stats.success).toBe(true);
    expect(stats.duration).toBe(4000);
    expect(stats.productCount).toBe(25);
    expect(stats.orderCount).toBe(10);
  });
  test('sync con errores → success false', () => {
    const sync = {
      ...buildSyncRecord(UID, 'c', {}),
      status: 'synced', startedAt: 1000, completedAt: 3000,
      productCount: 10, errorCount: 2,
    };
    const stats = computeSyncStats(sync);
    expect(stats.success).toBe(false);
  });
  test('sync sin completar → duration null', () => {
    const sync = buildSyncRecord(UID, 'c', {});
    const stats = computeSyncStats(sync);
    expect(stats.duration).toBeNull();
  });
});

// ─── buildConnectionSummaryText ───────────────────────────────────────────────
describe('buildConnectionSummaryText', () => {
  test('null retorna defecto', () => {
    expect(buildConnectionSummaryText(null)).toContain('no encontrada');
  });
  test('desconectado muestra rojo', () => {
    const c = buildEcommerceConnection(UID, 'shopify', { storeName: 'Mi Shopify' });
    const text = buildConnectionSummaryText(c);
    expect(text).toContain('SHOPIFY');
    expect(text).toContain('Mi Shopify');
    expect(text).toContain('desconectado');
  });
  test('conectado muestra verde', () => {
    const c = buildEcommerceConnection(UID, 'tiendanube', { connected: true, storeName: 'Tienda' });
    const text = buildConnectionSummaryText(c);
    expect(text).toContain('conectado');
  });
});

// ─── FIRESTORE CRUD ──────────────────────────────────────────────────────────
describe('saveConnection + getConnection round-trip', () => {
  test('guarda y recupera conexion', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const c = buildEcommerceConnection(UID, 'shopify', {
      storeUrl: 'https://myshop.myshopify.com', storeName: 'Mi Shopify',
    });
    await saveConnection(UID, c);
    __setFirestoreForTests(db);
    const loaded = await getConnection(UID, c.connectionId);
    expect(loaded).not.toBeNull();
    expect(loaded.platform).toBe('shopify');
    expect(loaded.storeName).toBe('Mi Shopify');
  });
  test('getConnection null si no existe', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    expect(await getConnection(UID, 'nonexistent')).toBeNull();
  });
  test('saveConnection lanza con throwSet', async () => {
    const db = makeMockDb({ throwSet: true });
    __setFirestoreForTests(db);
    const c = buildEcommerceConnection(UID, 'woocommerce', {});
    await expect(saveConnection(UID, c)).rejects.toThrow('set error');
  });
});

describe('updateConnection', () => {
  test('actualiza campos connected y lastSyncAt', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const c = buildEcommerceConnection(UID, 'tiendanube', { connectionId: 'conn_tnd' });
    await saveConnection(UID, c);
    const syncTime = Date.now();
    __setFirestoreForTests(db);
    await updateConnection(UID, 'conn_tnd', { connected: true, lastSyncAt: syncTime, totalProductsSynced: 50 });
    __setFirestoreForTests(db);
    const loaded = await getConnection(UID, 'conn_tnd');
    expect(loaded.connected).toBe(true);
    expect(loaded.totalProductsSynced).toBe(50);
  });
});

describe('saveSyncRecord + getSyncRecord', () => {
  test('guarda y recupera sync record', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const sync = buildSyncRecord(UID, 'conn_001', { direction: 'import' });
    await saveSyncRecord(UID, sync);
    __setFirestoreForTests(db);
    const loaded = await getSyncRecord(UID, sync.syncId);
    expect(loaded).not.toBeNull();
    expect(loaded.direction).toBe('import');
    expect(loaded.status).toBe('pending');
  });
});

// ─── PIPELINE: sincronizacion completa ────────────────────────────────────────
describe('Pipeline: conexion → sync → mapeo → actualizacion stats', () => {
  test('flujo completo woocommerce sync productos', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);

    // 1. Crear conexion WooCommerce
    let connection = buildEcommerceConnection(UID, 'woocommerce', {
      storeUrl: 'https://salon.miia.com',
      storeName: 'Salon de Belleza',
      syncProducts: true,
      syncOrders: true,
    });
    await saveConnection(UID, connection);

    // 2. Iniciar sync record
    let syncRecord = buildSyncRecord(UID, connection.connectionId, { direction: 'import', type: 'full' });
    syncRecord = { ...syncRecord, status: 'syncing', startedAt: Date.now() };
    setAll: __setFirestoreForTests(db);
    await saveSyncRecord(UID, syncRecord);

    // 3. Simular productos externos recibidos de WooCommerce
    const rawProducts = [
      { externalId: 'wc_001', externalSku: 'SHAMP-01', name: 'Shampoo Hidratante', price: 1200, stock: 30, currency: 'ARS', category: 'cuidado' },
      { externalId: 'wc_002', externalSku: 'GEL-01', name: 'Gel Fijador', price: 800, stock: 15, currency: 'ARS', active: true },
      { externalId: 'wc_003', externalSku: 'MASK-01', name: 'Mascarilla Capilar', price: 2000, stock: 0, active: false },
    ];

    // 4. Construir productos externos y mapear al formato interno
    const externalProducts = rawProducts.map(p => buildExternalProduct({ ...p, platform: 'woocommerce' }));
    const internalProducts = externalProducts.map(ep => mapProductToInternal(ep, UID));

    expect(internalProducts[0].status).toBe('available');
    expect(internalProducts[2].status).toBe('discontinued'); // stock=0, active=false

    // 5. Simular ordenes externas
    const rawOrders = [
      { externalId: 'ORD-001', total: 3000, currency: 'ARS', status: 'processing', customerName: 'Ana', items: [{ name: 'Shampoo', qty: 1 }] },
      { externalId: 'ORD-002', total: 1600, currency: 'ARS', status: 'delivered', customerName: 'Carlos', items: [{ name: 'Gel' }, { name: 'Mascarilla' }] },
    ];
    const externalOrders = rawOrders.map(o => buildExternalOrder({ ...o, platform: 'woocommerce' }));
    expect(externalOrders[0].status).toBe('processing');
    expect(externalOrders[1].itemCount).toBe(2);

    // 6. Completar sync record
    const completedAt = Date.now();
    syncRecord = {
      ...syncRecord,
      status: 'synced',
      productCount: externalProducts.length,
      orderCount: externalOrders.length,
      errorCount: 0,
      completedAt,
    };
    __setFirestoreForTests(db);
    await saveSyncRecord(UID, syncRecord);

    // 7. Computar stats del sync
    const stats = computeSyncStats(syncRecord);
    expect(stats.success).toBe(true);
    expect(stats.productCount).toBe(3);
    expect(stats.orderCount).toBe(2);
    expect(stats.duration).toBeGreaterThanOrEqual(0); // misma ms es valido

    // 8. Actualizar conexion con resultados
    __setFirestoreForTests(db);
    await updateConnection(UID, connection.connectionId, {
      connected: true,
      lastSyncAt: completedAt,
      lastSyncStatus: 'synced',
      totalProductsSynced: stats.productCount,
      totalOrdersSynced: stats.orderCount,
    });

    // 9. Verificar estado final
    __setFirestoreForTests(db);
    const finalConn = await getConnection(UID, connection.connectionId);
    expect(finalConn.connected).toBe(true);
    expect(finalConn.totalProductsSynced).toBe(3);
    expect(finalConn.totalOrdersSynced).toBe(2);
    expect(finalConn.lastSyncStatus).toBe('synced');

    __setFirestoreForTests(db);
    const finalSync = await getSyncRecord(UID, syncRecord.syncId);
    expect(finalSync.status).toBe('synced');

    // 10. Texto de la conexion
    const text = buildConnectionSummaryText(finalConn);
    expect(text).toContain('WOOCOMMERCE');
    expect(text).toContain('conectado');
    expect(text).toContain('3');
  });
});
