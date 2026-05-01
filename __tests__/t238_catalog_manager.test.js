'use strict';

const {
  addCatalogItem, updateCatalogItem, removeCatalogItem,
  getCatalogItems, getCatalogItem, buildCatalogItem,
  formatPriceText, buildCatalogSummaryText, buildItemDetailText, searchCatalogByText,
  isValidCategory, isValidStatus, isValidCurrency,
  ITEM_CATEGORIES, ITEM_STATUSES, CURRENCY_CODES,
  MAX_ITEMS_PER_CATALOG, MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_IMAGES_PER_ITEM,
  __setFirestoreForTests,
} = require('../core/catalog_manager');

const UID = 'testUid1234567890';

function makeMockDb({ docs = {}, throwGet = false, throwSet = false, throwDelete = false } = {}) {
  const stored = { ...docs };
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          get: async () => {
            if (throwGet) throw new Error('get error');
            return {
              forEach: fn => Object.entries(stored).forEach(([id, data]) => fn({ id, data: () => data, exists: true })),
            };
          },
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              stored[id] = opts && opts.merge ? { ...(stored[id] || {}), ...data } : data;
            },
            get: async () => ({
              exists: !!stored[id],
              id,
              data: () => stored[id],
            }),
            delete: async () => {
              if (throwDelete) throw new Error('delete error');
              delete stored[id];
            },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

describe('Constantes', () => {
  test('ITEM_CATEGORIES tiene 5 categorias', () => { expect(ITEM_CATEGORIES.length).toBe(5); });
  test('frozen ITEM_CATEGORIES', () => { expect(() => { ITEM_CATEGORIES.push('x'); }).toThrow(); });
  test('ITEM_STATUSES tiene 4 estados', () => { expect(ITEM_STATUSES.length).toBe(4); });
  test('frozen ITEM_STATUSES', () => { expect(() => { ITEM_STATUSES.push('x'); }).toThrow(); });
  test('CURRENCY_CODES tiene 7 monedas', () => { expect(CURRENCY_CODES.length).toBe(7); });
  test('MAX_ITEMS_PER_CATALOG es 500', () => { expect(MAX_ITEMS_PER_CATALOG).toBe(500); });
  test('MAX_NAME_LENGTH es 120', () => { expect(MAX_NAME_LENGTH).toBe(120); });
  test('MAX_IMAGES_PER_ITEM es 5', () => { expect(MAX_IMAGES_PER_ITEM).toBe(5); });
});

describe('isValidCategory / isValidStatus / isValidCurrency', () => {
  test('product es categoria valida', () => { expect(isValidCategory('product')).toBe(true); });
  test('random no es valida', () => { expect(isValidCategory('random')).toBe(false); });
  test('active es status valido', () => { expect(isValidStatus('active')).toBe(true); });
  test('deleted no es valido', () => { expect(isValidStatus('deleted')).toBe(false); });
  test('ARS es currency valida', () => { expect(isValidCurrency('ARS')).toBe(true); });
  test('EUR no es currency valida', () => { expect(isValidCurrency('EUR')).toBe(false); });
});

describe('buildCatalogItem', () => {
  test('lanza si name undefined', () => {
    expect(() => buildCatalogItem(undefined)).toThrow('name requerido');
  });
  test('lanza si name demasiado largo', () => {
    expect(() => buildCatalogItem('x'.repeat(121))).toThrow('demasiado largo');
  });
  test('construye item con defaults', () => {
    const item = buildCatalogItem('Servicio A');
    expect(item.name).toBe('Servicio A');
    expect(item.category).toBe('product');
    expect(item.status).toBe('active');
    expect(item.currency).toBe('USD');
    expect(item.images).toEqual([]);
    expect(item.tags).toEqual([]);
    expect(item.createdAt).toBeDefined();
  });
  test('aplica opts correctamente', () => {
    const item = buildCatalogItem('Plan Pro', {
      category: 'subscription', status: 'inactive',
      price: 49.99, currency: 'ARS', sku: 'PRO-001',
      tags: ['premium', 'mensual'], stock: 100,
    });
    expect(item.category).toBe('subscription');
    expect(item.status).toBe('inactive');
    expect(item.price).toBe(49.99);
    expect(item.currency).toBe('ARS');
    expect(item.sku).toBe('PRO-001');
    expect(item.tags).toContain('premium');
    expect(item.stock).toBe(100);
  });
  test('limita images a MAX_IMAGES_PER_ITEM', () => {
    const imgs = Array.from({ length: 10 }, (_, i) => 'img' + i);
    const item = buildCatalogItem('Test', { images: imgs });
    expect(item.images.length).toBe(MAX_IMAGES_PER_ITEM);
  });
  test('category invalida cae a product', () => {
    const item = buildCatalogItem('Test', { category: 'invalida' });
    expect(item.category).toBe('product');
  });
  test('price negativo no se asigna', () => {
    const item = buildCatalogItem('Test', { price: -5 });
    expect(item.price).toBeNull();
  });
});

describe('addCatalogItem', () => {
  test('lanza si uid undefined', async () => {
    await expect(addCatalogItem(undefined, 'Test')).rejects.toThrow('uid requerido');
  });
  test('lanza si name undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(addCatalogItem(UID, undefined)).rejects.toThrow('name requerido');
  });
  test('agrega item sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await addCatalogItem(UID, 'Producto Nuevo', { price: 1000, currency: 'ARS' });
    expect(r.docId).toMatch(/^item_/);
    expect(r.item.name).toBe('Producto Nuevo');
    expect(r.item.price).toBe(1000);
    expect(r.item.currency).toBe('ARS');
  });
  test('lanza si catalogo lleno', async () => {
    const docs = {};
    for (let i = 0; i < MAX_ITEMS_PER_CATALOG; i++) {
      docs['item_' + i] = { name: 'Item ' + i, status: 'active' };
    }
    __setFirestoreForTests(makeMockDb({ docs }));
    await expect(addCatalogItem(UID, 'Extra')).rejects.toThrow('catalogo lleno');
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(addCatalogItem(UID, 'Test')).rejects.toThrow('set error');
  });
});

describe('updateCatalogItem', () => {
  test('lanza si uid undefined', async () => {
    await expect(updateCatalogItem(undefined, 'docId', { price: 10 })).rejects.toThrow('uid requerido');
  });
  test('lanza si docId undefined', async () => {
    await expect(updateCatalogItem(UID, undefined, { price: 10 })).rejects.toThrow('docId requerido');
  });
  test('lanza si updates vacio', async () => {
    await expect(updateCatalogItem(UID, 'doc1', {})).rejects.toThrow('sin campos validos');
  });
  test('lanza si status invalido', async () => {
    await expect(updateCatalogItem(UID, 'doc1', { status: 'archivado' })).rejects.toThrow('status invalido');
  });
  test('actualiza campos validos', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateCatalogItem(UID, 'doc1', { price: 99, status: 'inactive' })).resolves.toBeUndefined();
  });
  test('ignora campos no permitidos', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateCatalogItem(UID, 'doc1', { price: 50, malicious: 'hack' })).resolves.toBeUndefined();
  });
});

describe('removeCatalogItem', () => {
  test('lanza si uid undefined', async () => {
    await expect(removeCatalogItem(undefined, 'doc1')).rejects.toThrow('uid requerido');
  });
  test('lanza si docId undefined', async () => {
    await expect(removeCatalogItem(UID, undefined)).rejects.toThrow('docId requerido');
  });
  test('elimina sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(removeCatalogItem(UID, 'doc1')).resolves.toBeUndefined();
  });
});

describe('getCatalogItems', () => {
  test('lanza si uid undefined', async () => {
    await expect(getCatalogItems(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay items', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getCatalogItems(UID)).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getCatalogItems(UID)).toEqual([]);
  });
  test('filtra por status', async () => {
    const docs = {
      'item_1': { name: 'A', status: 'active' },
      'item_2': { name: 'B', status: 'inactive' },
    };
    __setFirestoreForTests(makeMockDb({ docs }));
    const r = await getCatalogItems(UID, { status: 'active' });
    expect(r.length).toBe(1);
    expect(r[0].name).toBe('A');
  });
  test('filtra por search text', async () => {
    const docs = {
      'item_1': { name: 'Plan Premium', status: 'active' },
      'item_2': { name: 'Plan Basic', status: 'active', tags: ['basic'] },
    };
    __setFirestoreForTests(makeMockDb({ docs }));
    const r = await getCatalogItems(UID, { search: 'premium' });
    expect(r.length).toBe(1);
    expect(r[0].name).toBe('Plan Premium');
  });
});

describe('getCatalogItem', () => {
  test('lanza si uid undefined', async () => {
    await expect(getCatalogItem(undefined, 'doc1')).rejects.toThrow('uid requerido');
  });
  test('retorna null si item no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getCatalogItem(UID, 'noexiste')).toBeNull();
  });
  test('fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getCatalogItem(UID, 'doc1')).toBeNull();
  });
});

describe('formatPriceText', () => {
  test('precio null retorna consultar', () => {
    expect(formatPriceText({ price: null })).toBe('Precio a consultar');
  });
  test('precio 0 retorna Gratis', () => {
    expect(formatPriceText({ price: 0 })).toBe('Gratis');
  });
  test('precio con moneda', () => {
    const r = formatPriceText({ price: 1000, currency: 'ARS' });
    expect(r).toContain('ARS');
    expect(r).toContain('1');
  });
});

describe('buildCatalogSummaryText', () => {
  test('catalogo vacio retorna mensaje', () => {
    expect(buildCatalogSummaryText([])).toContain('vacío');
  });
  test('null retorna mensaje', () => {
    expect(buildCatalogSummaryText(null)).toContain('vacío');
  });
  test('incluye items activos', () => {
    const items = [
      { name: 'Producto A', status: 'active', price: 100, currency: 'USD' },
      { name: 'Producto B', status: 'inactive', price: 50, currency: 'USD' },
    ];
    const r = buildCatalogSummaryText(items);
    expect(r).toContain('Producto A');
    expect(r).not.toContain('Producto B');
  });
  test('muestra conteo correcto', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      name: 'Item ' + i, status: 'active', price: i * 10, currency: 'USD',
    }));
    const r = buildCatalogSummaryText(items);
    expect(r).toContain('5');
  });
});

describe('buildItemDetailText', () => {
  test('item null retorna no encontrado', () => {
    expect(buildItemDetailText(null)).toContain('no encontrado');
  });
  test('incluye nombre y precio', () => {
    const item = { name: 'Plan Pro', price: 49, currency: 'USD', status: 'active', tags: [] };
    const r = buildItemDetailText(item);
    expect(r).toContain('Plan Pro');
    expect(r).toContain('USD');
  });
  test('incluye tags', () => {
    const item = { name: 'Test', price: null, status: 'active', tags: ['vip', 'premium'] };
    const r = buildItemDetailText(item);
    expect(r).toContain('vip');
    expect(r).toContain('premium');
  });
  test('muestra estado si no es active', () => {
    const item = { name: 'Test', price: 0, status: 'out_of_stock', tags: [] };
    const r = buildItemDetailText(item);
    expect(r).toContain('out_of_stock');
  });
});

describe('searchCatalogByText', () => {
  const items = [
    { name: 'Hamburguesa Clásica', description: 'Con papas fritas', status: 'active', tags: ['comida'] },
    { name: 'Soda', description: 'Bebida fría', status: 'active', tags: ['bebida'] },
    { name: 'Postre', description: 'Helado artesanal', status: 'inactive', tags: ['dulce'] },
  ];

  test('retorna vacio si query undefined', () => {
    expect(searchCatalogByText(items, undefined)).toEqual([]);
  });
  test('retorna vacio si query < 2 chars', () => {
    expect(searchCatalogByText(items, 'a')).toEqual([]);
  });
  test('encuentra por nombre', () => {
    const r = searchCatalogByText(items, 'hamburguesa');
    expect(r.length).toBe(1);
    expect(r[0].name).toContain('Hamburguesa');
  });
  test('encuentra por tag', () => {
    const r = searchCatalogByText(items, 'bebida');
    expect(r.length).toBe(1);
  });
  test('no retorna items inactivos', () => {
    const r = searchCatalogByText(items, 'helado');
    expect(r.length).toBe(0);
  });
  test('retorna vacio si no hay match', () => {
    expect(searchCatalogByText(items, 'zzznomatch')).toEqual([]);
  });
});
