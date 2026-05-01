'use strict';

const {
  getCatalogProducts, searchCatalog, rankByRelevance,
  tokenize, scoreProduct, MAX_RESULTS, MIN_SCORE, __setFirestoreForTests,
} = require('../core/catalog_search');

const UID = 'testUid1234567890abcdef';

const PRODUCTS = [
  { id: 'p1', name: 'Zapatos deportivos Nike', category: 'calzado', description: 'zapatillas running', tags: ['deporte','running'], active: true, price: 80 },
  { id: 'p2', name: 'Camiseta futbol', category: 'ropa', description: 'camiseta deportiva manga corta', tags: ['deporte','futbol'], active: true, price: 30 },
  { id: 'p3', name: 'Laptop HP ProBook', category: 'tecnologia', description: 'computadora portatil business', tags: ['tech','laptop'], active: true, price: 800 },
  { id: 'p4', name: 'Mesa de madera roble', category: 'muebles', description: 'mesa comedor solida', tags: ['hogar','madera'], active: true, price: 250 },
  { id: 'p5', name: 'Proteina whey chocolate', category: 'nutricion', description: 'suplemento deportivo 2kg', tags: ['deporte','nutricion'], active: true, price: 45 },
];

function makeMockDb({ products = PRODUCTS, throwGet = false } = {}) {
  const docs = products.map(p => ({ id: p.id, data: () => p }));
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          where: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { forEach: fn => docs.forEach(fn) };
            },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('tokenize', () => {
  test('convierte a minusculas y elimina acentos', () => {
    const t = tokenize('Zapatos Deportivos');
    expect(t).toContain('zapatos');
    expect(t).toContain('deportivos');
  });
  test('filtra stop words', () => {
    const t = tokenize('de los zapatos');
    expect(t).not.toContain('de');
    expect(t).not.toContain('los');
    expect(t).toContain('zapatos');
  });
  test('filtra tokens de menos de 2 caracteres', () => {
    const t = tokenize('a b zapatos');
    expect(t).not.toContain('a');
    expect(t).not.toContain('b');
    expect(t).toContain('zapatos');
  });
  test('retorna array vacio para string vacio', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('rankByRelevance', () => {
  test('lanza si products no es array', () => {
    expect(() => rankByRelevance(null, 'query')).toThrow('array');
  });
  test('lanza si query vacio', () => {
    expect(() => rankByRelevance([], '')).toThrow('query requerido');
  });
  test('retorna array vacio si ninguno supera minScore', () => {
    const r = rankByRelevance(PRODUCTS, 'xyzzy unobtainium');
    expect(r.length).toBe(0);
  });
  test('rankea zapatos primero para query deporte running', () => {
    const r = rankByRelevance(PRODUCTS, 'zapatos deporte running');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].id).toBe('p1');
  });
  test('rankea laptop primero para query computadora tech', () => {
    const r = rankByRelevance(PRODUCTS, 'computadora laptop tech');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].id).toBe('p3');
  });
  test('incluye score en cada resultado', () => {
    const r = rankByRelevance(PRODUCTS, 'zapatos');
    for (const item of r) {
      expect(typeof item.score).toBe('number');
      expect(item.score).toBeGreaterThan(0);
    }
  });
  test('ordena por score descendente', () => {
    const r = rankByRelevance(PRODUCTS, 'deporte');
    for (let i = 0; i < r.length - 1; i++) {
      expect(r[i].score).toBeGreaterThanOrEqual(r[i+1].score);
    }
  });
  test('retorna producto original en result.product', () => {
    const r = rankByRelevance(PRODUCTS, 'laptop');
    expect(r[0].product).toBeDefined();
    expect(r[0].product.price).toBe(800);
  });
});

describe('searchCatalog â€” validacion', () => {
  test('lanza si uid undefined', async () => {
    await expect(searchCatalog(undefined, 'zapatos')).rejects.toThrow('uid requerido');
  });
  test('lanza si query undefined', async () => {
    await expect(searchCatalog(UID, undefined)).rejects.toThrow('query requerido');
  });
  test('lanza si query string vacio', async () => {
    await expect(searchCatalog(UID, '')).rejects.toThrow('query requerido');
  });
});

describe('searchCatalog â€” con products inyectados', () => {
  test('retorna array vacio si no hay matches', async () => {
    const r = await searchCatalog(UID, 'xyzzy unobtainium', { products: PRODUCTS });
    expect(r).toEqual([]);
  });
  test('encuentra zapatos con query relevante', async () => {
    const r = await searchCatalog(UID, 'zapatos running deporte', { products: PRODUCTS });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].id).toBe('p1');
  });
  test('respeta maxResults', async () => {
    const r = await searchCatalog(UID, 'deporte', { products: PRODUCTS, maxResults: 2 });
    expect(r.length).toBeLessThanOrEqual(2);
  });
  test('respeta minScore alto filtrando productos con score bajo', async () => {
    const r = await searchCatalog(UID, 'deporte', { products: PRODUCTS, minScore: 0.9 });
    for (const item of r) expect(item.score).toBeGreaterThanOrEqual(0.9);
  });
  test('retorna productos con id, name, score, product', async () => {
    const r = await searchCatalog(UID, 'laptop', { products: PRODUCTS });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]).toHaveProperty('id');
    expect(r[0]).toHaveProperty('name');
    expect(r[0]).toHaveProperty('score');
    expect(r[0]).toHaveProperty('product');
  });
  test('ordena por score descendente', async () => {
    const r = await searchCatalog(UID, 'deporte', { products: PRODUCTS });
    for (let i = 0; i < r.length - 1; i++) {
      expect(r[i].score).toBeGreaterThanOrEqual(r[i+1].score);
    }
  });
  test('retorna vacio si products array vacio', async () => {
    const r = await searchCatalog(UID, 'zapatos', { products: [] });
    expect(r).toEqual([]);
  });
});

describe('getCatalogProducts', () => {
  test('lanza si uid undefined', async () => {
    await expect(getCatalogProducts(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array de productos de Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ products: PRODUCTS }));
    const r = await getCatalogProducts(UID);
    expect(r.length).toBe(PRODUCTS.length);
    expect(r[0].name).toBe('Zapatos deportivos Nike');
  });
  test('fail-open retorna array vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getCatalogProducts(UID);
    expect(r).toEqual([]);
  });
});

describe('scoreProduct', () => {
  test('retorna 0 para producto sin campos de texto', () => {
    const s = scoreProduct({ id: 'x' }, ['zapatos']);
    expect(s).toBe(0);
  });
  test('nombre tiene mas peso que descripcion', () => {
    const p1 = { id: 'a', name: 'zapatos rojos', description: 'running' };
    const p2 = { id: 'b', name: 'running shoes', description: 'zapatos' };
    const s1 = scoreProduct(p1, ['zapatos']);
    const s2 = scoreProduct(p2, ['zapatos']);
    expect(s1).toBeGreaterThan(s2);
  });
  test('partial match (prefijo) otorga score parcial', () => {
    const product = { id: 'a', name: 'zapatillas deportivas' };
    const s = scoreProduct(product, ['zapati']);
    expect(s).toBeGreaterThan(0);
  });
});
