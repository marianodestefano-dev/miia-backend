'use strict';

const f1 = require('../core/f1_adapter');

describe('F1_STATUS y F1_EVENT_TYPES', () => {
  test('frozen', () => {
    expect(() => { f1.F1_STATUS.x = 1; }).toThrow();
    expect(() => { f1.F1_EVENT_TYPES.x = 1; }).toThrow();
  });
  test('contiene RACE_LIVE FINISHED', () => {
    expect(f1.F1_STATUS.RACE_LIVE).toBe('race_live');
    expect(f1.F1_STATUS.FINISHED).toBe('finished');
  });
});

describe('fetchRaceStatus', () => {
  test('sin driver throw', async () => {
    await expect(f1.fetchRaceStatus({})).rejects.toThrow('driver');
  });
  test('opts undefined throw', async () => {
    await expect(f1.fetchRaceStatus()).rejects.toThrow('driver');
  });
  test('result null retorna empty', async () => {
    const r = await f1.fetchRaceStatus({ driver: 'Verstappen', fetcher: async () => null });
    expect(r.position).toBe(0);
    expect(r.status).toBe('unknown');
  });
  test('result no-objeto retorna empty', async () => {
    const r = await f1.fetchRaceStatus({ driver: 'V', fetcher: async () => 'string' });
    expect(r.status).toBe('unknown');
  });
  test('result objeto valido', async () => {
    const r = await f1.fetchRaceStatus({ driver: 'V', fetcher: async () => ({
      position: 1, lap: 30, pitStops: 1, status: 'race_live'
    })});
    expect(r.position).toBe(1);
    expect(r.lap).toBe(30);
    expect(r.pitStops).toBe(1);
  });
  test('struct sin position default 0', async () => {
    const r = await f1.fetchRaceStatus({ driver: 'V', fetcher: async () => ({
      lap: 10, status: 'race_live'
    })});
    expect(r.position).toBe(0);
  });
  test('result driverNumber alternativo', async () => {
    const r = await f1.fetchRaceStatus({ driverNumber: '1', fetcher: async () => ({
      position: 2,
    })});
    expect(r.driverNumber).toBe('1');
    expect(r.position).toBe(2);
  });
  test('struct con fastestLap true', async () => {
    const r = await f1.fetchRaceStatus({ driver: 'V', fetcher: async () => ({
      position: 1, fastestLap: true,
    })});
    expect(r.fastestLap).toBe(true);
  });
});

describe('detectRaceEvent', () => {
  test('current null -> null', () => {
    expect(f1.detectRaceEvent(null, null)).toBeNull();
  });
  test('prev null + current race_live -> race_start', () => {
    const r = f1.detectRaceEvent(null, { status: 'race_live', lap: 1, position: 5 });
    expect(r.event).toBe('race_start');
  });
  test('prev null + current scheduled -> null', () => {
    expect(f1.detectRaceEvent(null, { status: 'scheduled', lap: 0 })).toBeNull();
  });
  test('position gain detectado', () => {
    const r = f1.detectRaceEvent(
      { position: 3, pitStops: 0, fastestLap: false, status: 'race_live' },
      { position: 1, pitStops: 0, fastestLap: false, status: 'race_live', lap: 25 }
    );
    expect(r.event).toBe('position_gain');
    expect(r.fromPosition).toBe(3);
    expect(r.toPosition).toBe(1);
  });
  test('position loss detectado', () => {
    const r = f1.detectRaceEvent(
      { position: 1, pitStops: 0, fastestLap: false, status: 'race_live' },
      { position: 4, pitStops: 0, fastestLap: false, status: 'race_live', lap: 30 }
    );
    expect(r.event).toBe('position_loss');
  });
  test('pit stop detectado', () => {
    const r = f1.detectRaceEvent(
      { position: 1, pitStops: 0, fastestLap: false, status: 'race_live' },
      { position: 1, pitStops: 1, fastestLap: false, status: 'race_live' }
    );
    expect(r.event).toBe('pit_stop');
  });
  test('safety car detectado', () => {
    const r = f1.detectRaceEvent(
      { position: 1, pitStops: 0, fastestLap: false, status: 'race_live' },
      { position: 1, pitStops: 0, fastestLap: false, status: 'safety_car' }
    );
    expect(r.event).toBe('safety_car');
  });
  test('race end detectado', () => {
    const r = f1.detectRaceEvent(
      { position: 1, pitStops: 1, fastestLap: false, status: 'race_live' },
      { position: 1, pitStops: 1, fastestLap: false, status: 'finished' }
    );
    expect(r.event).toBe('race_end');
  });
  test('fastest lap detectado', () => {
    const r = f1.detectRaceEvent(
      { position: 1, pitStops: 0, fastestLap: false, status: 'race_live' },
      { position: 1, pitStops: 0, fastestLap: true, status: 'race_live' }
    );
    expect(r.event).toBe('fastest_lap');
  });
  test('sin cambios -> null', () => {
    const r = f1.detectRaceEvent(
      { position: 1, pitStops: 0, fastestLap: false, status: 'race_live' },
      { position: 1, pitStops: 0, fastestLap: false, status: 'race_live' }
    );
    expect(r).toBeNull();
  });
  test('current sin position 0 ignora gain/loss', () => {
    const r = f1.detectRaceEvent(
      { position: 0, pitStops: 0, fastestLap: false, status: 'race_live' },
      { position: 0, pitStops: 0, fastestLap: false, status: 'race_live' }
    );
    expect(r).toBeNull();
  });
});

describe('extra branches f1_adapter to 100', () => {
  test('opts sin fetcher -> default fetcher throw', async () => {
    await expect(f1.fetchRaceStatus({ driver: 'V' })).rejects.toThrow();
  });
  test('opts.driver null + opts.driverNumber numerico', async () => {
    const r = await f1.fetchRaceStatus({ driverNumber: '1', fetcher: async () => null });
    expect(r.driver).toBeNull();
    expect(r.driverNumber).toBe('1');
  });
  test('result.driver fallback cuando opts no tiene', async () => {
    const r = await f1.fetchRaceStatus({ driverNumber: '1', fetcher: async () => ({
      driver: 'Verstappen', position: 1,
    })});
    expect(r.driver).toBe('Verstappen');
  });
});
