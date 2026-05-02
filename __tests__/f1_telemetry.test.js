'use strict';

/**
 * Tests para f1_telemetry.js — telemetria F1 completa via OpenF1 API.
 * Mock fetch via fetchFn inyectable.
 */

const tel = require('../sports/f1_dashboard/f1_telemetry');

// ── Mock fetch helper ────────────────────────────────────────────────────────
const mockFetch = (data, options = {}) =>
  jest.fn().mockResolvedValue({
    ok: options.ok !== false,
    status: options.status || 200,
    json: async () => data,
  });
const mockFetchError = (errMsg) => jest.fn().mockRejectedValue(new Error(errMsg));
const mockFetchAbort = () => jest.fn().mockImplementation(() => {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return Promise.reject(err);
});

// ── fetchJson ────────────────────────────────────────────────────────────────
describe('fetchJson', () => {
  test('retorna array de json', async () => {
    const f = mockFetch([{ a: 1 }]);
    const r = await tel.fetchJson(f, 'http://x');
    expect(r).toEqual([{ a: 1 }]);
  });
  test('non-array retorna []', async () => {
    const f = mockFetch({ obj: true });
    const r = await tel.fetchJson(f, 'http://x');
    expect(r).toEqual([]);
  });
  test('HTTP error throw', async () => {
    const f = mockFetch(null, { ok: false, status: 500 });
    await expect(tel.fetchJson(f, 'http://x')).rejects.toThrow(/HTTP 500/);
  });
  test('timeout AbortError throw', async () => {
    const f = mockFetchAbort();
    await expect(tel.fetchJson(f, 'http://x', 100)).rejects.toThrow(/Timeout/);
  });
  test('error generico se propaga', async () => {
    const f = mockFetchError('network down');
    await expect(tel.fetchJson(f, 'http://x')).rejects.toThrow(/network down/);
  });
  test('throws si no fetchFn ni global fetch', async () => {
    const origFetch = global.fetch;
    delete global.fetch;
    await expect(tel.fetchJson(null, 'http://x')).rejects.toThrow(/fetchFn requerido/);
    global.fetch = origFetch;
  });
  test('usa global fetch si no fetchFn', async () => {
    const origFetch = global.fetch;
    global.fetch = mockFetch([{ ok: 1 }]);
    const r = await tel.fetchJson(null, 'http://x');
    expect(r).toEqual([{ ok: 1 }]);
    global.fetch = origFetch;
  });
});

// ── getCurrentSession ────────────────────────────────────────────────────────
describe('getCurrentSession', () => {
  test('retorna null si vacio', async () => {
    const r = await tel.getCurrentSession(mockFetch([]));
    expect(r).toBeNull();
  });
  test('mapea sesion Race', async () => {
    const f = mockFetch([{
      session_key: 9999, session_name: 'Race', country_name: 'Monaco',
      circuit_short_name: 'Monaco', date_start: '2026-05-25T13:00:00Z',
      date_end: '2026-05-25T15:00:00Z', year: 2026, meeting_key: 1234,
    }]);
    const r = await tel.getCurrentSession(f);
    expect(r.session_name).toBe('Race');
    expect(r.session_type_label).toBe('Carrera');
    expect(r.session_key).toBe(9999);
  });
  test('mapea Practice_1', async () => {
    const f = mockFetch([{ session_key: 1, session_name: 'Practice_1' }]);
    const r = await tel.getCurrentSession(f);
    expect(r.session_type_label).toBe('Práctica Libre 1');
  });
  test('mapea Sprint_Shootout', async () => {
    const f = mockFetch([{ session_key: 1, session_name: 'Sprint_Shootout' }]);
    const r = await tel.getCurrentSession(f);
    expect(r.session_type_label).toBe('Qualy Sprint');
  });
  test('mapea Sprint', async () => {
    const f = mockFetch([{ session_key: 1, session_name: 'Sprint' }]);
    const r = await tel.getCurrentSession(f);
    expect(r.session_type_label).toBe('Carrera Sprint');
  });
  test('mapea Qualifying', async () => {
    const f = mockFetch([{ session_key: 1, session_name: 'Qualifying' }]);
    const r = await tel.getCurrentSession(f);
    expect(r.session_type_label).toBe('Qualy');
  });
  test('mapea unknown session_name fallback al mismo nombre', async () => {
    const f = mockFetch([{ session_key: 1, session_name: 'Unknown_X' }]);
    const r = await tel.getCurrentSession(f);
    expect(r.session_type_label).toBe('Unknown_X');
  });
});

// ── isSessionLive ────────────────────────────────────────────────────────────
describe('isSessionLive', () => {
  test('null session false', () => {
    expect(tel.isSessionLive(null)).toBe(false);
  });
  test('session sin date_start false', () => {
    expect(tel.isSessionLive({ date_end: '2026-01-01T00:00:00Z' })).toBe(false);
  });
  test('session sin date_end false', () => {
    expect(tel.isSessionLive({ date_start: '2026-01-01T00:00:00Z' })).toBe(false);
  });
  test('now antes del start false', () => {
    const r = tel.isSessionLive({
      date_start: '2026-12-01T10:00:00Z',
      date_end: '2026-12-01T12:00:00Z',
    }, new Date('2026-12-01T09:00:00Z'));
    expect(r).toBe(false);
  });
  test('now despues del end false', () => {
    const r = tel.isSessionLive({
      date_start: '2026-12-01T10:00:00Z',
      date_end: '2026-12-01T12:00:00Z',
    }, new Date('2026-12-01T13:00:00Z'));
    expect(r).toBe(false);
  });
  test('now dentro del rango true', () => {
    const r = tel.isSessionLive({
      date_start: '2026-12-01T10:00:00Z',
      date_end: '2026-12-01T12:00:00Z',
    }, new Date('2026-12-01T11:00:00Z'));
    expect(r).toBe(true);
  });
});

// ── getDriverIntervals ───────────────────────────────────────────────────────
describe('getDriverIntervals', () => {
  test('sin sessionKey retorna nulls', async () => {
    const r = await tel.getDriverIntervals(mockFetch([]), null, 1);
    expect(r.gap_to_leader).toBeNull();
  });
  test('sin driverNumber retorna nulls', async () => {
    const r = await tel.getDriverIntervals(mockFetch([]), 1, null);
    expect(r.gap_to_leader).toBeNull();
  });
  test('rows vacio nulls', async () => {
    const r = await tel.getDriverIntervals(mockFetch([]), 1, 1);
    expect(r.interval).toBeNull();
  });
  test('toma el ultimo row', async () => {
    const f = mockFetch([
      { gap_to_leader: 5.0, interval: 1.0, date: '2026-01-01T00:00:00Z' },
      { gap_to_leader: 7.5, interval: 2.5, date: '2026-01-01T00:00:05Z' },
    ]);
    const r = await tel.getDriverIntervals(f, 9999, 4);
    expect(r.gap_to_leader).toBe(7.5);
    expect(r.interval).toBe(2.5);
    expect(r.last_seen).toBe('2026-01-01T00:00:05Z');
  });
  test('row sin gap_to_leader null', async () => {
    const f = mockFetch([{ interval: 1.0, date: '2026-01-01' }]);
    const r = await tel.getDriverIntervals(f, 1, 1);
    expect(r.gap_to_leader).toBeNull();
  });
});

// ── getDriverLapData ─────────────────────────────────────────────────────────
describe('getDriverLapData', () => {
  test('sin sessionKey vacio', async () => {
    const r = await tel.getDriverLapData(mockFetch([]), null, 1);
    expect(r).toEqual([]);
  });
  test('sin driverNumber vacio', async () => {
    expect(await tel.getDriverLapData(mockFetch([]), 1, null)).toEqual([]);
  });
  test('mapea laps', async () => {
    const f = mockFetch([
      { lap_number: 1, lap_duration: 90.5, duration_sector_1: 30, duration_sector_2: 30, duration_sector_3: 30.5, is_pit_out_lap: false, date_start: 'd' },
      { lap_number: 2, lap_duration: 89.2, duration_sector_1: 29, duration_sector_2: 30, duration_sector_3: 30.2, is_pit_out_lap: true, date_start: 'd' },
    ]);
    const r = await tel.getDriverLapData(f, 1, 1);
    expect(r.length).toBe(2);
    expect(r[0].sector_1).toBe(30);
    expect(r[1].is_pit_out_lap).toBe(true);
  });
});

// ── getFastestLap ────────────────────────────────────────────────────────────
describe('getFastestLap', () => {
  test('null retorna null', () => {
    expect(tel.getFastestLap(null)).toBeNull();
  });
  test('non-array retorna null', () => {
    expect(tel.getFastestLap('no')).toBeNull();
  });
  test('vacio null', () => {
    expect(tel.getFastestLap([])).toBeNull();
  });
  test('skip lap_duration no number', () => {
    expect(tel.getFastestLap([{ lap_duration: null }])).toBeNull();
  });
  test('skip pit_out_lap', () => {
    expect(tel.getFastestLap([{ lap_duration: 90, is_pit_out_lap: true }])).toBeNull();
  });
  test('encuentra el menor', () => {
    const r = tel.getFastestLap([
      { lap_number: 1, lap_duration: 95.0 },
      { lap_number: 2, lap_duration: 90.5 },
      { lap_number: 3, lap_duration: 92.0 },
    ]);
    expect(r.lap_number).toBe(2);
  });
  test('skip pit_out incluso si seria el menor', () => {
    const r = tel.getFastestLap([
      { lap_number: 1, lap_duration: 95.0, is_pit_out_lap: false },
      { lap_number: 2, lap_duration: 80.0, is_pit_out_lap: true },
    ]);
    expect(r.lap_number).toBe(1);
  });
});

// ── getCurrentStint ──────────────────────────────────────────────────────────
describe('getCurrentStint', () => {
  test('sin sessionKey null', async () => {
    expect(await tel.getCurrentStint(mockFetch([]), null, 1)).toBeNull();
  });
  test('sin driverNumber null', async () => {
    expect(await tel.getCurrentStint(mockFetch([]), 1, null)).toBeNull();
  });
  test('vacio null', async () => {
    expect(await tel.getCurrentStint(mockFetch([]), 1, 1)).toBeNull();
  });
  test('toma ultimo stint con compound conocido', async () => {
    const f = mockFetch([
      { compound: 'MEDIUM', tyre_age_at_start: 0, lap_start: 1, lap_end: 20, stint_number: 1 },
      { compound: 'SOFT', tyre_age_at_start: 5, lap_start: 21, lap_end: null, stint_number: 2 },
    ]);
    const r = await tel.getCurrentStint(f, 1, 1);
    expect(r.compound).toBe('SOFT');
    expect(r.compound_label).toBe('Blandos');
    expect(r.tyre_age_at_start).toBe(5);
    expect(r.stint_number).toBe(2);
  });
  test('compound desconocido fallback al mismo string', async () => {
    const f = mockFetch([{ compound: 'UNKNOWN', tyre_age_at_start: 0 }]);
    const r = await tel.getCurrentStint(f, 1, 1);
    expect(r.compound_label).toBe('UNKNOWN');
  });
  test('tyre_age default 0', async () => {
    const f = mockFetch([{ compound: 'HARD' }]);
    const r = await tel.getCurrentStint(f, 1, 1);
    expect(r.tyre_age_at_start).toBe(0);
  });
});

// ── getDriverPits ────────────────────────────────────────────────────────────
describe('getDriverPits', () => {
  test('sin sessionKey vacio', async () => {
    expect(await tel.getDriverPits(mockFetch([]), null, 1)).toEqual([]);
  });
  test('sin driverNumber vacio', async () => {
    expect(await tel.getDriverPits(mockFetch([]), 1, null)).toEqual([]);
  });
  test('mapea pits', async () => {
    const f = mockFetch([
      { lap_number: 18, pit_duration: 22.5, date: 'd1' },
      { lap_number: 35, pit_duration: 21.8, date: 'd2' },
    ]);
    const r = await tel.getDriverPits(f, 1, 1);
    expect(r.length).toBe(2);
    expect(r[0].lap_number).toBe(18);
    expect(r[1].pit_duration).toBe(21.8);
  });
});

// ── getDriverLocation ────────────────────────────────────────────────────────
describe('getDriverLocation', () => {
  test('sin sessionKey null', async () => {
    expect(await tel.getDriverLocation(mockFetch([]), null, 1)).toBeNull();
  });
  test('sin driverNumber null', async () => {
    expect(await tel.getDriverLocation(mockFetch([]), 1, null)).toBeNull();
  });
  test('rows vacio null', async () => {
    expect(await tel.getDriverLocation(mockFetch([]), 1, 1)).toBeNull();
  });
  test('retorna ultimo location', async () => {
    const f = mockFetch([
      { x: 100, y: 200, z: 5, date: '2026-01-01T00:00:00Z' },
      { x: 150, y: 250, z: 5, date: '2026-01-01T00:00:01Z' },
    ]);
    const r = await tel.getDriverLocation(f, 1, 1);
    expect(r.x).toBe(150);
    expect(r.y).toBe(250);
  });
  test('con sinceDate custom', async () => {
    const f = mockFetch([{ x: 1, y: 1, z: 0, date: 'd' }]);
    const r = await tel.getDriverLocation(f, 1, 1, new Date('2026-01-01'));
    expect(r).toBeDefined();
  });
});

// ── getDriverTelemetry ───────────────────────────────────────────────────────
describe('getDriverTelemetry', () => {
  test('sin sessionKey null', async () => {
    expect(await tel.getDriverTelemetry(mockFetch([]), null, 1)).toBeNull();
  });
  test('sin driverNumber null', async () => {
    expect(await tel.getDriverTelemetry(mockFetch([]), 1, null)).toBeNull();
  });
  test('rows vacio null', async () => {
    expect(await tel.getDriverTelemetry(mockFetch([]), 1, 1)).toBeNull();
  });
  test('retorna ultimo telemetry', async () => {
    const f = mockFetch([
      { rpm: 10000, speed: 250, n_gear: 6, throttle: 100, brake: 0, drs: 0, date: 'd1' },
      { rpm: 11500, speed: 320, n_gear: 7, throttle: 100, brake: 0, drs: 12, date: 'd2' },
    ]);
    const r = await tel.getDriverTelemetry(f, 1, 1);
    expect(r.rpm).toBe(11500);
    expect(r.speed).toBe(320);
    expect(r.gear).toBe(7);
    expect(r.drs).toBe(12);
  });
  test('con sinceDate custom', async () => {
    const f = mockFetch([{ rpm: 5000, speed: 100, n_gear: 3, throttle: 50, brake: 0, drs: 0, date: 'd' }]);
    const r = await tel.getDriverTelemetry(f, 1, 1, new Date('2026-01-01'));
    expect(r.rpm).toBe(5000);
  });
});

// ── getAllDriversLocation ────────────────────────────────────────────────────
describe('getAllDriversLocation', () => {
  test('sin sessionKey vacio', async () => {
    expect(await tel.getAllDriversLocation(mockFetch([]), null)).toEqual([]);
  });
  test('rows vacio', async () => {
    expect(await tel.getAllDriversLocation(mockFetch([]), 1)).toEqual([]);
  });
  test('agrupa por driver_number tomando ultimo', async () => {
    const f = mockFetch([
      { driver_number: 4, x: 100, y: 100, z: 0, date: '2026-01-01T00:00:00Z' },
      { driver_number: 4, x: 200, y: 200, z: 0, date: '2026-01-01T00:00:01Z' },
      { driver_number: 16, x: 50, y: 50, z: 0, date: '2026-01-01T00:00:00Z' },
    ]);
    const r = await tel.getAllDriversLocation(f, 1);
    expect(r.length).toBe(2);
    const norris = r.find((d) => d.driver_number === 4);
    expect(norris.x).toBe(200);
  });
  test('con sinceDate custom', async () => {
    const f = mockFetch([{ driver_number: 1, x: 0, y: 0, z: 0, date: 'd' }]);
    const r = await tel.getAllDriversLocation(f, 1, new Date('2026-01-01'));
    expect(r.length).toBe(1);
  });
});

// ── buildDriverSnapshot ──────────────────────────────────────────────────────
describe('buildDriverSnapshot', () => {
  test('null parts retorna estructura nulls', () => {
    const r = tel.buildDriverSnapshot(null);
    expect(r.gap_to_leader).toBeNull();
    expect(r.tyre).toBeNull();
    expect(r.location).toBeNull();
    expect(r.total_pits).toBe(0);
  });
  test('vacio parts', () => {
    const r = tel.buildDriverSnapshot({});
    expect(r.gap_to_leader).toBeNull();
    expect(r.snapshot_at).toBeDefined();
  });
  test('snapshot completo', () => {
    const r = tel.buildDriverSnapshot({
      intervals: { gap_to_leader: 5.5, interval: 1.2 },
      laps: [
        { lap_number: 1, lap_duration: 95, sector_1: 31, sector_2: 32, sector_3: 32 },
        { lap_number: 2, lap_duration: 90, sector_1: 30, sector_2: 30, sector_3: 30 },
      ],
      stint: { compound: 'SOFT', compound_label: 'Blandos', tyre_age_at_start: 3, stint_number: 2 },
      pits: [{ lap_number: 18, pit_duration: 22 }],
      location: { x: 100, y: 200, z: 5 },
      telemetry: { rpm: 11000, speed: 280, gear: 7, throttle: 100, brake: 0, drs: 0 },
    });
    expect(r.gap_to_leader).toBe(5.5);
    expect(r.current_lap).toBe(2);
    expect(r.last_lap_time).toBe(90);
    expect(r.last_sectors.s1).toBe(30);
    expect(r.fastest_lap_time).toBe(90);
    expect(r.fastest_lap_number).toBe(2);
    expect(r.tyre.compound).toBe('SOFT');
    expect(r.total_pits).toBe(1);
    expect(r.last_pit_lap).toBe(18);
    expect(r.location.x).toBe(100);
    expect(r.telemetry.rpm).toBe(11000);
  });
  test('snapshot sin laps', () => {
    const r = tel.buildDriverSnapshot({ laps: [] });
    expect(r.current_lap).toBeNull();
    expect(r.last_lap_time).toBeNull();
    expect(r.last_sectors).toBeNull();
    expect(r.fastest_lap_time).toBeNull();
  });
  test('snapshot con pits vacios', () => {
    const r = tel.buildDriverSnapshot({ pits: [] });
    expect(r.total_pits).toBe(0);
    expect(r.last_pit_lap).toBeNull();
  });
});

// ── Constants exports ────────────────────────────────────────────────────────
describe('exports constants', () => {
  test('OPENF1_BASE definido', () => {
    expect(tel.OPENF1_BASE).toContain('openf1.org');
  });
  test('SESSION_TYPES contiene Race', () => {
    expect(tel.SESSION_TYPES.Race).toBe('Carrera');
  });
  test('TYRE_COMPOUNDS contiene SOFT', () => {
    expect(tel.TYRE_COMPOUNDS.SOFT).toBe('Blandos');
  });
});
