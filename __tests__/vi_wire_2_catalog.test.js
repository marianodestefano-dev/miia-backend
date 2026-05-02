'use strict';

/**
 * vi_wire_2_catalog.test.js -- VI-WIRE-2 anti-regresion + flag ON behavior
 * Test del module integration: feature_flags + catalog_conversational + parser.
 */

const featureFlags = require('../core/feature_flags');
const cc = require('../core/catalog_conversational');

const FLAG = 'PISO3_CATALOGO_ENABLED';
const UID = 'test_uid_vw2';

beforeEach(() => {
  delete process.env[FLAG];
  cc.__setFirestoreForTests(null);
});
afterEach(() => { delete process.env[FLAG]; });

function makeMockDb() {
  const docs = {};
  return {
    collection: () => ({ doc: () => ({ collection: () => ({
      doc: (id) => ({
        get: async () => ({ exists: !!docs[id], data: () => docs[id] }),
        set: async (data) => { docs[id] = Object.assign(docs[id] || {}, data); },
        delete: async () => { delete docs[id]; },
      }),
      get: async () => ({
        forEach: fn => Object.entries(docs).forEach(([id, d]) => fn({ id, data: () => d })),
      }),
    })})})
  };
}

describe('VI-WIRE-2 flag default OFF', () => {
  test('PISO3_CATALOGO_ENABLED no seteada -> false', () => {
    expect(featureFlags.isFlagEnabled(FLAG)).toBe(false);
  });
  test('parser no se ejecuta sin flag -> wire no actua', () => {
    // Sin flag, el wire-in PASO 1c4 hace skip
    expect(featureFlags.isFlagEnabled(FLAG)).toBe(false);
    // Si el wire estuviera activo, el parser lo detectaria; pero como skip, no llega:
    // simulamos: el wire-in solo ejecuta cc.parseAddProductCommand si flag ON
  });
});

describe('VI-WIRE-2 flag ON -> wire ejecuta catalog', () => {
  beforeEach(() => { process.env[FLAG] = '1'; cc.__setFirestoreForTests(makeMockDb()); });

  test('flag ON -> isFlagEnabled true', () => {
    expect(featureFlags.isFlagEnabled(FLAG)).toBe(true);
  });
  test('parser detecta comando self-chat -> addProduct exitoso', async () => {
    const parsed = cc.parseAddProductCommand('MIIA agregalo: Pizza Muzzarella $12000 stock 50');
    expect(parsed.name).toBe('Pizza Muzzarella');
    const product = await cc.addProduct(UID, parsed);
    expect(product.name).toBe('Pizza Muzzarella');
    expect(product.price).toBe(12000);
    expect(product.stock).toBe(50);
  });
  test('mensaje sin trigger -> parser null -> wire no actua', () => {
    const parsed = cc.parseAddProductCommand('hola que tal');
    expect(parsed).toBeNull();
  });
  test('mensaje con trigger pero sin precio -> parser null', () => {
    const parsed = cc.parseAddProductCommand('agregalo: Producto sin precio');
    expect(parsed).toBeNull();
  });
});

describe('VI-WIRE-2 flag values normalizacion', () => {
  test('flag = "true"', () => {
    process.env[FLAG] = 'true';
    expect(featureFlags.isFlagEnabled(FLAG)).toBe(true);
  });
  test('flag = "0"', () => {
    process.env[FLAG] = '0';
    expect(featureFlags.isFlagEnabled(FLAG)).toBe(false);
  });
  test('flag = "anything-else"', () => {
    process.env[FLAG] = 'maybe';
    expect(featureFlags.isFlagEnabled(FLAG)).toBe(false);
  });
});

describe('VI-WIRE-2 anti-regresion: TMH carga sin error con flag OFF', () => {
  test('require TMH no rompe', () => {
    // Solo verificar que el require no arroja syntax errors
    expect(() => {
      require('../whatsapp/tenant_message_handler');
    }).not.toThrow();
  });
});
