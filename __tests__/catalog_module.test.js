'use strict';
/**
 * R16-A — catalog_module.test.js
 * 100% branch coverage: detectProductQuery + buildCatalogContext + addToCart + closePedido
 */

// ── Firestore mock ────────────────────────────────────────────────────────────
let mockCatalogDocs = [];
let mockCatalogQueryThrows = false;
let mockPedidoAddThrows = false;
let lastPedidoAdded = null;

const mockFs = {
  collection: () => ({
    doc: () => ({
      collection: (sub) => ({
        where: () => ({
          get: () => {
            if (sub === 'catalog') {
              if (mockCatalogQueryThrows) return Promise.reject(new Error('CATALOG-FAIL'));
              return Promise.resolve({
                empty: mockCatalogDocs.length === 0,
                forEach: (fn) => mockCatalogDocs.forEach(fn),
              });
            }
            return Promise.resolve({ empty: true, forEach: () => {} });
          },
        }),
        add: (data) => {
          if (sub === 'pedidos') {
            if (mockPedidoAddThrows) return Promise.reject(new Error('PEDIDO-FAIL'));
            lastPedidoAdded = data;
            return Promise.resolve({ id: 'pedido-abc-123' });
          }
          return Promise.resolve({ id: 'mock-id' });
        },
      }),
    }),
  }),
};

const {
  detectProductQuery,
  buildCatalogContext,
  addToCart,
  closePedido,
  CATALOG_TAGS,
  MAX_RESULTS,
  MIN_SCORE,
  __setFirestoreForTests,
} = require('../core/mod_catalog');
__setFirestoreForTests(mockFs);

function makeProduct(overrides) {
  return Object.assign({
    id: 'prod-1',
    name: 'Remera negra',
    description: 'Remera de algodon negra',
    price: 25,
    currency: 'USD',
    stock: true,
    active: true,
    keywords: ['remera', 'negro', 'algodon'],
  }, overrides);
}

beforeEach(() => {
  mockCatalogDocs = [];
  mockCatalogQueryThrows = false;
  mockPedidoAddThrows = false;
  lastPedidoAdded = null;
});

// ── detectProductQuery ────────────────────────────────────────────────────────
describe('detectProductQuery', () => {
  test('retorna [] si mensaje vacio', () => {
    expect(detectProductQuery('', [makeProduct()])).toEqual([]);
  });

  test('retorna [] si catalogItems vacio', () => {
    expect(detectProductQuery('remera negra', [])).toEqual([]);
  });

  test('retorna [] si catalogItems no es array (null)', () => {
    expect(detectProductQuery('remera', null)).toEqual([]);
  });

  test('retorna [] si todos los terminos tienen < 3 chars', () => {
    expect(detectProductQuery('al de', [makeProduct()])).toEqual([]);
  });

  test('retorna producto que matchea por nombre', () => {
    const items = [makeProduct()];
    const r = detectProductQuery('quiero una remera', items);
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('prod-1');
  });

  test('retorna producto que matchea por keyword', () => {
    const items = [makeProduct()];
    const r = detectProductQuery('algo de algodon', items);
    expect(r).toHaveLength(1);
  });

  test('excluye productos con active=false', () => {
    const items = [makeProduct({ active: false })];
    expect(detectProductQuery('remera algodon', items)).toEqual([]);
  });

  test('excluye productos sin score suficiente (score < MIN_SCORE)', () => {
    const items = [makeProduct({ name: 'zapato blanco', description: 'calzado deportivo', keywords: [] })];
    expect(detectProductQuery('remera algodon', items)).toEqual([]);
  });

  test('ordena por score descendente', () => {
    const p1 = makeProduct({ id: 'p1', name: 'Remera negra algodon', keywords: ['remera'] });
    const p2 = makeProduct({ id: 'p2', name: 'Remera basica', description: 'remera', keywords: [] });
    const r = detectProductQuery('remera algodon basica', [p1, p2]);
    expect(r[0].id).toBe('p1');
  });

  test('limita a MAX_RESULTS resultados', () => {
    const items = Array.from({ length: 10 }, function (_, i) {
      return makeProduct({ id: 'p' + i, name: 'Remera ' + i, keywords: ['remera', 'algodon'] });
    });
    const r = detectProductQuery('remera algodon', items);
    expect(r).toHaveLength(MAX_RESULTS);
  });

  test('producto con null en prop no lanza', () => {
    const items = [makeProduct({ id: 'p-null', name: null, description: null, keywords: null })];
    expect(detectProductQuery('remera', items)).toEqual([]);
  });

  test('array con null en un item no lanza', () => {
    const items = [null, makeProduct()];
    const r = detectProductQuery('remera', items);
    expect(r).toHaveLength(1);
  });
});

// ── buildCatalogContext ────────────────────────────────────────────────────────
describe('buildCatalogContext', () => {
  test('retorna string vacio si uid vacio', async () => {
    expect(await buildCatalogContext('')).toBe('');
  });

  test('retorna string vacio si catalogo vacio (snap.empty=true)', async () => {
    mockCatalogDocs = [];
    expect(await buildCatalogContext('uid-abc')).toBe('');
  });

  test('retorna string vacio si Firestore falla', async () => {
    mockCatalogQueryThrows = true;
    expect(await buildCatalogContext('uid-abc')).toBe('');
  });

  test('retorna bloque formateado con producto con precio y stock', async () => {
    mockCatalogDocs = [
      { id: 'p1', data: () => ({ name: 'Remera', description: 'Bonita', price: 25, currency: 'USD', stock: true, keywords: [] }) },
    ];
    const r = await buildCatalogContext('uid-abc');
    expect(r).toContain('CATALOGO DE PRODUCTOS');
    expect(r).toContain('Remera');
    expect(r).toContain('USD 25');
    expect(r).not.toContain('SIN STOCK');
  });

  test('producto sin precio no incluye priceStr', async () => {
    mockCatalogDocs = [
      { id: 'p1', data: () => ({ name: 'Servicio', description: 'Consulta', price: null, stock: true, keywords: [] }) },
    ];
    const r = await buildCatalogContext('uid-abc');
    expect(r).toContain('Servicio');
    expect(r).not.toContain('USD');
  });

  test('producto sin stock incluye [SIN STOCK]', async () => {
    mockCatalogDocs = [
      { id: 'p1', data: () => ({ name: 'Producto agotado', description: '', price: 10, stock: false, keywords: [] }) },
    ];
    const r = await buildCatalogContext('uid-abc');
    expect(r).toContain('SIN STOCK');
  });

  test('producto sin descripcion omite linea descripcion', async () => {
    mockCatalogDocs = [
      { id: 'p1', data: () => ({ name: 'Prod sin desc', description: '', price: 5, stock: true, keywords: [] }) },
    ];
    const r = await buildCatalogContext('uid-abc');
    expect(r).toContain('Prod sin desc');
  });

  test('multiples productos numerados correctamente', async () => {
    mockCatalogDocs = [
      { id: 'p1', data: () => ({ name: 'A', description: 'desc a', price: 1, stock: true, keywords: [] }) },
      { id: 'p2', data: () => ({ name: 'B', description: 'desc b', price: 2, stock: true, keywords: [] }) },
    ];
    const r = await buildCatalogContext('uid-abc');
    expect(r).toContain('1. *A*');
    expect(r).toContain('2. *B*');
  });

  test('doc sin currency usa USD default', async () => {
    mockCatalogDocs = [
      { id: 'p1', data: () => ({ name: 'X', description: 'd', price: 9, stock: true, keywords: ['x'] }) },
    ];
    const r = await buildCatalogContext('uid-abc');
    expect(r).toContain('USD 9');
  });

  test('doc con name null usa string vacio (linea 80 right arm)', async () => {
    mockCatalogDocs = [
      { id: 'p1', data: () => ({ name: null, description: 'desc', price: 5, stock: true, keywords: [] }) },
    ];
    const r = await buildCatalogContext('uid-abc');
    expect(r).toContain('CATALOGO DE PRODUCTOS');
  });

  test('doc con keywords no-array usa [] (linea 85 right arm)', async () => {
    mockCatalogDocs = [
      { id: 'p1', data: () => ({ name: 'Prod', description: 'desc', price: 5, stock: true, keywords: 'no-array' }) },
    ];
    const r = await buildCatalogContext('uid-abc');
    expect(r).toContain('Prod');
  });
});

// ── addToCart ─────────────────────────────────────────────────────────────────
describe('addToCart', () => {
  test('error si producto no encontrado en catalogItems', () => {
    const r = addToCart([], 'prod-no-existe', 1, [makeProduct()]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('producto_no_encontrado');
  });

  test('error si producto sin stock', () => {
    const items = [makeProduct({ id: 'p1', stock: false })];
    const r = addToCart([], 'p1', 1, items);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('sin_stock');
  });

  test('agrega producto nuevo al carrito vacio', () => {
    const items = [makeProduct({ id: 'p1' })];
    const r = addToCart([], 'p1', 2, items);
    expect(r.ok).toBe(true);
    expect(r.carrito).toHaveLength(1);
    expect(r.carrito[0].cantidad).toBe(2);
    expect(r.carrito[0].productId).toBe('p1');
  });

  test('agrega producto nuevo al carrito con items existentes', () => {
    const items = [makeProduct({ id: 'p1' }), makeProduct({ id: 'p2', name: 'Pantalon', keywords: [] })];
    const existing = [{ productId: 'p2', nombre: 'Pantalon', precio: 25, currency: 'USD', cantidad: 1 }];
    const r = addToCart(existing, 'p1', 1, items);
    expect(r.carrito).toHaveLength(2);
  });

  test('acumula cantidad si producto ya esta en carrito', () => {
    const items = [makeProduct({ id: 'p1' })];
    const existing = [{ productId: 'p1', nombre: 'Remera negra', precio: 25, currency: 'USD', cantidad: 1 }];
    const r = addToCart(existing, 'p1', 3, items);
    expect(r.carrito[0].cantidad).toBe(4);
  });

  test('cantidad invalida se trata como 1', () => {
    const items = [makeProduct({ id: 'p1' })];
    const r = addToCart([], 'p1', 'abc', items);
    expect(r.carrito[0].cantidad).toBe(1);
  });

  test('cantidad 0 se trata como 1 (min 1)', () => {
    const items = [makeProduct({ id: 'p1' })];
    const r = addToCart([], 'p1', 0, items);
    expect(r.carrito[0].cantidad).toBe(1);
  });

  test('carrito null se trata como [] (no lanza)', () => {
    const items = [makeProduct({ id: 'p1' })];
    const r = addToCart(null, 'p1', 1, items);
    expect(r.ok).toBe(true);
  });

  test('catalogItems null se trata como [] -> producto no encontrado', () => {
    const r = addToCart([], 'p1', 1, null);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('producto_no_encontrado');
  });

  test('producto sin currency usa USD default (linea 123 right arm)', () => {
    const items = [makeProduct({ id: 'p1', currency: undefined })];
    const r = addToCart([], 'p1', 1, items);
    expect(r.ok).toBe(true);
    expect(r.carrito[0].currency).toBe('USD');
  });
});

// ── closePedido ───────────────────────────────────────────────────────────────
describe('closePedido', () => {
  test('lanza si carrito vacio', async () => {
    await expect(closePedido('uid', 'phone', [])).rejects.toThrow('carrito_vacio');
  });

  test('lanza si carrito null', async () => {
    await expect(closePedido('uid', 'phone', null)).rejects.toThrow('carrito_vacio');
  });

  test('lanza si Firestore add falla', async () => {
    mockPedidoAddThrows = true;
    const cart = [{ productId: 'p1', nombre: 'X', precio: 10, currency: 'USD', cantidad: 1 }];
    await expect(closePedido('uid', 'phone', cart)).rejects.toThrow('PEDIDO-FAIL');
  });

  test('persiste pedido y retorna pedidoId + total', async () => {
    const cart = [
      { productId: 'p1', nombre: 'Remera', precio: 25, currency: 'USD', cantidad: 2 },
      { productId: 'p2', nombre: 'Pantalon', precio: 50, currency: 'USD', cantidad: 1 },
    ];
    const r = await closePedido('uid-test-1', '573001234567', cart);
    expect(r.pedidoId).toBe('pedido-abc-123');
    expect(r.total).toBe(100);
    expect(r.currency).toBe('USD');
    expect(lastPedidoAdded).not.toBeNull();
    expect(lastPedidoAdded.status).toBe('pendiente');
  });

  test('total correcto con precio null (precio 0)', async () => {
    const cart = [{ productId: 'p1', nombre: 'Gratis', precio: null, currency: 'ARS', cantidad: 2 }];
    const r = await closePedido('uid', 'phone', cart);
    expect(r.total).toBe(0);
    expect(r.currency).toBe('ARS');
  });

  test('cart item sin currency usa USD (linea 138 right arm)', async () => {
    const cart = [{ productId: 'p1', nombre: 'X', precio: 10, cantidad: 1 }];
    const r = await closePedido('uid', 'phone', cart);
    expect(r.currency).toBe('USD');
  });

  test('cart item con cantidad 0 usa 1 (linea 139 right arm)', async () => {
    const cart = [{ productId: 'p1', nombre: 'X', precio: 5, currency: 'USD', cantidad: 0 }];
    const r = await closePedido('uid', 'phone', cart);
    expect(r.total).toBe(5);
  });
});

// ── CATALOG_TAGS regex ────────────────────────────────────────────────────────
describe('CATALOG_TAGS regex', () => {
  test('AGREGAR_CARRITO matchea formato correcto', () => {
    const m = '[AGREGAR_A_CARRITO:prod-123|2]'.match(CATALOG_TAGS.AGREGAR_CARRITO);
    expect(m).not.toBeNull();
    expect(m[1]).toBe('prod-123');
    expect(m[2]).toBe('2');
  });

  test('CERRAR_PEDIDO matchea formato correcto', () => {
    const m = '[CERRAR_PEDIDO:{"items":[]}]'.match(CATALOG_TAGS.CERRAR_PEDIDO);
    expect(m).not.toBeNull();
  });

  test('MOSTRAR_CATALOGO matchea sin categoria', () => {
    const m = '[MOSTRAR_CATALOGO]'.match(CATALOG_TAGS.MOSTRAR_CATALOGO);
    expect(m).not.toBeNull();
  });

  test('MOSTRAR_CATALOGO matchea con categoria', () => {
    const m = '[MOSTRAR_CATALOGO:ropa]'.match(CATALOG_TAGS.MOSTRAR_CATALOGO);
    expect(m).not.toBeNull();
    expect(m[1]).toBe('ropa');
  });

  test('MAX_RESULTS y MIN_SCORE exportados correctamente', () => {
    expect(MAX_RESULTS).toBe(5);
    expect(MIN_SCORE).toBe(1);
  });
});
