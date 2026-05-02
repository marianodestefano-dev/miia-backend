'use strict';

const ow = require('../core/onboarding_wizard');

const UID = 'test_uid';

function makeMockDb({ existing = null, throwGet = false, throwSet = false } = {}) {
  let stored = existing;
  return {
    collection: () => ({ doc: () => ({ collection: () => ({
      doc: () => ({
        get: async () => {
          if (throwGet) throw new Error('get error');
          return { exists: !!stored, data: () => stored || null };
        },
        set: async (data, opts) => {
          if (throwSet) throw new Error('set error');
          stored = Object.assign(stored || {}, data);
        },
      }),
    })})})
  };
}

beforeEach(() => { ow.__setFirestoreForTests(null); });
afterEach(() => { ow.__setFirestoreForTests(null); });

describe('STEPS y VERTICALS y DISCLAIMER_MODES', () => {
  test('STEPS frozen', () => { expect(() => { ow.STEPS.push('x'); }).toThrow(); });
  test('VERTICALS frozen', () => { expect(() => { ow.VERTICALS.push('x'); }).toThrow(); });
  test('DISCLAIMER_MODES frozen', () => { expect(() => { ow.DISCLAIMER_MODES.push('x'); }).toThrow(); });
  test('STEPS contiene business_info y test_message', () => {
    expect(ow.STEPS).toContain('business_info');
    expect(ow.STEPS).toContain('test_message');
  });
});

describe('startOnboarding', () => {
  test('uid undefined throw', async () => {
    await expect(ow.startOnboarding(undefined)).rejects.toThrow('uid');
  });
  test('inicia con currentStep business_info', async () => {
    ow.__setFirestoreForTests(makeMockDb());
    const r = await ow.startOnboarding(UID);
    expect(r.currentStep).toBe('business_info');
    expect(r.completedSteps).toEqual([]);
  });
});

describe('saveStep validations', () => {
  test('uid undefined throw', async () => {
    await expect(ow.saveStep(undefined, 'business_info', {})).rejects.toThrow('uid');
  });
  test('step invalido throw', async () => {
    await expect(ow.saveStep(UID, 'paso_falso', {})).rejects.toThrow('step invalido');
  });
  test('data null throw', async () => {
    await expect(ow.saveStep(UID, 'business_info', null)).rejects.toThrow('data');
  });
  test('business_info sin name throw', async () => {
    await expect(ow.saveStep(UID, 'business_info', { vertical: 'food' })).rejects.toThrow('name');
  });
  test('business_info sin vertical throw', async () => {
    await expect(ow.saveStep(UID, 'business_info', { name: 'X' })).rejects.toThrow('vertical');
  });
  test('business_info vertical invalida throw', async () => {
    await expect(ow.saveStep(UID, 'business_info', { name: 'X', vertical: 'xx' })).rejects.toThrow('vertical invalida');
  });
  test('hours sin timezone throw', async () => {
    await expect(ow.saveStep(UID, 'hours', { openTime: '09:00' })).rejects.toThrow('timezone');
  });
  test('hours openTime formato malo throw', async () => {
    await expect(ow.saveStep(UID, 'hours', { timezone: 'AR', openTime: 'malo' })).rejects.toThrow('openTime');
  });
  test('hours closeTime formato malo throw', async () => {
    await expect(ow.saveStep(UID, 'hours', { timezone: 'AR', closeTime: '99:99x' })).rejects.toThrow('closeTime');
  });
  test('disclaimer mode invalido throw', async () => {
    await expect(ow.saveStep(UID, 'disclaimer_mode', { mode: 'inventado' })).rejects.toThrow('mode invalido');
  });
  test('products no array throw', async () => {
    await expect(ow.saveStep(UID, 'products', { products: 'no' })).rejects.toThrow('products');
  });
  test('test_message sin targetPhone throw', async () => {
    await expect(ow.saveStep(UID, 'test_message', {})).rejects.toThrow('targetPhone');
  });
});

describe('saveStep happy paths', () => {
  test('business_info valido + nextStep products', async () => {
    ow.__setFirestoreForTests(makeMockDb());
    const r = await ow.saveStep(UID, 'business_info', { name: 'Mi Resto', vertical: 'food' });
    expect(r.nextStep).toBe('products');
    expect(r.isComplete).toBe(false);
  });
  test('hours valido', async () => {
    ow.__setFirestoreForTests(makeMockDb());
    const r = await ow.saveStep(UID, 'hours', { timezone: 'AR', openTime: '09:00', closeTime: '20:00' });
    expect(r.nextStep).toBe('disclaimer_mode');
  });
  test('disclaimer mode valido', async () => {
    ow.__setFirestoreForTests(makeMockDb());
    const r = await ow.saveStep(UID, 'disclaimer_mode', { mode: 'hidden' });
    expect(r.nextStep).toBe('test_message');
  });
  test('products valido', async () => {
    ow.__setFirestoreForTests(makeMockDb());
    const r = await ow.saveStep(UID, 'products', { products: [{ name: 'X', price: 10 }] });
    expect(r.nextStep).toBe('hours');
  });
  test('test_message es ultimo paso isComplete=true', async () => {
    ow.__setFirestoreForTests(makeMockDb());
    const r = await ow.saveStep(UID, 'test_message', { targetPhone: '+1' });
    expect(r.nextStep).toBeNull();
    expect(r.isComplete).toBe(true);
  });
  test('paso ya completado no se duplica', async () => {
    const ex = { completedSteps: ['business_info'] };
    ow.__setFirestoreForTests(makeMockDb({ existing: ex }));
    await ow.saveStep(UID, 'business_info', { name: 'X', vertical: 'food' });
    expect(ex.completedSteps.length).toBe(1);
  });
  test('completedSteps undefined inicial', async () => {
    ow.__setFirestoreForTests(makeMockDb({ existing: {} }));
    const r = await ow.saveStep(UID, 'business_info', { name: 'X', vertical: 'food' });
    expect(r.nextStep).toBe('products');
  });
  test('completedSteps no array fallback', async () => {
    ow.__setFirestoreForTests(makeMockDb({ existing: { completedSteps: 'no' } }));
    const r = await ow.saveStep(UID, 'business_info', { name: 'X', vertical: 'food' });
    expect(r.nextStep).toBe('products');
  });
});

describe('getOnboardingState + progress + isComplete', () => {
  test('uid undefined throw', async () => {
    await expect(ow.getOnboardingState(undefined)).rejects.toThrow('uid');
  });
  test('no existe state -> null', async () => {
    ow.__setFirestoreForTests(makeMockDb());
    expect(await ow.getOnboardingState(UID)).toBeNull();
  });
  test('state existe -> data', async () => {
    ow.__setFirestoreForTests(makeMockDb({ existing: { currentStep: 'products' } }));
    const r = await ow.getOnboardingState(UID);
    expect(r.currentStep).toBe('products');
  });
  test('state existe sin data fn -> null', async () => {
    ow.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
        get: async () => ({ exists: true })
      })})})})
    });
    expect(await ow.getOnboardingState(UID)).toBeNull();
  });
  test('calculateProgress null state', () => {
    expect(ow.calculateProgress(null).percent).toBe(0);
  });
  test('calculateProgress 2/5 = 40%', () => {
    expect(ow.calculateProgress({ completedSteps: ['a', 'b'] }).percent).toBe(40);
  });
  test('calculateProgress completedSteps no array -> 0', () => {
    expect(ow.calculateProgress({ completedSteps: 'no' }).completed).toBe(0);
  });
  test('isOnboardingComplete null -> false', () => {
    expect(ow.isOnboardingComplete(null)).toBe(false);
  });
  test('isOnboardingComplete sin completedAt -> false', () => {
    expect(ow.isOnboardingComplete({})).toBe(false);
  });
  test('isOnboardingComplete con completedAt -> true', () => {
    expect(ow.isOnboardingComplete({ completedAt: '2026' })).toBe(true);
  });
});
