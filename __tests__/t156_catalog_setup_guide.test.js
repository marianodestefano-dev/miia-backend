'use strict';

const {
  getSetupState, processSetupMessage, getWelcomePrompt,
  SETUP_STAGES, STAGE_PROMPTS, __setFirestoreForTests,
} = require('../core/catalog_setup_guide');

const UID = 'testUid1234567890abcdef';

function makeMockDb({ existingState = null, throwGet = false, throwSet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => {
          if (throwGet) throw new Error('get error');
          if (!existingState) return { exists: false };
          return { exists: true, data: () => existingState };
        },
        set: async () => { if (throwSet) throw new Error('set error'); },
      }),
    }),
  };
}

function stateAt(stage, extra) {
  return { uid: UID, stage, products: [], currentProduct: {}, completed: false, startedAt: '2026-05-01T00:00:00Z', ...(extra || {}) };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('SETUP_STAGES', () => {
  test('tiene 6 etapas', () => {
    expect(SETUP_STAGES.length).toBe(6);
    expect(SETUP_STAGES[0]).toBe('start');
    expect(SETUP_STAGES[SETUP_STAGES.length - 1]).toBe('complete');
  });
  test('es frozen', () => {
    expect(() => { SETUP_STAGES.push('x'); }).toThrow();
  });
});

describe('getSetupState', () => {
  test('lanza si uid undefined', async () => {
    await expect(getSetupState(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna estado default si no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    const s = await getSetupState(UID);
    expect(s.stage).toBe('start');
    expect(s.completed).toBe(false);
  });
  test('fail-open retorna default si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const s = await getSetupState(UID);
    expect(s.stage).toBe('start');
  });
});

describe('processSetupMessage â€” flujo completo', () => {
  test('stage start: responde al numero de productos y avanza a naming', async () => {
    const r = await processSetupMessage(UID, '10', { state: stateAt('start') });
    expect(r.stage).toBe('naming');
    expect(r.response).toContain('nombre');
  });
  test('stage start: pide numero si respuesta no es valida', async () => {
    const r = await processSetupMessage(UID, 'muchos', { state: stateAt('start') });
    expect(r.stage).toBe('start');
    expect(r.response).toContain('numero');
  });
  test('stage naming: guarda nombre y avanza a categories', async () => {
    const r = await processSetupMessage(UID, 'Camiseta Roja', { state: stateAt('naming') });
    expect(r.stage).toBe('categories');
    expect(r.state.currentProduct.name).toBe('Camiseta Roja');
  });
  test('stage naming: rechaza nombre de 1 caracter', async () => {
    const r = await processSetupMessage(UID, 'X', { state: stateAt('naming') });
    expect(r.stage).toBe('naming');
  });
  test('stage categories: guarda categoria y avanza a pricing', async () => {
    const state = stateAt('categories', { currentProduct: { name: 'Camisa' } });
    const r = await processSetupMessage(UID, 'ropa', { state });
    expect(r.stage).toBe('pricing');
    expect(r.state.currentProduct.category).toBe('ropa');
  });
  test('stage pricing: guarda precio y avanza a availability', async () => {
    const state = stateAt('pricing', { currentProduct: { name: 'Camisa', category: 'ropa' } });
    const r = await processSetupMessage(UID, '25000', { state });
    expect(r.stage).toBe('availability');
    expect(r.state.currentProduct.price).toBe(25000);
  });
  test('stage pricing: parsea precio con signo $', async () => {
    const state = stateAt('pricing', { currentProduct: { name: 'P', category: 'c' } });
    const r = await processSetupMessage(UID, '$49.99', { state });
    expect(r.state.currentProduct.price).toBe(49.99);
  });
  test('stage pricing: rechaza precio invalido', async () => {
    const state = stateAt('pricing', { currentProduct: { name: 'P', category: 'c' } });
    const r = await processSetupMessage(UID, 'gratis', { state });
    expect(r.stage).toBe('pricing');
  });
  test('stage availability: si -> producto disponible y completa', async () => {
    const state = stateAt('availability', { currentProduct: { name: 'Camisa', category: 'ropa', price: 30 } });
    const r = await processSetupMessage(UID, 'si', { state });
    expect(r.stage).toBe('complete');
    expect(r.state.completed).toBe(true);
    expect(r.products.length).toBe(1);
    expect(r.products[0].name).toBe('Camisa');
    expect(r.products[0].available).toBe(true);
  });
  test('stage availability: no -> producto no disponible', async () => {
    const state = stateAt('availability', { currentProduct: { name: 'X', category: 'y', price: 10 } });
    const r = await processSetupMessage(UID, 'no', { state });
    expect(r.products[0].available).toBe(false);
    expect(r.products[0].stock).toBe(0);
  });
  test('stage complete: responde sin cambiar stage', async () => {
    const r = await processSetupMessage(UID, 'hola', { state: stateAt('complete', { completed: true }) });
    expect(r.stage).toBe('complete');
  });
});

describe('processSetupMessage â€” validacion', () => {
  test('lanza si uid undefined', async () => {
    await expect(processSetupMessage(undefined, 'hola')).rejects.toThrow('uid requerido');
  });
  test('lanza si message undefined', async () => {
    await expect(processSetupMessage(UID, undefined)).rejects.toThrow('message requerido');
  });
});

describe('getWelcomePrompt', () => {
  test('retorna prompt con sector cuando se provee', () => {
    const p = getWelcomePrompt('restaurante');
    expect(p).toContain('restaurante');
    expect(p).toContain('catalogo');
  });
  test('retorna prompt generico sin sector', () => {
    const p = getWelcomePrompt(null);
    expect(p).toContain('catalogo');
  });
});
