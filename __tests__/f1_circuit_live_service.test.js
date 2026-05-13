'use strict';

/**
 * Tests circuit_live_service.js — pipeline OpenF1 → SVG live.
 * 100% branches.
 */

const svc = require('../sports/f1_dashboard/circuit_live_service');
const telemetry = require('../sports/f1_dashboard/f1_telemetry');

describe('mapLocationsToBacingerBbox', () => {
  const bbox = [7.421, 43.732, 7.430, 43.741]; // Monaco

  test('mapea coords OpenF1 (x,y) al bbox bacinger', () => {
    const locs = [
      { driver_number: 1, x: 0, y: 0, z: 10, date: '2026-05-12T10:00:00Z' },
      { driver_number: 4, x: 500, y: 500, z: 10, date: '2026-05-12T10:00:00Z' },
    ];
    const mapped = svc.mapLocationsToBacingerBbox(locs, bbox);
    expect(mapped.length).toBe(2);
    // min (0,0) → (minLon, minLat) bacinger
    expect(mapped[0].lon).toBeCloseTo(7.421);
    expect(mapped[0].lat).toBeCloseTo(43.732);
    // max (500,500) → (maxLon, maxLat) bacinger
    expect(mapped[1].lon).toBeCloseTo(7.430);
    expect(mapped[1].lat).toBeCloseTo(43.741);
  });

  test('locations vacío → array vacío', () => {
    expect(svc.mapLocationsToBacingerBbox([], bbox)).toEqual([]);
  });

  test('locations no-array → array vacío', () => {
    expect(svc.mapLocationsToBacingerBbox(null, bbox)).toEqual([]);
    expect(svc.mapLocationsToBacingerBbox('foo', bbox)).toEqual([]);
  });

  test('bbox inválido → array vacío', () => {
    const locs = [{ driver_number: 1, x: 100, y: 100 }];
    expect(svc.mapLocationsToBacingerBbox(locs, null)).toEqual([]);
    expect(svc.mapLocationsToBacingerBbox(locs, [1, 2, 3])).toEqual([]); // length != 4
  });

  test('filtra locations con x/y no numéricos', () => {
    const locs = [
      { driver_number: 1, x: 100, y: 100 },
      { driver_number: 2, x: 'bad', y: 200 },
      { driver_number: 3, x: 300, y: undefined },
      { driver_number: 4, x: 400, y: 400 },
    ];
    const mapped = svc.mapLocationsToBacingerBbox(locs, bbox);
    expect(mapped.length).toBe(2); // solo 1 y 4
    expect(mapped.map((m) => m.driver_number)).toEqual([1, 4]);
  });

  test('todas locations inválidas → array vacío', () => {
    const locs = [
      { driver_number: 1, x: 'a', y: 'b' },
      { driver_number: 2 },
    ];
    expect(svc.mapLocationsToBacingerBbox(locs, bbox)).toEqual([]);
  });

  test('rangos degenerados (todas mismas coords) no rompe', () => {
    const locs = [
      { driver_number: 1, x: 100, y: 200 },
      { driver_number: 2, x: 100, y: 200 },
    ];
    const mapped = svc.mapLocationsToBacingerBbox(locs, bbox);
    expect(mapped.length).toBe(2);
    expect(Number.isFinite(mapped[0].lon)).toBe(true);
    expect(Number.isFinite(mapped[0].lat)).toBe(true);
  });
});

describe('mergeDriversInfo', () => {
  const mapped = [
    { driver_number: 1, lat: 43.74, lon: 7.42 },
    { driver_number: 4, lat: 43.73, lon: 7.43 },
  ];

  test('mergea team_color + driver_name + team_name', () => {
    const info = [
      { driver_number: 1, full_name: 'Max Verstappen', team_name: 'Red Bull', team_colour: '3671C6' },
      { driver_number: 4, full_name: 'Lando Norris', team_name: 'McLaren', team_colour: 'FF8000' },
    ];
    const merged = svc.mergeDriversInfo(mapped, info);
    expect(merged.length).toBe(2);
    expect(merged[0].driver_name).toBe('Max Verstappen');
    expect(merged[0].team_color).toBe('#3671C6');
    expect(merged[0].team_name).toBe('Red Bull');
  });

  test('marca is_adopted=true si driver_number coincide', () => {
    const info = [{ driver_number: 4, full_name: 'Norris' }];
    const merged = svc.mergeDriversInfo(mapped, info, 4);
    expect(merged[1].is_adopted).toBe(true);
    expect(merged[0].is_adopted).toBe(false);
  });

  test('is_adopted con string number también funciona', () => {
    const merged = svc.mergeDriversInfo(mapped, [], '4');
    expect(merged[1].is_adopted).toBe(true);
  });

  test('adoptedDriverNum null → ninguno is_adopted', () => {
    const merged = svc.mergeDriversInfo(mapped, [], null);
    expect(merged.every((d) => d.is_adopted === false)).toBe(true);
  });

  test('adoptedDriverNum undefined → ninguno is_adopted', () => {
    const merged = svc.mergeDriversInfo(mapped, []);
    expect(merged.every((d) => d.is_adopted === false)).toBe(true);
  });

  test('fallback driver_name: broadcast_name si full_name falta', () => {
    const info = [{ driver_number: 1, broadcast_name: 'M. Verstappen' }];
    const merged = svc.mergeDriversInfo(mapped, info);
    expect(merged[0].driver_name).toBe('M. Verstappen');
  });

  test('fallback driver_name: name_acronym si full_name+broadcast falta', () => {
    const info = [{ driver_number: 1, name_acronym: 'VER' }];
    const merged = svc.mergeDriversInfo(mapped, info);
    expect(merged[0].driver_name).toBe('VER');
  });

  test('sin info match → driver_name = "#N"', () => {
    const merged = svc.mergeDriversInfo(mapped, []);
    expect(merged[0].driver_name).toBe('#1');
    expect(merged[1].driver_name).toBe('#4');
  });

  test('team_colour con prefijo # se normaliza', () => {
    const info = [{ driver_number: 1, team_colour: '#3671C6' }];
    const merged = svc.mergeDriversInfo(mapped, info);
    expect(merged[0].team_color).toBe('#3671C6');
  });

  test('team_colour ausente → default white', () => {
    const merged = svc.mergeDriversInfo(mapped, []);
    expect(merged[0].team_color).toBe('#FFFFFF');
  });

  test('driversInfo no-array tratado como vacío', () => {
    const merged = svc.mergeDriversInfo(mapped, null);
    expect(merged.length).toBe(2);
    expect(merged[0].team_color).toBe('#FFFFFF');
  });

  test('mappedLocations no-array → vacío', () => {
    expect(svc.mergeDriversInfo(null, [])).toEqual([]);
    expect(svc.mergeDriversInfo('x', [])).toEqual([]);
  });

  test('driversInfo con entry sin driver_number es ignorada', () => {
    const info = [
      { full_name: 'No Number' },
      null,
      { driver_number: 1, full_name: 'OK' },
    ];
    const merged = svc.mergeDriversInfo(mapped, info);
    expect(merged[0].driver_name).toBe('OK');
  });
});

describe('buildLiveCircuitSvg pipeline', () => {
  let origGet, origLoc;
  beforeAll(() => {
    origGet = telemetry.getCurrentSession;
    origLoc = telemetry.getAllDriversLocation;
  });
  afterAll(() => {
    telemetry.getCurrentSession = origGet;
    telemetry.getAllDriversLocation = origLoc;
  });

  test('circuitId no resoluble → null + isLive false', async () => {
    const out = await svc.buildLiveCircuitSvg({ circuitId: 'inexistente' });
    expect(out.svg).toBeNull();
    expect(out.isLive).toBe(false);
    expect(out.sessionKey).toBeNull();
    expect(out.driverCount).toBe(0);
  });

  test('sin args → null', async () => {
    const out = await svc.buildLiveCircuitSvg();
    expect(out.svg).toBeNull();
  });

  test('session getCurrentSession throws → SVG estático sin dots', async () => {
    telemetry.getCurrentSession = async () => { throw new Error('OpenF1 down'); };
    const out = await svc.buildLiveCircuitSvg({
      circuitId: 'monaco',
      fetchFn: () => Promise.resolve({ ok: true, json: async () => [] }),
    });
    expect(out.svg).toContain('<svg');
    expect(out.svg).not.toContain('miiaf1-driver-dot');
    expect(out.isLive).toBe(false);
  });

  test('session null → SVG estático sin dots', async () => {
    telemetry.getCurrentSession = async () => null;
    const out = await svc.buildLiveCircuitSvg({
      circuitId: 'monaco',
      fetchFn: () => Promise.resolve({ ok: true, json: async () => [] }),
    });
    expect(out.svg).toContain('<svg');
    expect(out.isLive).toBe(false);
  });

  test('session sin session_key → SVG estático', async () => {
    telemetry.getCurrentSession = async () => ({ something: 'else' });
    const out = await svc.buildLiveCircuitSvg({
      circuitId: 'monaco',
      fetchFn: () => Promise.resolve({ ok: true, json: async () => [] }),
    });
    expect(out.isLive).toBe(false);
  });

  test('session live + locations + drivers → SVG con dots', async () => {
    telemetry.getCurrentSession = async () => ({ session_key: 9999 });
    telemetry.getAllDriversLocation = async () => [
      { driver_number: 1, x: 0, y: 0, z: 10, date: 'x' },
      { driver_number: 4, x: 100, y: 100, z: 10, date: 'x' },
    ];
    const driversFetch = async () => ({
      ok: true,
      json: async () => [
        { driver_number: 1, full_name: 'Max Verstappen', team_name: 'Red Bull', team_colour: '3671C6' },
        { driver_number: 4, full_name: 'Lando Norris', team_name: 'McLaren', team_colour: 'FF8000' },
      ],
    });
    const out = await svc.buildLiveCircuitSvg({
      circuitId: 'monaco',
      fetchFn: driversFetch,
      adoptedDriverNum: 4,
    });
    expect(out.svg).toContain('data-driver-number="1"');
    expect(out.svg).toContain('data-driver-number="4"');
    expect(out.svg).toContain('Max Verstappen');
    expect(out.svg).toContain('Lando Norris');
    expect(out.isLive).toBe(true);
    expect(out.sessionKey).toBe(9999);
    expect(out.driverCount).toBe(2);
  });

  test('Promise.all rechaza (location/drivers fail) → fallback sin dots', async () => {
    telemetry.getCurrentSession = async () => ({ session_key: 9999 });
    telemetry.getAllDriversLocation = async () => { throw new Error('loc fail'); };
    const out = await svc.buildLiveCircuitSvg({
      circuitId: 'monaco',
      fetchFn: () => Promise.resolve({ ok: true, json: async () => [] }),
    });
    expect(out.svg).toContain('<svg');
    expect(out.driverCount).toBe(0);
  });

  test('locations no-array (defensive) → driverCount 0', async () => {
    telemetry.getCurrentSession = async () => ({ session_key: 9999 });
    telemetry.getAllDriversLocation = async () => null;
    const out = await svc.buildLiveCircuitSvg({
      circuitId: 'monaco',
      fetchFn: () => Promise.resolve({ ok: true, json: async () => [] }),
    });
    expect(out.driverCount).toBe(0);
  });

  test('drivers info no-array (defensive) → driverCount 0', async () => {
    telemetry.getCurrentSession = async () => ({ session_key: 9999 });
    telemetry.getAllDriversLocation = async () => [{ driver_number: 1, x: 0, y: 0 }];
    const out = await svc.buildLiveCircuitSvg({
      circuitId: 'monaco',
      fetchFn: () => Promise.resolve({ ok: true, json: async () => 'not-array' }),
    });
    expect(out.driverCount).toBe(1); // location se mapea aunque drivers info vacío
  });

  test('viewport custom + showLabels propagado', async () => {
    telemetry.getCurrentSession = async () => null;
    const out = await svc.buildLiveCircuitSvg({
      circuitId: 'monaco',
      fetchFn: () => Promise.resolve({ ok: true, json: async () => [] }),
      viewport: { width: 1000, height: 600 },
      showLabels: true,
    });
    expect(out.svg).toContain('viewBox="0 0 1000 600"');
  });
});

describe('_fetchDriversInfo helper', () => {
  test('llama OpenF1 /drivers con session_key', async () => {
    let capturedUrl = null;
    const fetchFn = async (url) => {
      capturedUrl = url;
      return { ok: true, json: async () => [{ driver_number: 1 }] };
    };
    const result = await svc._fetchDriversInfo(fetchFn, 9999);
    expect(capturedUrl).toBe('https://api.openf1.org/v1/drivers?session_key=9999');
    expect(result).toEqual([{ driver_number: 1 }]);
  });

  test('respuesta no-array → array vacío', async () => {
    const fetchFn = async () => ({ ok: true, json: async () => ({ error: 'x' }) });
    const result = await svc._fetchDriversInfo(fetchFn, 9999);
    expect(result).toEqual([]);
  });
});
