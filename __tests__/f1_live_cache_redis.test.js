'use strict';

/**
 * Tests para live_cache.js — modo Redis (mock virtual ioredis).
 * Complementa f1_live_cache.test.js que cubre modo memoria.
 * Usa globalThis pattern porque jest.mock factory se hoistea antes
 * de declaraciones module-level.
 */

globalThis.__redisStore = new Map();
globalThis.__shouldConnectFail = false;

jest.mock('ioredis', () => {
  return class MockRedis {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
    }
    async connect() {
      if (globalThis.__shouldConnectFail) throw new Error('ECONNREFUSED');
    }
    async set(key, val) {
      globalThis.__redisStore.set(key, val);
      return 'OK';
    }
    async get(key) {
      return globalThis.__redisStore.has(key) ? globalThis.__redisStore.get(key) : null;
    }
    async quit() { return 'OK'; }
    on() {}
  };
}, { virtual: true });

const { getLiveCache } = require('../sports/f1_dashboard/live_cache');

beforeEach(() => {
  globalThis.__shouldConnectFail = false;
  globalThis.__redisStore.clear();
  getLiveCache()._resetForTests();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  if (console.log.mockRestore) console.log.mockRestore();
  if (console.warn.mockRestore) console.warn.mockRestore();
});

describe('live_cache modo Redis (mock virtual ioredis)', () => {
  test('initRedis con URL valida → isRedisAvailable=true', async () => {
    const cache = getLiveCache();
    await cache.initRedis('redis://localhost:6379');
    expect(cache.isRedisAvailable()).toBe(true);
  });

  test('initRedis con connect fallido → cae a memoria', async () => {
    globalThis.__shouldConnectFail = true;
    const cache = getLiveCache();
    await cache.initRedis('redis://broken:6379');
    expect(cache.isRedisAvailable()).toBe(false);
  });

  test('setDriverPosition + getDriverPosition Redis path', async () => {
    const cache = getLiveCache();
    await cache.initRedis('redis://localhost:6379');
    await cache.setDriverPosition(4, { name: 'Norris', position: 1 });
    const r = await cache.getDriverPosition(4);
    expect(r.name).toBe('Norris');
  });

  test('getDriverPosition Redis miss → null', async () => {
    const cache = getLiveCache();
    await cache.initRedis('redis://localhost:6379');
    const r = await cache.getDriverPosition(999);
    expect(r).toBeNull();
  });

  test('setAllPositions + getAllPositions Redis path', async () => {
    const cache = getLiveCache();
    await cache.initRedis('redis://localhost:6379');
    await cache.setAllPositions([
      { driver_number: 1, position: 1 },
      { driver_number: 16, position: 2 },
    ]);
    const r = await cache.getAllPositions();
    expect(r.length).toBe(2);
  });

  test('setRaceStatus + getRaceStatus Redis path', async () => {
    const cache = getLiveCache();
    await cache.initRedis('redis://localhost:6379');
    await cache.setRaceStatus({ isLive: true, lap: 50 });
    const r = await cache.getRaceStatus();
    expect(r.isLive).toBe(true);
    expect(r.lap).toBe(50);
  });

  test('getRaceStatus Redis miss → default { isLive: false }', async () => {
    const cache = getLiveCache();
    await cache.initRedis('redis://localhost:6379');
    const r = await cache.getRaceStatus();
    expect(r).toEqual({ isLive: false });
  });

  test('initRedis sin URL → warn + memoria', async () => {
    const cache = getLiveCache();
    await cache.initRedis(null);
    expect(cache.isRedisAvailable()).toBe(false);
  });

  test('getAllPositions reconstruct: sort con position falsy usa fallback 99', async () => {
    // Modo memoria, individuales solamente, posicion falsy en uno
    const cache = getLiveCache();
    cache.clearMemCache();
    await cache.setDriverPosition(1, { driver_number: 1, position: 2 });
    await cache.setDriverPosition(2, { driver_number: 2 }); // sin position → falsy → 99
    await cache.setDriverPosition(3, { driver_number: 3, position: 1 });
    const r = await cache.getAllPositions();
    expect(r.length).toBe(3);
    // Driver 3 (pos=1) primero, driver 1 (pos=2) segundo, driver 2 (sin pos → 99) ultimo
    expect(r[0].driver_number).toBe(3);
    expect(r[2].driver_number).toBe(2);
  });
});
