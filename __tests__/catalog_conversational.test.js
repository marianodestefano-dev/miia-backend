'use strict';

const cc = require('../core/catalog_conversational');

const UID = 'test_uid_12345';

function makeMockDb({ existing = {}, throwSet = false, throwGet = false } = {}) {
  const docs = Object.assign({}, existing);
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { exists: !!docs[id], data: () => docs[id] || null };
            },
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              docs[id] = Object.assign(docs[id] || {}, data);
            },
            delete: async () => { delete docs[id]; },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            const items = Object.entries(docs).map(([id, d]) => ({ id, data: () => d }));
            return { forEach: fn => items.forEach(fn) };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => { cc.__setFirestoreForTests(null); });
afterEach(() => { cc.__setFirestoreForTests(null); });

describe('addProduct', () => {
  test('uid undefined throw', async () => {
    await expect(cc.addProduct(undefined, { name: 'X', price: 100 })).rejects.toThrow('uid');
  });
  test('productSpec null throw', async () => {
    await expect(cc.addProduct(UID, null)).rejects.toThrow('productSpec');
  });
  test('name vacio throw', async () => {
    await expect(cc.addProduct(UID, { name: '', price: 100 })).rejects.toThrow('name');
  });
  test('name no-string throw', async () => {
    await expect(cc.addProduct(UID, { name: 123, price: 100 })).rejects.toThrow('name');
  });
  test('price no-numero throw', async () => {
    await expect(cc.addProduct(UID, { name: 'X', price: 'mil' })).rejects.toThrow('price');
  });
  test('price negativo throw', async () => {
    await expect(cc.addProduct(UID, { name: 'X', price: -10 })).rejects.toThrow('price');
  });
  test('currency invalida throw', async () => {
    await expect(cc.addProduct(UID, { name: 'X', price: 100, currency: 'XYZ' })).rejects.toThrow('currency');
  });
  test('stock negativo throw', async () => {
    await expect(cc.addProduct(UID, { name: 'X', price: 100, stock: -5 })).rejects.toThrow('stock');
  });
  test('agrega producto basico', async () => {
    cc.__setFirestoreForTests(makeMockDb());
    const r = await cc.addProduct(UID, { name: 'Pizza', price: 12000 });
    expect(r.name).toBe('Pizza');
    expect(r.currency).toBe('ARS');
    expect(r.stock).toBe(0);
    expect(r.id).toBeDefined();
  });
  test('agrega con todos los campos', async () => {
    cc.__setFirestoreForTests(makeMockDb());
    const r = await cc.addProduct(UID, {
      name: '  Cafe  ', price: 1500, currency: 'USD', stock: 50,
      category: 'bebidas', sku: 'CAF001', description: 'Espresso',
    });
    expect(r.name).toBe('Cafe');
    expect(r.currency).toBe('USD');
    expect(r.stock).toBe(50);
    expect(r.category).toBe('bebidas');
  });
  test('id custom respetado', async () => {
    cc.__setFirestoreForTests(makeMockDb());
    const r = await cc.addProduct(UID, { name: 'X', price: 10, id: 'fixed-id' });
    expect(r.id).toBe('fixed-id');
  });
});

describe('updateProduct', () => {
  test('uid undefined throw', async () => {
    await expect(cc.updateProduct(undefined, 'p1', { price: 1 })).rejects.toThrow('uid');
  });
  test('productId undefined throw', async () => {
    await expect(cc.updateProduct(UID, undefined, { price: 1 })).rejects.toThrow('productId');
  });
  test('updates null throw', async () => {
    await expect(cc.updateProduct(UID, 'p1', null)).rejects.toThrow('updates');
  });
  test('price invalido throw', async () => {
    await expect(cc.updateProduct(UID, 'p1', { price: 'mil' })).rejects.toThrow('price');
  });
  test('stock invalido throw', async () => {
    await expect(cc.updateProduct(UID, 'p1', { stock: -1 })).rejects.toThrow('stock');
  });
  test('actualiza sin error', async () => {
    cc.__setFirestoreForTests(makeMockDb());
    const r = await cc.updateProduct(UID, 'p1', { price: 200, stock: 10 });
    expect(r.price).toBe(200);
    expect(r.updatedAt).toBeDefined();
  });
});

describe('removeProduct', () => {
  test('uid undefined throw', async () => {
    await expect(cc.removeProduct(undefined, 'p1')).rejects.toThrow('uid');
  });
  test('productId undefined throw', async () => {
    await expect(cc.removeProduct(UID, undefined)).rejects.toThrow('productId');
  });
  test('elimina sin error', async () => {
    cc.__setFirestoreForTests(makeMockDb({ existing: { p1: { id: 'p1' } } }));
    await expect(cc.removeProduct(UID, 'p1')).resolves.toBeUndefined();
  });
});

describe('getProductById', () => {
  test('uid undefined throw', async () => {
    await expect(cc.getProductById(undefined, 'p1')).rejects.toThrow('uid');
  });
  test('productId undefined throw', async () => {
    await expect(cc.getProductById(UID, undefined)).rejects.toThrow('productId');
  });
  test('doc no existe -> null', async () => {
    cc.__setFirestoreForTests(makeMockDb());
    expect(await cc.getProductById(UID, 'noexiste')).toBeNull();
  });
  test('doc existe -> data', async () => {
    cc.__setFirestoreForTests(makeMockDb({ existing: { p1: { name: 'Pizza' } } }));
    const r = await cc.getProductById(UID, 'p1');
    expect(r.name).toBe('Pizza');
  });
  test('doc existe pero data() returns null', async () => {
    cc.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
        get: async () => ({ exists: true, data: () => null })
      })})})})
    });
    expect(await cc.getProductById(UID, 'p1')).toBeNull();
  });
  test('doc.exists pero sin data fn', async () => {
    cc.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
        get: async () => ({ exists: true })
      })})})})
    });
    expect(await cc.getProductById(UID, 'p1')).toBeNull();
  });
});

describe('getAllProducts', () => {
  test('uid undefined throw', async () => {
    await expect(cc.getAllProducts(undefined)).rejects.toThrow('uid');
  });
  test('no docs -> []', async () => {
    cc.__setFirestoreForTests(makeMockDb());
    expect(await cc.getAllProducts(UID)).toEqual([]);
  });
  test('retorna productos', async () => {
    cc.__setFirestoreForTests(makeMockDb({ existing: {
      p1: { name: 'Pizza', price: 100 },
      p2: { name: 'Cafe', price: 50 },
    }}));
    expect((await cc.getAllProducts(UID)).length).toBe(2);
  });
  test('docs sin data fn -> {} default', async () => {
    cc.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({
        get: async () => ({ forEach: fn => [{id:'x'}].forEach(fn) })
      })})})
    });
    const r = await cc.getAllProducts(UID);
    expect(r.length).toBe(1);
    expect(r[0]).toEqual({});
  });
});

describe('searchProductByName', () => {
  test('uid undefined throw', async () => {
    await expect(cc.searchProductByName(undefined, 'pizza')).rejects.toThrow('uid');
  });
  test('query undefined -> []', async () => {
    expect(await cc.searchProductByName(UID, undefined)).toEqual([]);
  });
  test('query no-string -> []', async () => {
    expect(await cc.searchProductByName(UID, 123)).toEqual([]);
  });
  test('encuentra producto por nombre parcial', async () => {
    cc.__setFirestoreForTests(makeMockDb({ existing: {
      p1: { name: 'Pizza Muzzarella', price: 100 },
      p2: { name: 'Cafe', price: 50 },
    }}));
    const r = await cc.searchProductByName(UID, 'pizza');
    expect(r.length).toBe(1);
  });
  test('case insensitive', async () => {
    cc.__setFirestoreForTests(makeMockDb({ existing: {
      p1: { name: 'Pizza', price: 100 },
    }}));
    const r = await cc.searchProductByName(UID, 'PIZZA');
    expect(r.length).toBe(1);
  });
  test('producto sin name no matchea', async () => {
    cc.__setFirestoreForTests(makeMockDb({ existing: {
      p1: { price: 100 },
    }}));
    expect(await cc.searchProductByName(UID, 'pizza')).toEqual([]);
  });
});

describe('parseAddProductCommand', () => {
  test('text null -> null', () => {
    expect(cc.parseAddProductCommand(null)).toBeNull();
  });
  test('text no-string -> null', () => {
    expect(cc.parseAddProductCommand(123)).toBeNull();
  });
  test('texto sin trigger -> null', () => {
    expect(cc.parseAddProductCommand('hola que tal')).toBeNull();
  });
  test('trigger sin contenido -> null', () => {
    expect(cc.parseAddProductCommand('MIIA agregalo:')).toBeNull();
  });
  test('parsea Pizza con $12000', () => {
    const r = cc.parseAddProductCommand('MIIA agregalo: Pizza Muzzarella $12000 stock 50');
    expect(r.name).toBe('Pizza Muzzarella');
    expect(r.price).toBe(12000);
    expect(r.stock).toBe(50);
  });
  test('parsea sin stock', () => {
    const r = cc.parseAddProductCommand('agregalo: Cafe $1500');
    expect(r.name).toBe('Cafe');
    expect(r.price).toBe(1500);
    expect(r.stock).toBeUndefined();
  });
  test('parsea con "precio" en vez de $', () => {
    const r = cc.parseAddProductCommand('MIIA agregar producto: Hamburguesa precio 8000 stock 30');
    expect(r.name).toBe('Hamburguesa');
    expect(r.price).toBe(8000);
    expect(r.stock).toBe(30);
  });
  test('parsea con categoria', () => {
    const r = cc.parseAddProductCommand('agregalo: Coca cola $2000 stock 100 categoria bebidas');
    expect(r.name.toLowerCase()).toContain('coca');
    expect(r.price).toBe(2000);
    expect(r.category).toBe('bebidas');
  });
  test('decimales con coma', () => {
    const r = cc.parseAddProductCommand('agregalo: Cafe $15,5');
    expect(r.price).toBe(15.5);
  });
  test('decimales con punto', () => {
    const r = cc.parseAddProductCommand('agregalo: Cafe $15.50');
    expect(r.price).toBe(15.5);
  });
  test('sin precio -> null', () => {
    expect(cc.parseAddProductCommand('agregalo: Producto sin precio')).toBeNull();
  });
  test('sin nombre -> null', () => {
    expect(cc.parseAddProductCommand('agregalo: $1000')).toBeNull();
  });
  test('agregar producto: trigger', () => {
    const r = cc.parseAddProductCommand('agregar producto: Tacos $5000');
    expect(r.name).toBe('Tacos');
    expect(r.price).toBe(5000);
  });
});

describe('VALID_CURRENCIES', () => {
  test('frozen', () => {
    expect(() => { cc.VALID_CURRENCIES.push('XX'); }).toThrow();
  });
  test('contiene ARS USD COP', () => {
    expect(cc.VALID_CURRENCIES).toContain('ARS');
    expect(cc.VALID_CURRENCIES).toContain('USD');
    expect(cc.VALID_CURRENCIES).toContain('COP');
  });
  test('DEFAULT_CURRENCY es ARS', () => {
    expect(cc.DEFAULT_CURRENCY).toBe('ARS');
  });
});
