'use strict';

// T260 catalog_manager — suite completa
const {
  buildProductRecord,
  validateProductData,
  saveProduct,
  getProduct,
  updateProductStatus,
  updateProductPrice,
  listProductsByCategory,
  listAvailableProducts,
  searchProductsLocal,
  computeProductAvailability,
  buildProductText,
  buildCatalogText,
  PRODUCT_STATUSES,
  CATALOG_CATEGORIES,
  CATALOG_CURRENCIES,
  MAX_PRODUCTS_PER_CATALOG,
  MAX_DESCRIPTION_LENGTH,
  __setFirestoreForTests: setDb,
} = require('../core/catalog_manager');

const UID = 'catalog260Uid';

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
        }),
      }),
    }),
  };
}

beforeEach(() => setDb(null));
afterEach(() => setDb(null));

// ─── CONSTANTES ──────────────────────────────────────────────────────────────
describe('catalog_manager — constantes', () => {
  test('PRODUCT_STATUSES tiene 4 valores clave', () => {
    ['available', 'out_of_stock', 'discontinued', 'draft'].forEach(s =>
      expect(PRODUCT_STATUSES).toContain(s)
    );
  });
  test('CATALOG_CATEGORIES tiene servicios y productos_fisicos', () => {
    expect(CATALOG_CATEGORIES).toContain('servicios');
    expect(CATALOG_CATEGORIES).toContain('productos_fisicos');
    expect(CATALOG_CATEGORIES).toContain('otros');
  });
  test('CATALOG_CURRENCIES tiene ARS y USD', () => {
    expect(CATALOG_CURRENCIES).toContain('ARS');
    expect(CATALOG_CURRENCIES).toContain('USD');
  });
  test('MAX_PRODUCTS_PER_CATALOG es 500', () => {
    expect(MAX_PRODUCTS_PER_CATALOG).toBe(500);
  });
  test('MAX_DESCRIPTION_LENGTH es 1000', () => {
    expect(MAX_DESCRIPTION_LENGTH).toBe(1000);
  });
});

// ─── buildProductRecord ───────────────────────────────────────────────────────
describe('buildProductRecord', () => {
  test('construye record con defaults correctos', () => {
    const p = buildProductRecord(UID, { name: 'Servicio A', price: 1500, currency: 'ARS', category: 'servicios' });
    expect(p.uid).toBe(UID);
    expect(p.name).toBe('Servicio A');
    expect(p.price).toBe(1500);
    expect(p.currency).toBe('ARS');
    expect(p.category).toBe('servicios');
    expect(p.status).toBe('available');
    expect(p.productId).toBeDefined();
    expect(p.tags).toEqual([]);
    expect(p.stock).toBeNull();
    expect(p.metadata).toEqual({});
  });
  test('categoria invalida cae a otros', () => {
    const p = buildProductRecord(UID, { name: 'X', category: 'HACKER' });
    expect(p.category).toBe('otros');
  });
  test('status invalido cae a available', () => {
    const p = buildProductRecord(UID, { name: 'X', status: 'borrado' });
    expect(p.status).toBe('available');
  });
  test('currency invalida cae a ARS', () => {
    const p = buildProductRecord(UID, { name: 'X', currency: 'FAKE' });
    expect(p.currency).toBe('ARS');
  });
  test('price negativo cae a 0', () => {
    const p = buildProductRecord(UID, { name: 'X', price: -100 });
    expect(p.price).toBe(0);
  });
  test('tags se filtran a MAX_TAGS_PER_PRODUCT=10', () => {
    const manyTags = Array.from({ length: 15 }, (_, i) => 'tag' + i);
    const p = buildProductRecord(UID, { name: 'X', tags: manyTags });
    expect(p.tags.length).toBe(10);
  });
  test('description se trunca a MAX_DESCRIPTION_LENGTH', () => {
    const longDesc = 'A'.repeat(1500);
    const p = buildProductRecord(UID, { name: 'X', description: longDesc });
    expect(p.description.length).toBe(1000);
  });
  test('stock entero positivo se guarda correctamente', () => {
    const p = buildProductRecord(UID, { name: 'X', stock: 25.9 });
    expect(p.stock).toBe(25);
  });
  test('productId se puede forzar', () => {
    const p = buildProductRecord(UID, { name: 'X', productId: 'prod_custom_001' });
    expect(p.productId).toBe('prod_custom_001');
  });
  test('metadata valida se preserva', () => {
    const p = buildProductRecord(UID, { name: 'X', metadata: { sku: 'ABC123' } });
    expect(p.metadata.sku).toBe('ABC123');
  });
  test('metadata invalida cae a objeto vacio', () => {
    const p = buildProductRecord(UID, { name: 'X', metadata: 'invalid' });
    expect(p.metadata).toEqual({});
  });
});

// ─── validateProductData ──────────────────────────────────────────────────────
describe('validateProductData', () => {
  test('valido retorna valid=true', () => {
    const r = validateProductData({ name: 'Producto A', price: 100, currency: 'ARS' });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
  test('sin name retorna error', () => {
    const r = validateProductData({ price: 100 });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('name'))).toBe(true);
  });
  test('name vacio retorna error', () => {
    const r = validateProductData({ name: '   ' });
    expect(r.valid).toBe(false);
  });
  test('price negativo retorna error', () => {
    const r = validateProductData({ name: 'X', price: -5 });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('price'))).toBe(true);
  });
  test('currency invalida retorna error', () => {
    const r = validateProductData({ name: 'X', currency: 'XYZ' });
    expect(r.valid).toBe(false);
  });
  test('category invalida retorna error', () => {
    const r = validateProductData({ name: 'X', category: 'fake_cat' });
    expect(r.valid).toBe(false);
  });
  test('status invalido retorna error', () => {
    const r = validateProductData({ name: 'X', status: 'gone' });
    expect(r.valid).toBe(false);
  });
});

// ─── saveProduct + getProduct ─────────────────────────────────────────────────
describe('saveProduct + getProduct', () => {
  test('round-trip exitoso', async () => {
    const db = makeMockDb();
    setDb(db);
    const p = buildProductRecord(UID, { name: 'Servicio Premium', price: 5000, currency: 'ARS', category: 'servicios' });
    const savedId = await saveProduct(UID, p);
    expect(savedId).toBe(p.productId);
    const loaded = await getProduct(UID, p.productId);
    expect(loaded.name).toBe('Servicio Premium');
    expect(loaded.price).toBe(5000);
  });
  test('getProduct retorna null si no existe', async () => {
    setDb(makeMockDb());
    const loaded = await getProduct(UID, 'prod_no_existe');
    expect(loaded).toBeNull();
  });
  test('saveProduct con throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    const p = buildProductRecord(UID, { name: 'X' });
    await expect(saveProduct(UID, p)).rejects.toThrow('set error');
  });
  test('getProduct con throwGet retorna null', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const result = await getProduct(UID, 'prod_001');
    expect(result).toBeNull();
  });
});

// ─── updateProductStatus ──────────────────────────────────────────────────────
describe('updateProductStatus', () => {
  test('actualiza a out_of_stock', async () => {
    setDb(makeMockDb());
    const id = await updateProductStatus(UID, 'prod_001', 'out_of_stock');
    expect(id).toBe('prod_001');
  });
  test('status invalido lanza error', async () => {
    setDb(makeMockDb());
    await expect(updateProductStatus(UID, 'prod_001', 'borrado')).rejects.toThrow('status invalido');
  });
  test('throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    await expect(updateProductStatus(UID, 'prod_001', 'draft')).rejects.toThrow('set error');
  });
});

// ─── updateProductPrice ──────────────────────────────────────────────────────
describe('updateProductPrice', () => {
  test('actualiza precio y currency', async () => {
    setDb(makeMockDb());
    const id = await updateProductPrice(UID, 'prod_001', 3000, 'USD');
    expect(id).toBe('prod_001');
  });
  test('precio negativo lanza error', async () => {
    setDb(makeMockDb());
    await expect(updateProductPrice(UID, 'prod_001', -50)).rejects.toThrow('price invalido');
  });
  test('precio 0 es valido', async () => {
    setDb(makeMockDb());
    const id = await updateProductPrice(UID, 'prod_001', 0);
    expect(id).toBe('prod_001');
  });
});

// ─── listProductsByCategory ───────────────────────────────────────────────────
describe('listProductsByCategory', () => {
  test('retorna solo productos de esa categoria', async () => {
    const p1 = buildProductRecord(UID, { name: 'Serv A', category: 'servicios' });
    const p2 = buildProductRecord(UID, { name: 'Prod B', category: 'productos_fisicos' });
    p2.productId = UID.slice(0,8) + '_prod_prod_b';
    setDb(makeMockDb({ stored: { [p1.productId]: p1, [p2.productId]: p2 } }));
    const results = await listProductsByCategory(UID, 'servicios');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Serv A');
  });
  test('categoria invalida retorna array vacio', async () => {
    setDb(makeMockDb());
    const results = await listProductsByCategory(UID, 'fake_cat');
    expect(results).toEqual([]);
  });
  test('throwGet retorna array vacio', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const results = await listProductsByCategory(UID, 'servicios');
    expect(results).toEqual([]);
  });
});

// ─── listAvailableProducts ────────────────────────────────────────────────────
describe('listAvailableProducts', () => {
  test('retorna solo productos con status=available', async () => {
    const p1 = buildProductRecord(UID, { name: 'Activo', status: 'available' });
    const p2 = { ...buildProductRecord(UID, { name: 'Sin stock' }), status: 'out_of_stock' };
    p2.productId = UID.slice(0,8) + '_prod_sin_stock';
    setDb(makeMockDb({ stored: { [p1.productId]: p1, [p2.productId]: p2 } }));
    const results = await listAvailableProducts(UID);
    expect(results.every(p => p.status === 'available')).toBe(true);
  });
  test('throwGet retorna array vacio', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const results = await listAvailableProducts(UID);
    expect(results).toEqual([]);
  });
});

// ─── searchProductsLocal ──────────────────────────────────────────────────────
describe('searchProductsLocal', () => {
  const products = [
    buildProductRecord(UID, { name: 'Corte de pelo', price: 500, category: 'servicios', status: 'available', tags: ['peluqueria'] }),
    buildProductRecord(UID, { name: 'Tinte', price: 1200, category: 'servicios', status: 'available' }),
    buildProductRecord(UID, { name: 'Shampoo Profesional', price: 800, category: 'productos_fisicos', status: 'available' }),
    { ...buildProductRecord(UID, { name: 'Gel Viejo', price: 200, category: 'productos_fisicos' }), status: 'discontinued' },
  ];
  products[0].productId = 'prod_corte';
  products[1].productId = 'prod_tinte';
  products[2].productId = 'prod_shampoo';
  products[3].productId = 'prod_gel';

  test('sin query retorna todos (hasta limit=50)', () => {
    const r = searchProductsLocal(products, '');
    expect(r.length).toBe(4);
  });
  test('busca por nombre', () => {
    const r = searchProductsLocal(products, 'corte');
    expect(r.length).toBe(1);
    expect(r[0].name).toBe('Corte de pelo');
  });
  test('busca por tag', () => {
    const r = searchProductsLocal(products, 'peluqueria');
    expect(r.length).toBe(1);
  });
  test('filtra por categoria', () => {
    const r = searchProductsLocal(products, '', { category: 'productos_fisicos' });
    expect(r.length).toBe(2);
  });
  test('filtra por status', () => {
    const r = searchProductsLocal(products, '', { status: 'available' });
    expect(r.length).toBe(3);
  });
  test('filtra por maxPrice', () => {
    const r = searchProductsLocal(products, '', { maxPrice: 600 });
    expect(r.every(p => p.price <= 600)).toBe(true);
  });
  test('filtra por minPrice', () => {
    const r = searchProductsLocal(products, '', { minPrice: 800 });
    expect(r.every(p => p.price >= 800)).toBe(true);
  });
  test('ordena por precio desc', () => {
    const r = searchProductsLocal(products, '', { sortBy: 'price', sortDir: 'desc' });
    expect(r[0].price).toBeGreaterThanOrEqual(r[1].price);
  });
  test('limit recorta resultados', () => {
    const r = searchProductsLocal(products, '', { limit: 2 });
    expect(r.length).toBe(2);
  });
  test('query vacia null retorna todos', () => {
    const r = searchProductsLocal(products, null);
    expect(r.length).toBe(4);
  });
});

// ─── computeProductAvailability ───────────────────────────────────────────────
describe('computeProductAvailability', () => {
  test('disponible si status=available y sin stock', () => {
    const p = buildProductRecord(UID, { name: 'X', status: 'available' });
    const r = computeProductAvailability(p);
    expect(r.available).toBe(true);
  });
  test('no disponible si status=out_of_stock', () => {
    const p = { ...buildProductRecord(UID, { name: 'X' }), status: 'out_of_stock' };
    const r = computeProductAvailability(p);
    expect(r.available).toBe(false);
    expect(r.reason).toBe('out_of_stock');
  });
  test('no disponible si stock=0', () => {
    const p = buildProductRecord(UID, { name: 'X', stock: 0 });
    const r = computeProductAvailability(p);
    expect(r.available).toBe(false);
    expect(r.reason).toBe('stock_agotado');
  });
  test('disponible si stock>0', () => {
    const p = buildProductRecord(UID, { name: 'X', stock: 5 });
    const r = computeProductAvailability(p);
    expect(r.available).toBe(true);
    expect(r.stock).toBe(5);
  });
  test('not_found si product es null', () => {
    const r = computeProductAvailability(null);
    expect(r.available).toBe(false);
    expect(r.reason).toBe('not_found');
  });
  test('discontinued no disponible', () => {
    const p = { ...buildProductRecord(UID, { name: 'X' }), status: 'discontinued' };
    const r = computeProductAvailability(p);
    expect(r.available).toBe(false);
    expect(r.reason).toBe('discontinued');
  });
});

// ─── buildProductText ─────────────────────────────────────────────────────────
describe('buildProductText', () => {
  test('incluye nombre y precio', () => {
    const p = buildProductRecord(UID, { name: 'Corte de Pelo', price: 500, currency: 'ARS', category: 'servicios' });
    const text = buildProductText(p);
    expect(text).toContain('Corte de Pelo');
    expect(text).toContain('500');
    expect(text).toContain('ARS');
  });
  test('incluye descripcion si existe', () => {
    const p = buildProductRecord(UID, { name: 'X', description: 'Descripcion del servicio' });
    const text = buildProductText(p);
    expect(text).toContain('Descripcion del servicio');
  });
  test('incluye stock si no es null', () => {
    const p = buildProductRecord(UID, { name: 'X', stock: 10 });
    const text = buildProductText(p);
    expect(text).toContain('10');
  });
  test('incluye tags si existen', () => {
    const p = buildProductRecord(UID, { name: 'X', tags: ['premium', 'exclusivo'] });
    const text = buildProductText(p);
    expect(text).toContain('premium');
  });
  test('retorna string vacio si product es null', () => {
    expect(buildProductText(null)).toBe('');
  });
  test('indica disponibilidad', () => {
    const p = buildProductRecord(UID, { name: 'X', status: 'available' });
    const text = buildProductText(p);
    expect(text).toContain('Disponible');
  });
  test('indica no disponible si out_of_stock', () => {
    const p = { ...buildProductRecord(UID, { name: 'X' }), status: 'out_of_stock' };
    const text = buildProductText(p);
    expect(text).toContain('No disponible');
  });
});

// ─── buildCatalogText ─────────────────────────────────────────────────────────
describe('buildCatalogText', () => {
  test('retorna mensaje si no hay productos', () => {
    const text = buildCatalogText([]);
    expect(text).toContain('No hay productos');
  });
  test('retorna mensaje si null', () => {
    const text = buildCatalogText(null);
    expect(text).toContain('No hay productos');
  });
  test('incluye nombre de producto y precio', () => {
    const products = [buildProductRecord(UID, { name: 'Corte', price: 500, category: 'servicios' })];
    const text = buildCatalogText(products);
    expect(text).toContain('Corte');
    expect(text).toContain('500');
  });
  test('usa titulo personalizado', () => {
    const products = [buildProductRecord(UID, { name: 'X', category: 'otros' })];
    const text = buildCatalogText(products, { title: 'Mi Tienda 2026' });
    expect(text).toContain('Mi Tienda 2026');
  });
  test('agrupa por categoria', () => {
    const p1 = buildProductRecord(UID, { name: 'Servicio A', category: 'servicios' });
    const p2 = buildProductRecord(UID, { name: 'Prod B', category: 'productos_fisicos' });
    p2.productId = UID.slice(0,8) + '_prod_prod_b';
    const text = buildCatalogText([p1, p2]);
    expect(text).toContain('servicios');
    expect(text).toContain('productos fisicos');
  });
});
