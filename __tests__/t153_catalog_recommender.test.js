'use strict';

const {
  getLeadHistory, recordInteraction, getRecommendations,
  MAX_RECOMMENDATIONS, HISTORY_LIMIT,
  __setFirestoreForTests, _buildProfile, _scoreForLead,
} = require('../core/catalog_recommender');

const UID = 'testUid1234567890abcdef';
const PHONE = '+573001234567';

const CATALOG = [
  { id: 'p1', name: 'Zapatos Nike', category: 'calzado', price: 80 },
  { id: 'p2', name: 'Camiseta', category: 'ropa', price: 30 },
  { id: 'p3', name: 'Laptop HP', category: 'tecnologia', price: 800 },
  { id: 'p4', name: 'Mesa madera', category: 'muebles', price: 250 },
  { id: 'p5', name: 'Tenis Adidas', category: 'calzado', price: 70 },
];

function makeMockDb({ historyData = null, throwGet = false, throwSet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              if (!historyData) return { exists: false };
              return { exists: true, data: () => historyData };
            },
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
            },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('getLeadHistory â€” validacion', () => {
  test('lanza si uid undefined', async () => {
    await expect(getLeadHistory(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(getLeadHistory(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('retorna array vacio si no existe doc', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getLeadHistory(UID, PHONE);
    expect(r).toEqual([]);
  });
  test('retorna interacciones del historial', async () => {
    const interactions = [
      { productId: 'p1', category: 'calzado', action: 'view', timestamp: '2026-05-01T10:00:00Z' },
    ];
    __setFirestoreForTests(makeMockDb({ historyData: { interactions } }));
    const r = await getLeadHistory(UID, PHONE);
    expect(r.length).toBe(1);
    expect(r[0].productId).toBe('p1');
  });
  test('fail-open retorna array vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getLeadHistory(UID, PHONE);
    expect(r).toEqual([]);
  });
});

describe('recordInteraction â€” validacion', () => {
  test('lanza si uid undefined', async () => {
    await expect(recordInteraction(undefined, PHONE, { productId: 'p1' })).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(recordInteraction(UID, undefined, { productId: 'p1' })).rejects.toThrow('phone requerido');
  });
  test('lanza si interaction.productId undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordInteraction(UID, PHONE, {})).rejects.toThrow('productId requerido');
  });
  test('guarda interaccion sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordInteraction(UID, PHONE, { productId: 'p1', category: 'calzado', action: 'view' })).resolves.toBeUndefined();
  });
  test('lanza si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordInteraction(UID, PHONE, { productId: 'p1' })).rejects.toThrow('set error');
  });
});

describe('_buildProfile', () => {
  test('cuenta correctamente categorias por accion', () => {
    const history = [
      { productId: 'p1', category: 'calzado', action: 'view' },
      { productId: 'p5', category: 'calzado', action: 'purchase' },
      { productId: 'p2', category: 'ropa', action: 'inquiry' },
    ];
    const profile = _buildProfile(history);
    expect(profile.categoryCounts['calzado']).toBe(4); // 1 view + 3 purchase
    expect(profile.categoryCounts['ropa']).toBe(2); // 1 inquiry
    expect(profile.viewedProducts.has('p1')).toBe(true);
    expect(profile.purchasedProducts.has('p5')).toBe(true);
  });
  test('array vacio retorna profile vacio', () => {
    const profile = _buildProfile([]);
    expect(Object.keys(profile.categoryCounts).length).toBe(0);
    expect(profile.viewedProducts.size).toBe(0);
  });
});

describe('getRecommendations', () => {
  test('lanza si uid undefined', async () => {
    await expect(getRecommendations(undefined, PHONE, [])).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(getRecommendations(UID, undefined, [])).rejects.toThrow('phone requerido');
  });
  test('lanza si catalogProducts no es array', async () => {
    await expect(getRecommendations(UID, PHONE, null)).rejects.toThrow('array');
  });
  test('retorna vacio con catalogo vacio', async () => {
    const r = await getRecommendations(UID, PHONE, [], { history: [] });
    expect(r).toEqual([]);
  });
  test('recomienda productos de categoria preferida', async () => {
    const history = [
      { productId: 'p1', category: 'calzado', action: 'view' },
      { productId: 'p1', category: 'calzado', action: 'inquiry' },
    ];
    const r = await getRecommendations(UID, PHONE, CATALOG, { history, maxResults: 5 });
    const calzado = r.filter(x => x.product.category === 'calzado');
    expect(calzado.length).toBeGreaterThan(0);
    expect(calzado[0].score).toBeGreaterThan(r.find(x => x.product.category === 'tecnologia')?.score || -1);
  });
  test('no recomienda productos ya comprados', async () => {
    const history = [{ productId: 'p1', category: 'calzado', action: 'purchase' }];
    const r = await getRecommendations(UID, PHONE, CATALOG, { history });
    expect(r.find(x => x.product.id === 'p1')).toBeUndefined();
  });
  test('no recomienda producto visto 3+ veces', async () => {
    const history = [
      { productId: 'p3', category: 'tecnologia', action: 'view' },
      { productId: 'p3', category: 'tecnologia', action: 'view' },
      { productId: 'p3', category: 'tecnologia', action: 'view' },
    ];
    const r = await getRecommendations(UID, PHONE, CATALOG, { history });
    expect(r.find(x => x.product.id === 'p3')).toBeUndefined();
  });
  test('respeta maxResults', async () => {
    const r = await getRecommendations(UID, PHONE, CATALOG, { history: [], maxResults: 2 });
    expect(r.length).toBeLessThanOrEqual(2);
  });
  test('incluye score y reason en cada resultado', async () => {
    const r = await getRecommendations(UID, PHONE, CATALOG, { history: [] });
    for (const item of r) {
      expect(typeof item.score).toBe('number');
      expect(typeof item.reason).toBe('string');
    }
  });
});
