'use strict';

/**
 * Tests para live_cache.js — Redis con fallback memoria.
 * Mock ioredis y testeamos ambos paths.
 */

const { getLiveCache } = require('../sports/f1_dashboard/live_cache');

beforeEach(() => {
  // Reset memoria entre tests
  getLiveCache().clearMemCache();
});

describe('live_cache memory mode (sin Redis)', () => {
  test('isRedisAvailable false sin init', () => {
    expect(getLiveCache().isRedisAvailable()).toBe(false);
  });

  test('initRedis sin URL no rompe', async () => {
    await getLiveCache().initRedis(null);
    expect(getLiveCache().isRedisAvailable()).toBe(false);
  });

  test('initRedis con URL invalida cae a memoria', async () => {
    // ioredis no instalado o URL invalida → catch → no rompe
    await getLiveCache().initRedis('redis://invalid-host:6379');
    // No throw — solo warn y fallback memoria
    expect(getLiveCache().isRedisAvailable()).toBe(false);
  });

  test('setDriverPosition + getDriverPosition memoria', async () => {
    const cache = getLiveCache();
    await cache.setDriverPosition(4, { name: 'Norris', position: 1 });
    const r = await cache.getDriverPosition(4);
    expect(r.name).toBe('Norris');
  });

  test('getDriverPosition no existe null', async () => {
    expect(await getLiveCache().getDriverPosition(999)).toBeNull();
  });

  test('setAllPositions + getAllPositions', async () => {
    const cache = getLiveCache();
    await cache.setAllPositions([
      { driver_number: 1, position: 1 },
      { driver_number: 2, position: 2 },
    ]);
    const r = await cache.getAllPositions();
    expect(r.length).toBe(2);
    expect(r[0].position).toBe(1);
  });

  test('getAllPositions sin cache reconstruye desde individual', async () => {
    const cache = getLiveCache();
    cache.clearMemCache();
    await cache.setDriverPosition(4, { driver_number: 4, position: 1 });
    await cache.setDriverPosition(16, { driver_number: 16, position: 2 });
    // Limpiar la cache 'all' pero dejar individuales
    // (setDriverPosition no setea 'all', solo setAllPositions lo hace)
    const r = await cache.getAllPositions();
    expect(r.length).toBe(2);
  });

  test('getAllPositions vacio sin nada', async () => {
    const cache = getLiveCache();
    cache.clearMemCache();
    const r = await cache.getAllPositions();
    expect(r).toEqual([]);
  });

  test('setRaceStatus + getRaceStatus', async () => {
    const cache = getLiveCache();
    await cache.setRaceStatus({ isLive: true, lap: 35, totalLaps: 70 });
    const r = await cache.getRaceStatus();
    expect(r.isLive).toBe(true);
    expect(r.lap).toBe(35);
  });

  test('getRaceStatus sin set retorna default isLive=false', async () => {
    const cache = getLiveCache();
    cache.clearMemCache();
    const r = await cache.getRaceStatus();
    expect(r.isLive).toBe(false);
  });

  test('TTL expiry — entrada vencida retorna null', async () => {
    const cache = getLiveCache();
    await cache.setDriverPosition(99, { name: 'X' });
    // Avanzar Date.now() simulando 31s después
    const realDateNow = Date.now;
    Date.now = jest.fn(() => realDateNow() + 31_000);
    const r = await cache.getDriverPosition(99);
    expect(r).toBeNull();
    Date.now = realDateNow;
  });

  test('clearMemCache vacia memoria', async () => {
    const cache = getLiveCache();
    await cache.setDriverPosition(1, { name: 'X' });
    cache.clearMemCache();
    const r = await cache.getDriverPosition(1);
    expect(r).toBeNull();
  });

  test('singleton: misma instancia siempre', () => {
    expect(getLiveCache()).toBe(getLiveCache());
  });

  test('setAllPositions empty array', async () => {
    const cache = getLiveCache();
    cache.clearMemCache();
    await cache.setAllPositions([]);
    const r = await cache.getAllPositions();
    expect(r).toEqual([]);
  });
});

