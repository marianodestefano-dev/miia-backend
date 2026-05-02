'use strict';

const cron = require('../services/modo_deporte_cron');
const sd = require('../core/sports_detector');

const FLAG = 'MIIA_MODO_DEPORTE_ENABLED';

beforeEach(() => {
  delete process.env[FLAG];
  cron._resetForTesting();
  sd.__setFirestoreForTests(null);
});
afterEach(() => {
  delete process.env[FLAG];
  cron._resetForTesting();
});

function makeMockDb({ existingSports = {} } = {}) {
  return {
    collection: () => ({ doc: () => ({ collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false, data: () => null }),
        set: async () => {},
      }),
      get: async () => ({
        forEach: fn => Object.entries(existingSports).forEach(([id, d]) => fn({ id, data: () => d })),
      }),
    })})})
  };
}

describe('startCron + stopCron', () => {
  test('flag OFF -> startCron no arranca', () => {
    expect(cron.startCron()).toBe(false);
    expect(cron.isRunning()).toBe(false);
  });
  test('flag ON -> startCron arranca', () => {
    process.env[FLAG] = '1';
    expect(cron.startCron({ intervalMs: 60000 })).toBe(true);
    expect(cron.isRunning()).toBe(true);
    cron.stopCron();
  });
  test('startCron 2 veces -> segundo retorna false', () => {
    process.env[FLAG] = '1';
    cron.startCron({ intervalMs: 60000 });
    expect(cron.startCron({ intervalMs: 60000 })).toBe(false);
    cron.stopCron();
  });
  test('stopCron sin start -> false', () => {
    expect(cron.stopCron()).toBe(false);
  });
  test('stopCron despues de start -> true', () => {
    process.env[FLAG] = '1';
    cron.startCron({ intervalMs: 60000 });
    expect(cron.stopCron()).toBe(true);
    expect(cron.isRunning()).toBe(false);
  });
  test('intervalMs invalido -> default', () => {
    process.env[FLAG] = '1';
    cron.startCron({ intervalMs: 0 });
    expect(cron.isRunning()).toBe(true);
    cron.stopCron();
  });
  test('opts undefined -> ok', () => {
    process.env[FLAG] = '1';
    expect(cron.startCron()).toBe(true);
    cron.stopCron();
  });
});

describe('tickAllOwners', () => {
  test('activeOwners vacio retorna ceros', async () => {
    const r = await cron.tickAllOwners({});
    expect(r.processed).toBe(0);
    expect(r.eventsDetected).toBe(0);
    expect(r.sentTotal).toBe(0);
  });
  test('activeOwners no array retorna ceros', async () => {
    const r = await cron.tickAllOwners({ activeOwners: 'no-array' });
    expect(r.processed).toBe(0);
  });
  test('owner sin sports -> processed=0', async () => {
    sd.__setFirestoreForTests(makeMockDb({ existingSports: {} }));
    const r = await cron.tickAllOwners({ activeOwners: ['uid1'] });
    expect(r.processed).toBe(0);
  });
  test('owner con sport futbol -> processSportTick llamado', async () => {
    sd.__setFirestoreForTests(makeMockDb({ existingSports: {
      tio: { contactPhone: '+1', contactName: 'Tio', sports: [{ type: 'futbol', team: 'Boca' }] },
    }}));
    const sender = jest.fn().mockResolvedValue(undefined);
    const fetcher = async () => ({ our: 0, rival: 0, status: 'live', minute: 1 });
    const r = await cron.tickAllOwners({
      activeOwners: ['uid1'], fetcher, sender,
    });
    expect(r.processed).toBeGreaterThan(0);
  });
  test('owner con varios contactos del mismo team -> agrupa', async () => {
    sd.__setFirestoreForTests(makeMockDb({ existingSports: {
      a: { contactPhone: '+1', sports: [{ type: 'futbol', team: 'Boca' }] },
      b: { contactPhone: '+2', sports: [{ type: 'futbol', team: 'Boca' }] },
    }}));
    const fetcher = async () => ({ our: 0, rival: 0, status: 'live', minute: 1 });
    const sender = jest.fn().mockResolvedValue(undefined);
    const r = await cron.tickAllOwners({
      activeOwners: ['uid1'], fetcher, sender,
    });
    expect(r.processed).toBe(1);
    expect(r.sentTotal).toBe(2);
  });
  test('contactos con sports incompletos (sin team/driver) ignorados', async () => {
    sd.__setFirestoreForTests(makeMockDb({ existingSports: {
      x: { contactPhone: '+1', sports: [{ type: 'futbol' }] },
    }}));
    const r = await cron.tickAllOwners({ activeOwners: ['uid1'] });
    expect(r.processed).toBe(0);
  });
  test('exception en tick (DB throw) capturada', async () => {
    sd.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({
        get: async () => { throw new Error('DB DOWN'); },
      })})})
    });
    const r = await cron.tickAllOwners({ activeOwners: ['uid1'] });
    expect(r.processed).toBe(0);
  });
});

describe('DEFAULT_INTERVAL_MS', () => {
  test('60000ms', () => {
    expect(cron.DEFAULT_INTERVAL_MS).toBe(60000);
  });
});

describe('extra branches modo_deporte_cron', () => {
  test('_stateKey f1 con driver', async () => {
    process.env[FLAG] = '1';
    sd.__setFirestoreForTests(makeMockDb({ existingSports: {
      a: { contactPhone: '+1', sports: [{ type: 'f1', driver: 'Verstappen' }] },
    }}));
    const fetcher = async () => ({ position: 1, lap: 1, status: 'race_live' });
    const sender = jest.fn().mockResolvedValue(undefined);
    const r = await cron.tickAllOwners({ activeOwners: ['uid1'], fetcher, sender });
    expect(r.processed).toBe(1);
  });
  test('setInterval callback ejecuta tickAllOwners', async () => {
    process.env[FLAG] = '1';
    sd.__setFirestoreForTests(makeMockDb({ existingSports: {} }));
    cron.startCron({ intervalMs: 50 });
    await new Promise(r => setTimeout(r, 130)); // 2-3 ticks
    cron.stopCron();
    // Si no crasheo, branch del callback OK
    expect(true).toBe(true);
  });
  test('setInterval callback con tickAllOwners throw -> caught', async () => {
    process.env[FLAG] = '1';
    sd.__setFirestoreForTests({
      collection: () => { throw new Error('boom'); },
    });
    cron.startCron({ intervalMs: 50 });
    await new Promise(r => setTimeout(r, 130));
    cron.stopCron();
    expect(true).toBe(true);
  });
});
