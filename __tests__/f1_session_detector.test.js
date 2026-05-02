'use strict';
/**
 * Tests para session_detector.js — MiiaF1.45/46/47
 */
const {
  normalizeSessionType,
  getSessionLabel,
  isSessionActive,
  getActiveSessions,
  selectPrimarySession,
  createBestLapTracker,
} = require('../sports/f1_dashboard/session_detector');

// ─── normalizeSessionType — MiiaF1.45 ───────────────────────────────────────
describe('normalizeSessionType()', () => {
  test.each([
    ['Practice 1', 'FP1'],
    ['Practice 2', 'FP2'],
    ['Practice 3', 'FP3'],
    ['Qualifying', 'Qualifying'],
    ['Sprint Qualifying', 'Sprint Qualifying'],
    ['Sprint', 'Sprint'],
    ['Race', 'Race'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeSessionType(input)).toBe(expected);
  });

  test('null/undefined -> Unknown', () => {
    expect(normalizeSessionType(null)).toBe('Unknown');
    expect(normalizeSessionType(undefined)).toBe('Unknown');
    expect(normalizeSessionType('')).toBe('Unknown');
  });

  test('cadena no reconocida -> Unknown', () => {
    expect(normalizeSessionType('Super Special Stage')).toBe('Unknown');
  });
});

// ─── getSessionLabel ─────────────────────────────────────────────────────────
describe('getSessionLabel()', () => {
  test('FP1 -> PRÁCTICA LIBRE 1', () => {
    expect(getSessionLabel('FP1')).toBe('PRÁCTICA LIBRE 1');
  });

  test('Race -> CARRERA', () => {
    expect(getSessionLabel('Race')).toBe('CARRERA');
  });

  test('Sprint -> SPRINT', () => {
    expect(getSessionLabel('Sprint')).toBe('SPRINT');
  });

  test('tipo desconocido -> EN VIVO', () => {
    expect(getSessionLabel('Unknown')).toBe('EN VIVO');
    expect(getSessionLabel('')).toBe('EN VIVO');
  });
});

// ─── isSessionActive — MiiaF1.46 ────────────────────────────────────────────
describe('isSessionActive()', () => {
  const NOW = new Date('2026-05-02T15:00:00Z');

  test('null session -> false', () => {
    expect(isSessionActive(null, NOW)).toBe(false);
  });

  test('session sin date_start -> false', () => {
    expect(isSessionActive({ session_key: 1 }, NOW)).toBe(false);
  });

  test('session activa (now entre start y end) -> true', () => {
    const s = {
      date_start: '2026-05-02T14:00:00Z',
      date_end: '2026-05-02T16:00:00Z',
    };
    expect(isSessionActive(s, NOW)).toBe(true);
  });

  test('session dentro del buffer de 2h post-end -> true', () => {
    const s = {
      date_start: '2026-05-02T12:00:00Z',
      date_end: '2026-05-02T14:30:00Z',
    };
    // NOW = 15:00, end+2h = 16:30 -> activa
    expect(isSessionActive(s, NOW)).toBe(true);
  });

  test('session fuera del buffer -> false', () => {
    const s = {
      date_start: '2026-05-02T09:00:00Z',
      date_end: '2026-05-02T11:00:00Z',
    };
    // NOW = 15:00, end+2h = 13:00 -> inactiva
    expect(isSessionActive(s, NOW)).toBe(false);
  });

  test('session futura -> false', () => {
    const s = {
      date_start: '2026-05-02T18:00:00Z',
      date_end: '2026-05-02T20:00:00Z',
    };
    expect(isSessionActive(s, NOW)).toBe(false);
  });

  test('session sin date_end -> usa start + 3h como end', () => {
    const s = {
      date_start: '2026-05-02T13:00:00Z',
      // date_end ausente -> end = 16:00 + 2h buffer = 18:00
    };
    expect(isSessionActive(s, NOW)).toBe(true);
  });

  test('now inyectable -> respeta el parametro', () => {
    const s = {
      date_start: '2026-06-01T12:00:00Z',
      date_end: '2026-06-01T14:00:00Z',
    };
    const futureNow = new Date('2026-06-01T13:00:00Z');
    expect(isSessionActive(s, futureNow)).toBe(true);
    expect(isSessionActive(s, NOW)).toBe(false);
  });
});

// ─── getActiveSessions ───────────────────────────────────────────────────────
describe('getActiveSessions()', () => {
  const NOW = new Date('2026-05-02T15:00:00Z');

  test('null -> []', () => {
    expect(getActiveSessions(null, NOW)).toEqual([]);
  });

  test('empty -> []', () => {
    expect(getActiveSessions([], NOW)).toEqual([]);
  });

  test('filtra solo sesiones activas', () => {
    const sessions = [
      { session_key: 1, date_start: '2026-05-02T14:00:00Z', date_end: '2026-05-02T16:00:00Z', session_name: 'Race' },
      { session_key: 2, date_start: '2026-05-02T08:00:00Z', date_end: '2026-05-02T09:00:00Z', session_name: 'Practice 1' },
    ];
    const active = getActiveSessions(sessions, NOW);
    expect(active.length).toBe(1);
    expect(active[0].session_name).toBe('Race');
  });

  test('multiples activas -> retorna todas', () => {
    const sessions = [
      { session_key: 1, date_start: '2026-05-02T14:00:00Z', date_end: '2026-05-02T16:00:00Z', session_name: 'Sprint' },
      { session_key: 2, date_start: '2026-05-02T14:30:00Z', date_end: '2026-05-02T15:30:00Z', session_name: 'Race' },
    ];
    expect(getActiveSessions(sessions, NOW).length).toBe(2);
  });
});

// ─── selectPrimarySession ────────────────────────────────────────────────────
describe('selectPrimarySession()', () => {
  const NOW = new Date('2026-05-02T15:00:00Z');
  const ACTIVE_SESSION = { date_start: '2026-05-02T14:00:00Z', date_end: '2026-05-02T16:00:00Z' };

  test('null -> null', () => {
    expect(selectPrimarySession(null, NOW)).toBeNull();
  });

  test('ninguna activa -> null', () => {
    const sessions = [
      { ...ACTIVE_SESSION, date_end: '2026-05-02T09:00:00Z', session_name: 'Practice 1' },
    ];
    expect(selectPrimarySession(sessions, NOW)).toBeNull();
  });

  test('Race activa prioridad mas alta', () => {
    const sessions = [
      { ...ACTIVE_SESSION, session_name: 'Race', session_key: 1 },
      { ...ACTIVE_SESSION, session_name: 'Sprint', session_key: 2 },
    ];
    const s = selectPrimarySession(sessions, NOW);
    expect(s.session_name).toBe('Race');
  });

  test('solo FP1 activa -> retorna FP1', () => {
    const sessions = [
      { ...ACTIVE_SESSION, session_name: 'Practice 1', session_key: 1 },
    ];
    const s = selectPrimarySession(sessions, NOW);
    expect(s.session_name).toBe('Practice 1');
  });

  test('sesion activa con nombre desconocido -> retorna primera activa', () => {
    const sessions = [
      { ...ACTIVE_SESSION, session_name: 'Hot Lap Super Special', session_key: 9 },
    ];
    const s = selectPrimarySession(sessions, NOW);
    expect(s.session_name).toBe('Hot Lap Super Special');
  });

  test('Sprint Qualifying tiene prioridad sobre Qualifying (per SESSION_PRIORITY)', () => {
    const sessions = [
      { ...ACTIVE_SESSION, session_name: 'Qualifying', session_key: 2 },
      { ...ACTIVE_SESSION, session_name: 'Sprint Qualifying', session_key: 1 },
    ];
    const s = selectPrimarySession(sessions, NOW);
    // Sprint Qualifying comes before Qualifying in SESSION_PRIORITY
    expect(s.session_name).toBe('Sprint Qualifying');
  });
});

// ─── createBestLapTracker — MiiaF1.47 ────────────────────────────────────────
describe('createBestLapTracker()', () => {
  test('sin callback -> no lanza error al procesar', () => {
    const tracker = createBestLapTracker();
    expect(() => tracker.processLap({ driver_number: 1, lap_duration: 90.5, lap_number: 3 })).not.toThrow();
  });

  test('processLap null -> no hace nada', () => {
    const tracker = createBestLapTracker();
    tracker.processLap(null);
    expect(tracker.getOverallBest()).toBeNull();
  });

  test('lap sin lap_duration -> ignorado', () => {
    const tracker = createBestLapTracker();
    tracker.processLap({ driver_number: 1, lap_number: 1 });
    expect(tracker.getOverallBest()).toBeNull();
  });

  test('primer lap -> overall best + callback overall', () => {
    const cb = jest.fn();
    const tracker = createBestLapTracker(cb);
    const lap = { driver_number: 1, lap_duration: 90.5, lap_number: 3 };
    tracker.processLap(lap);
    expect(tracker.getOverallBest()).toEqual(lap);
    expect(cb).toHaveBeenCalledWith({ type: 'overall', lap });
  });

  test('lap mas lento no bate overall', () => {
    const cb = jest.fn();
    const tracker = createBestLapTracker(cb);
    tracker.processLap({ driver_number: 1, lap_duration: 90.0, lap_number: 3 });
    cb.mockClear();
    tracker.processLap({ driver_number: 1, lap_duration: 91.0, lap_number: 4 });
    expect(cb).not.toHaveBeenCalled();
  });

  test('lap mas rapido del mismo piloto bate overall + callback overall', () => {
    const cb = jest.fn();
    const tracker = createBestLapTracker(cb);
    tracker.processLap({ driver_number: 1, lap_duration: 90.0, lap_number: 3 });
    cb.mockClear();
    const faster = { driver_number: 1, lap_duration: 89.5, lap_number: 5 };
    tracker.processLap(faster);
    expect(tracker.getOverallBest()).toEqual(faster);
    expect(cb).toHaveBeenCalledWith({ type: 'overall', lap: faster });
  });

  test('piloto 2 bate overall de piloto 1 -> callback overall', () => {
    const cb = jest.fn();
    const tracker = createBestLapTracker(cb);
    tracker.processLap({ driver_number: 1, lap_duration: 90.0, lap_number: 3 });
    cb.mockClear();
    const p2Lap = { driver_number: 11, lap_duration: 89.0, lap_number: 2 };
    tracker.processLap(p2Lap);
    expect(tracker.getOverallBest()).toEqual(p2Lap);
    expect(cb).toHaveBeenCalledWith({ type: 'overall', lap: p2Lap });
  });

  test('piloto 2 mejor personal pero no bate overall -> callback personal', () => {
    const cb = jest.fn();
    const tracker = createBestLapTracker(cb);
    tracker.processLap({ driver_number: 1, lap_duration: 88.0, lap_number: 3 });
    cb.mockClear();
    const p2First = { driver_number: 11, lap_duration: 90.0, lap_number: 2 };
    tracker.processLap(p2First);
    expect(cb).toHaveBeenCalledWith({ type: 'personal', lap: p2First });
    cb.mockClear();
    // Piloto 11 mejora su personal pero no bate overall (88.0 sigue siendo el global)
    const p2Better = { driver_number: 11, lap_duration: 89.5, lap_number: 4 };
    tracker.processLap(p2Better);
    expect(cb).toHaveBeenCalledWith({ type: 'personal', lap: p2Better });
  });

  test('getDriverBest retorna null si no ha hecho vuelta', () => {
    const tracker = createBestLapTracker();
    expect(tracker.getDriverBest(99)).toBeNull();
  });

  test('getDriverBest retorna mejor vuelta del piloto', () => {
    const tracker = createBestLapTracker();
    tracker.processLap({ driver_number: 44, lap_duration: 91.0, lap_number: 2 });
    tracker.processLap({ driver_number: 44, lap_duration: 89.5, lap_number: 4 });
    expect(tracker.getDriverBest(44).lap_duration).toBe(89.5);
  });

  test('processLaps con array -> procesa todos', () => {
    const cb = jest.fn();
    const tracker = createBestLapTracker(cb);
    tracker.processLaps([
      { driver_number: 1, lap_duration: 91.0, lap_number: 1 },
      { driver_number: 1, lap_duration: 90.0, lap_number: 2 },
      { driver_number: 11, lap_duration: 89.5, lap_number: 2 },
    ]);
    expect(tracker.getOverallBest().lap_duration).toBe(89.5);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  test('processLaps null/vacio -> no falla', () => {
    const tracker = createBestLapTracker();
    expect(() => tracker.processLaps(null)).not.toThrow();
    expect(() => tracker.processLaps([])).not.toThrow();
    expect(tracker.getOverallBest()).toBeNull();
  });

  test('reset -> limpia todo', () => {
    const tracker = createBestLapTracker();
    tracker.processLap({ driver_number: 1, lap_duration: 90.0, lap_number: 1 });
    tracker.reset();
    expect(tracker.getOverallBest()).toBeNull();
    expect(tracker.getDriverBest(1)).toBeNull();
  });
});

describe('isSessionActive() -- now=undefined usa new Date()', () => {
  test('sesion muy pasada sin now -> false (usa Date real)', () => {
    const s = { date_start: '2000-01-01T00:00:00Z', date_end: '2000-01-01T02:00:00Z' };
    // No inyectamos now -> usa new Date() real
    expect(isSessionActive(s)).toBe(false);
  });
});
