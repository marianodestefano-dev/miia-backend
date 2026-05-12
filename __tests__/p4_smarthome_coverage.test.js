'use strict';

let sh;

function makeDb({ throwSet = false } = {}) {
  return {
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({
        set: throwSet
          ? jest.fn().mockRejectedValue(new Error('set fail'))
          : jest.fn().mockResolvedValue({}),
      }),
    }),
  };
}

beforeEach(() => {
  jest.resetModules();
  jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
  sh = require('../core/smarthome_integration');
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  sh.__setFirestoreForTests(null);
  jest.restoreAllMocks();
});

describe('P4 -- smarthome_integration branches', () => {
  test('registerSmartHomeWebhook: uid faltante -> throw', async () => {
    sh.__setFirestoreForTests(makeDb());
    await expect(sh.registerSmartHomeWebhook(null, { provider: 'alexa', webhookUrl: 'http://a' }))
      .rejects.toThrow('uid, provider, webhookUrl required');
  });

  test('registerSmartHomeWebhook: provider faltante -> throw', async () => {
    sh.__setFirestoreForTests(makeDb());
    await expect(sh.registerSmartHomeWebhook('uid1', { webhookUrl: 'http://a' }))
      .rejects.toThrow('uid, provider, webhookUrl required');
  });

  test('registerSmartHomeWebhook: provider invalido -> throw', async () => {
    sh.__setFirestoreForTests(makeDb());
    await expect(sh.registerSmartHomeWebhook('uid1', { provider: 'zigbee', webhookUrl: 'http://a' }))
      .rejects.toThrow('invalid provider: zigbee');
  });

  test('registerSmartHomeWebhook: sin deviceTypes -> usa default', async () => {
    sh.__setFirestoreForTests(makeDb());
    const r = await sh.registerSmartHomeWebhook('uid1', { provider: 'alexa', webhookUrl: 'http://webhook' });
    expect(r.provider).toBe('alexa');
    expect(r.deviceTypes).toEqual(['light', 'thermostat', 'lock']);
    expect(r.active).toBe(true);
  });

  test('registerSmartHomeWebhook: con deviceTypes custom -> los usa', async () => {
    sh.__setFirestoreForTests(makeDb());
    const r = await sh.registerSmartHomeWebhook('uid1', {
      provider: 'google_home', webhookUrl: 'http://wh', deviceTypes: ['camera'],
    });
    expect(r.deviceTypes).toEqual(['camera']);
  });

  test('registerSmartHomeWebhook: google_home y apple_homekit -> OK', async () => {
    sh.__setFirestoreForTests(makeDb());
    await expect(sh.registerSmartHomeWebhook('uid1', { provider: 'google_home', webhookUrl: 'http://x' })).resolves.toBeDefined();
    await expect(sh.registerSmartHomeWebhook('uid1', { provider: 'apple_homekit', webhookUrl: 'http://y' })).resolves.toBeDefined();
  });

  test('processSmartHomeCommand: uid faltante -> throw', async () => {
    sh.__setFirestoreForTests(makeDb());
    await expect(sh.processSmartHomeCommand(null, 'lights.on')).rejects.toThrow('uid and command required');
  });

  test('processSmartHomeCommand: command faltante -> throw', async () => {
    sh.__setFirestoreForTests(makeDb());
    await expect(sh.processSmartHomeCommand('uid1', null)).rejects.toThrow('uid and command required');
  });

  test('processSmartHomeCommand: sin payload -> usa {} (branch payload || {})', async () => {
    sh.__setFirestoreForTests(makeDb());
    const r = await sh.processSmartHomeCommand('uid1', 'lights.on');
    expect(r.processed).toBe(true);
    expect(r.command).toBe('lights.on');
    expect(r.log.payload).toEqual({});
  });

  test('processSmartHomeCommand: con payload -> lo usa', async () => {
    sh.__setFirestoreForTests(makeDb());
    const r = await sh.processSmartHomeCommand('uid1', 'thermostat.set', { temp: 22 });
    expect(r.log.payload).toEqual({ temp: 22 });
  });
});
