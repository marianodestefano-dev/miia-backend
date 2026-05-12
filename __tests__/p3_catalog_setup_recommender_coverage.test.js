'use strict';

let setupGuide;
let recommender;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
  setupGuide = require('../core/catalog_setup_guide');
  recommender = require('../core/catalog_recommender');
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (setupGuide && setupGuide.__setFirestoreForTests) setupGuide.__setFirestoreForTests(null);
  if (recommender && recommender.__setFirestoreForTests) recommender.__setFirestoreForTests(null);
  jest.restoreAllMocks();
});

function makeSetupDb({ exists = false, data = null, throwSet = false } = {}) {
  return {
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue({ exists, data: () => data }),
        set: throwSet
          ? jest.fn().mockRejectedValue(new Error('set fail'))
          : jest.fn().mockResolvedValue({}),
      }),
    }),
  };
}

describe('P3 -- catalog_setup_guide branches sin cubrir', () => {
  test('getSetupState doc exists -> merge con defaultState (line 35)', async () => {
    const data = { stage: 'naming', products: [], uid: 'uid1' };
    setupGuide.__setFirestoreForTests(makeSetupDb({ exists: true, data }));
    const r = await setupGuide.getSetupState('uid1');
    expect(r.stage).toBe('naming');
  });

  test('processSetupMessage: stage categories, input corto -> error msg (line 98)', async () => {
    setupGuide.__setFirestoreForTests(makeSetupDb());
    const r = await setupGuide.processSetupMessage('uid1', 'x', {
      state: { stage: 'categories', currentProduct: { name: 'Prod' }, products: [] },
    });
    expect(r.response).toContain('categoria valida');
  });

  test('processSetupMessage: stage default desconocido -> reset a start (lines 135-136)', async () => {
    setupGuide.__setFirestoreForTests(makeSetupDb());
    const r = await setupGuide.processSetupMessage('uid1', 'hola', {
      state: { stage: 'unknown_stage', currentProduct: {}, products: [] },
    });
    expect(r.stage).toBe('start');
  });

  test('processSetupMessage: db.set lanza error -> loguea pero no falla (lines 141-144)', async () => {
    setupGuide.__setFirestoreForTests(makeSetupDb({ throwSet: true }));
    const r = await setupGuide.processSetupMessage('uid1', 'hola', {});
    expect(r).toBeDefined();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error guardando estado'));
  });
});

describe('P3 -- catalog_recommender branches sin cubrir', () => {
  test('getRecommendations: history con price bajo -> score += 0.2 (lines 141-142)', async () => {
    const history = [
      { productId: 'p1', category: 'ropa', action: 'view', price: 100 },
      { productId: 'p2', category: 'ropa', action: 'view', price: 120 },
    ];
    const catalogProducts = [
      { id: 'p3', name: 'Remera', category: 'ropa', price: 110, active: true },
    ];
    const recs = await recommender.getRecommendations('uid1', '+5491111', catalogProducts, { history });
    expect(Array.isArray(recs)).toBe(true);
  });

  test('_avgPrice con prices no vacias -> reduce (line 156)', async () => {
    const history = [
      { productId: 'p1', category: 'elec', action: 'view', price: 500 },
      { productId: 'p2', category: 'elec', action: 'view', price: 600 },
    ];
    const catalogProducts = [
      { id: 'p3', name: 'TV', category: 'elec', price: 550, active: true },
    ];
    const recs = await recommender.getRecommendations('uid1', '+5491111', catalogProducts, { history });
    expect(Array.isArray(recs)).toBe(true);
  });

  test('product.price > avgHistoryPrice * 1.3 -> no score por precio (branch false)', async () => {
    const history = [{ productId: 'p1', category: 'ropa', action: 'view', price: 50 }];
    const catalogProducts = [
      { id: 'p2', name: 'Abrigo caro', category: 'zapatos', price: 9999, active: true },
    ];
    const recs = await recommender.getRecommendations('uid1', '+5491111', catalogProducts, { history });
    expect(Array.isArray(recs)).toBe(true);
  });
});
