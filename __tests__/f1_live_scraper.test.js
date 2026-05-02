'use strict';

/**
 * Tests para live_scraper.js — polling F1 live timing + circuit breaker + retry.
 * Mock axios. Stub setTimeout para no-recursar _pollLoop (busca cb.name).
 */

jest.mock('axios');
const axios = require('axios');

// Mock liveCache para no tocar Redis ni memoria real
jest.mock('../sports/f1_dashboard/live_cache', () => {
  const setRaceStatus = jest.fn().mockResolvedValue();
  const setDriverPosition = jest.fn().mockResolvedValue();
  return {
    getLiveCache: () => ({ setRaceStatus, setDriverPosition }),
    __setRaceStatus: setRaceStatus,
    __setDriverPosition: setDriverPosition,
  };
});
const liveCacheModule = require('../sports/f1_dashboard/live_cache');

const scraper = require('../sports/f1_dashboard/live_scraper');

const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;

beforeEach(() => {
  jest.clearAllMocks();
  scraper._resetState();

  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});

  // setTimeout custom: si cb es _pollLoop, NO recursar (return 0).
  // Si es waiter anonimo (retry/throttle/etc.), invocar inmediato.
  global.setTimeout = jest.fn((cb, _ms) => {
    if (typeof cb !== 'function') return 0;
    if (cb.name === '_pollLoop') return 0;
    return realSetTimeout(cb, 0);
  });
  global.clearTimeout = jest.fn();
});

afterEach(() => {
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
  if (console.warn.mockRestore) console.warn.mockRestore();
  if (console.error.mockRestore) console.error.mockRestore();
  if (console.log.mockRestore) console.log.mockRestore();
});

// ───── _withRetry ─────
describe('_withRetry — F1.15 retry backoff', () => {
  test('exito en primer intento', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const r = await scraper._withRetry(fn);
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('exito en segundo', async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue('ok');
    const r = await scraper._withRetry(fn);
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('falla 3 throw', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('persist'));
    await expect(scraper._withRetry(fn)).rejects.toThrow('persist');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('attempts custom', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('z'));
    await expect(scraper._withRetry(fn, 2)).rejects.toThrow('z');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('baseDelayMs custom usa ese delay', async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error('a')).mockResolvedValue('ok');
    const r = await scraper._withRetry(fn, 3, 50);
    expect(r).toBe('ok');
  });
});

// ───── isRaceWeekend ─────
describe('isRaceWeekend()', () => {
  test('Lunes (1) → false', async () => {
    const realDate = global.Date;
    global.Date = class extends realDate {
      constructor() { super(); }
      getDay() { return 1; }
      getUTCHours() { return 12; }
    };
    const r = await scraper.isRaceWeekend();
    expect(r).toBe(false);
    global.Date = realDate;
  });

  test('Jueves (4) → false', async () => {
    const realDate = global.Date;
    global.Date = class extends realDate {
      getDay() { return 4; }
      getUTCHours() { return 12; }
    };
    const r = await scraper.isRaceWeekend();
    expect(r).toBe(false);
    global.Date = realDate;
  });

  test('Sabado (6) + axios.head 200 → true', async () => {
    const realDate = global.Date;
    global.Date = class extends realDate {
      getDay() { return 6; }
      getUTCHours() { return 12; }
    };
    axios.head.mockResolvedValue({ status: 200 });
    const r = await scraper.isRaceWeekend();
    expect(r).toBe(true);
    global.Date = realDate;
  });

  test('Domingo (0) + axios.head 404 → false', async () => {
    const realDate = global.Date;
    global.Date = class extends realDate {
      getDay() { return 0; }
      getUTCHours() { return 12; }
    };
    axios.head.mockResolvedValue({ status: 404 });
    const r = await scraper.isRaceWeekend();
    expect(r).toBe(false);
    global.Date = realDate;
  });

  test('Sabado + axios throws → catch fallback true', async () => {
    const realDate = global.Date;
    global.Date = class extends realDate {
      getDay() { return 6; }
      getUTCHours() { return 12; }
    };
    axios.head.mockRejectedValue(new Error('net'));
    const r = await scraper.isRaceWeekend();
    expect(r).toBe(true);
    global.Date = realDate;
  });

  test('Martes + axios throws → catch fallback false', async () => {
    const realDate = global.Date;
    global.Date = class extends realDate {
      getDay() { return 2; }
      getUTCHours() { return 12; }
    };
    // Aunque day === 2 corta antes, este test cubre el caso fallback day===2 → false
    const r = await scraper.isRaceWeekend();
    expect(r).toBe(false);
    global.Date = realDate;
  });

  test('axios.head invoca validateStatus callback (cobertura arrow)', async () => {
    const realDate = global.Date;
    global.Date = class extends realDate {
      getDay() { return 6; }
      getUTCHours() { return 12; }
    };
    let validateStatusCb = null;
    axios.head.mockImplementation((_url, opts) => {
      validateStatusCb = opts && opts.validateStatus;
      if (validateStatusCb) validateStatusCb(200);
      return Promise.resolve({ status: 200 });
    });
    const r = await scraper.isRaceWeekend();
    expect(r).toBe(true);
    expect(validateStatusCb).toBeInstanceOf(Function);
    expect(validateStatusCb()).toBe(true);
    global.Date = realDate;
  });
});

// ───── parsePositionFeed ─────
describe('parsePositionFeed(raw)', () => {
  test('null → null', () => {
    expect(scraper.parsePositionFeed(null)).toBeNull();
  });

  test('parses Position.Entries', () => {
    const raw = {
      Position: {
        Entries: {
          '1': { Status: 'OnTrack', Position: 2, NumberOfLaps: 30, GapToLeader: '+5s', IntervalToPositionAhead: { Value: '+1s' }, TyreAge: 12, NumberOfPitStops: 1 },
          '4': { Status: 'OnTrack', Position: 1, NumberOfLaps: 30 },
        },
      },
      SessionInfo: { Name: 'Carrera' },
      LapCount: { CurrentLap: 30, TotalLaps: 70 },
    };
    const r = scraper.parsePositionFeed(raw);
    expect(r.isLive).toBe(true);
    expect(r.session).toBe('Carrera');
    expect(r.lap).toBe(30);
    expect(r.totalLaps).toBe(70);
    expect(r.positions.length).toBe(2);
    // Sorted by position asc → driver 4 (pos 1) primero
    expect(r.positions[0].driver_number).toBe(4);
    expect(r.positions[1].driver_number).toBe(1);
    expect(r.positions[1].gap).toBe('+5s');
    expect(r.positions[1].interval).toBe('+1s');
  });

  test('Entries fallback en raiz', () => {
    const raw = {
      Entries: { '7': { Status: 'OnTrack', Position: 1 } },
    };
    const r = scraper.parsePositionFeed(raw);
    expect(r.positions.length).toBe(1);
    expect(r.positions[0].driver_number).toBe(7);
    expect(r.session).toBe('Race');
    expect(r.isLive).toBe(true);
  });

  test('entries sin Status se ignoran', () => {
    const raw = { Entries: { '1': null, '2': { Position: 1 } } };
    const r = scraper.parsePositionFeed(raw);
    expect(r.positions.length).toBe(0);
    expect(r.isLive).toBe(false);
  });

  test('defaults position/status/lap/gap/interval/tyre/pit', () => {
    const raw = { Entries: { '5': { Status: 'OnTrack' } } };
    const r = scraper.parsePositionFeed(raw);
    expect(r.positions[0].position).toBe(0);
    expect(r.positions[0].status).toBe('OnTrack');
    expect(r.positions[0].lap).toBe(0);
    expect(r.positions[0].gap).toBe('');
    expect(r.positions[0].interval).toBe('');
    expect(r.positions[0].tyre).toBe('');
    expect(r.positions[0].pit_count).toBe(0);
  });

  test('IntervalToPositionAhead undefined → interval ""', () => {
    const raw = { Entries: { '9': { Status: 'OnTrack' } } };
    const r = scraper.parsePositionFeed(raw);
    expect(r.positions[0].interval).toBe('');
  });

  test('Status string vacio → fallback "OnTrack"', () => {
    // Status='' es falsy pero defined → entra al if y usa fallback "OnTrack"
    const raw = { Entries: { '11': { Status: '', Position: 5 } } };
    const r = scraper.parsePositionFeed(raw);
    expect(r.positions.length).toBe(1);
    expect(r.positions[0].status).toBe('OnTrack');
  });

  test('raw sin Position ni Entries → fallback {}  (cobre rama || {})', () => {
    const r = scraper.parsePositionFeed({});
    expect(r.positions).toEqual([]);
    expect(r.isLive).toBe(false);
  });

  test('sort con position falsy → usa fallback 99', () => {
    // Driver A position 1, Driver B position undefined (→ 99). Sort coloca A primero.
    const raw = {
      Entries: {
        '1': { Status: 'OnTrack' },           // position falsy → 99
        '2': { Status: 'OnTrack', Position: 1 },
      },
    };
    const r = scraper.parsePositionFeed(raw);
    expect(r.positions[0].driver_number).toBe(2);
    expect(r.positions[1].driver_number).toBe(1);
  });
});

// ───── fetchLiveState ─────
describe('fetchLiveState()', () => {
  test('happy path objeto', async () => {
    axios.get.mockResolvedValue({
      data: { Position: { Entries: { '1': { Status: 'OnTrack', Position: 1 } } } },
    });
    const r = await scraper.fetchLiveState();
    expect(r.isLive).toBe(true);
    expect(r.positions.length).toBe(1);
  });

  test('happy path JSON string', async () => {
    axios.get.mockResolvedValue({
      data: JSON.stringify({ Position: { Entries: { '2': { Status: 'OnTrack' } } } }),
    });
    const r = await scraper.fetchLiveState();
    expect(r.positions.length).toBe(1);
  });

  test('resp.data null → null', async () => {
    axios.get.mockResolvedValue({ data: null });
    const r = await scraper.fetchLiveState();
    expect(r).toBeNull();
  });

  test('axios error → throw fetchLiveState', async () => {
    axios.get.mockRejectedValue(new Error('timeout'));
    await expect(scraper.fetchLiveState()).rejects.toThrow(/fetchLiveState/);
  });
});

// ───── start / stop / getState ─────
describe('start / stop / getState', () => {
  test('start setea isPolling=true', () => {
    axios.head.mockResolvedValue({ status: 200 });
    axios.get.mockResolvedValue({ data: { Position: { Entries: {} } } });
    scraper.start();
    expect(scraper._state.isPolling).toBe(true);
    scraper.stop();
  });

  test('start segundo call no-op si ya polling', () => {
    scraper._state.isPolling = true;
    const before = { ...scraper._state };
    scraper.start();
    expect(scraper._state.isPolling).toBe(before.isPolling);
  });

  test('start con onCritical callback se guarda', () => {
    const cb = jest.fn();
    scraper.start({ onCritical: cb });
    expect(scraper._state.onCritical).toBe(cb);
    scraper.stop();
  });

  test('stop limpia isPolling + clearTimeout', () => {
    scraper._state.isPolling = true;
    scraper._state.pollTimer = 'fake-timer';
    scraper.stop();
    expect(scraper._state.isPolling).toBe(false);
    expect(global.clearTimeout).toHaveBeenCalled();
  });

  test('getState retorna raceStatus + circuitOpen + lastSuccessAt', () => {
    scraper._state.raceStatus = { isLive: true, session: 'Race', lap: 5, totalLaps: 70 };
    scraper._state.circuitOpen = false;
    scraper._state.lastSuccessAt = 12345;
    const s = scraper.getState();
    expect(s.isLive).toBe(true);
    expect(s.circuitOpen).toBe(false);
    expect(s.lastSuccessAt).toBe(12345);
  });
});

// ───── _resetState ─────
describe('_resetState()', () => {
  test('resetea contadores + raceStatus', () => {
    scraper._state.consecutiveFailures = 5;
    scraper._state.totalFailures = 10;
    scraper._state.circuitOpen = true;
    scraper._state.raceStatus = { isLive: true, lap: 50 };
    scraper._resetState();
    expect(scraper._state.consecutiveFailures).toBe(0);
    expect(scraper._state.totalFailures).toBe(0);
    expect(scraper._state.circuitOpen).toBe(false);
    expect(scraper._state.raceStatus.isLive).toBe(false);
  });

  test('clearTimeout si pollTimer existe', () => {
    scraper._state.pollTimer = 'timer';
    scraper._resetState();
    expect(global.clearTimeout).toHaveBeenCalled();
  });
});

// ───── _pollLoop ─────
describe('_pollLoop — flujo principal + circuit breaker', () => {
  test('sale temprano si !isPolling', async () => {
    scraper._state.isPolling = false;
    await scraper._pollLoop();
    // axios no fue llamado
    expect(axios.head).not.toHaveBeenCalled();
  });

  test('circuit abierto + dentro de pausa → reschedule sin llamar axios', async () => {
    scraper._state.isPolling = true;
    scraper._state.circuitOpen = true;
    scraper._state.circuitOpenAt = Date.now();
    await scraper._pollLoop();
    expect(axios.head).not.toHaveBeenCalled();
    // Reschedule via setTimeout(_pollLoop, ...)
    expect(global.setTimeout).toHaveBeenCalled();
  });

  test('circuit abierto + pausa expirada → cierra circuito y continua', async () => {
    scraper._state.isPolling = true;
    scraper._state.circuitOpen = true;
    scraper._state.circuitOpenAt = Date.now() - 70000; // pausa 60s expirada
    scraper._state.consecutiveFailures = 5;
    axios.head.mockResolvedValue({ status: 200 });
    axios.get.mockResolvedValue({ data: { Position: { Entries: { '1': { Status: 'OnTrack' } } } } });
    await scraper._pollLoop();
    expect(scraper._state.circuitOpen).toBe(false);
    expect(scraper._state.consecutiveFailures).toBe(0);
  });

  test('NO weekend (Lunes) → setea isLive=false y reschedule', async () => {
    scraper._state.isPolling = true;
    const realDate = global.Date;
    global.Date = class extends realDate {
      getDay() { return 1; }
      getUTCHours() { return 12; }
    };
    await scraper._pollLoop();
    expect(scraper._state.raceStatus.isLive).toBe(false);
    expect(liveCacheModule.__setRaceStatus).toHaveBeenCalledWith(expect.objectContaining({ isLive: false }));
    global.Date = realDate;
  });

  test('weekend + liveData → cachea positions', async () => {
    scraper._state.isPolling = true;
    const realDate = global.Date;
    global.Date = class extends realDate {
      getDay() { return 6; }
      getUTCHours() { return 12; }
    };
    axios.head.mockResolvedValue({ status: 200 });
    axios.get.mockResolvedValue({
      data: { Position: { Entries: { '1': { Status: 'OnTrack', Position: 1 } } } },
      // session
    });
    await scraper._pollLoop();
    expect(scraper._state.consecutiveFailures).toBe(0);
    expect(scraper._state.lastSuccessAt).toBeTruthy();
    expect(liveCacheModule.__setDriverPosition).toHaveBeenCalled();
    global.Date = realDate;
  });

  test('weekend + retry agota → consecutiveFailures++', async () => {
    scraper._state.isPolling = true;
    const realDate = global.Date;
    global.Date = class extends realDate {
      getDay() { return 6; }
      getUTCHours() { return 12; }
    };
    axios.head.mockResolvedValue({ status: 200 });
    axios.get.mockRejectedValue(new Error('boom'));
    await scraper._pollLoop();
    expect(scraper._state.consecutiveFailures).toBeGreaterThan(0);
    global.Date = realDate;
  });

  test('3 fallos consecutivos → circuit ABIERTO', async () => {
    scraper._state.isPolling = true;
    scraper._state.consecutiveFailures = 2; // proximo error abre circuito
    const realDate = global.Date;
    global.Date = class extends realDate {
      getDay() { return 6; }
      getUTCHours() { return 12; }
    };
    axios.head.mockResolvedValue({ status: 200 });
    axios.get.mockRejectedValue(new Error('xxx'));
    await scraper._pollLoop();
    expect(scraper._state.circuitOpen).toBe(true);
    expect(scraper._state.circuitOpenAt).toBeTruthy();
    global.Date = realDate;
  });

  test('weekend + fetchLiveState retorna null → no cachea positions (cobre if liveData falsy)', async () => {
    scraper._state.isPolling = true;
    const realDate = global.Date;
    global.Date = class extends realDate {
      getDay() { return 6; }
      getUTCHours() { return 12; }
    };
    axios.head.mockResolvedValue({ status: 200 });
    axios.get.mockResolvedValue({ data: null });
    await scraper._pollLoop();
    expect(liveCacheModule.__setDriverPosition).not.toHaveBeenCalled();
    global.Date = realDate;
  });

  test('10 fallos totales + onCritical → callback invocado', async () => {
    scraper._state.isPolling = true;
    scraper._state.totalFailures = 9;
    const onCrit = jest.fn();
    scraper._state.onCritical = onCrit;
    const realDate = global.Date;
    global.Date = class extends realDate {
      getDay() { return 6; }
      getUTCHours() { return 12; }
    };
    axios.head.mockResolvedValue({ status: 200 });
    axios.get.mockRejectedValue(new Error('die'));
    await scraper._pollLoop();
    expect(onCrit).toHaveBeenCalledWith(expect.stringContaining('CRITICAL'));
    global.Date = realDate;
  });
});
