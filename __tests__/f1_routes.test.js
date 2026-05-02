'use strict';

/**
 * Tests supertest para routes/f1.js — todos los endpoints F1.
 * Mock firebase-admin, live_cache, f1_telemetry, circuit_maps, circuit_overlay,
 * f1_fantasy, f1_paywall, f1_schema. Usa globalThis para controlar mocks por test.
 *
 * Endpoints cubiertos:
 *   - GET /api/f1/calendar/:season
 *   - GET /api/f1/results/:season/:gp_id (200 / 404 / 500)
 *   - GET /api/f1/standings/drivers/:season
 *   - GET /api/f1/standings/constructors/:season
 *   - GET /api/f1/driver/:season/:driver_id (200 / 404)
 *   - POST /api/f1/adopt (200 / 400 / 401 / 404)
 *   - GET /api/f1/prefs (con + sin doc)
 *   - PATCH /api/f1/prefs
 *   - GET /api/f1/live/status / positions / driver/:n
 *   - GET /api/f1/circuit/:id, /circuits, /circuit/:id/live
 *   - GET /api/f1/addon/status
 *   - GET /api/f1/fantasy/leaderboard, /fantasy/me
 *   - GET /api/f1/live/session, /live/driver/:n/snapshot, /live/locations,
 *         /live/driver/:n/telemetry, /live/driver/:n/laps
 */

// Mock state controlable
globalThis.__f1FirestoreState = {
  docExists: true,
  docData: {},
  collectionDocs: [],
  setCalls: [],
  throwError: false,
};

jest.mock('firebase-admin', () => {
  const firestore = () => ({
    collection: (path) => ({
      orderBy: () => ({
        get: () => globalThis.__f1FirestoreState.throwError
          ? Promise.reject(new Error('FS-ERR'))
          : Promise.resolve({
              docs: globalThis.__f1FirestoreState.collectionDocs.map(d => ({ id: d.id, data: () => d.data })),
            }),
      }),
      get: () => globalThis.__f1FirestoreState.throwError
        ? Promise.reject(new Error('FS-ERR'))
        : Promise.resolve({
            docs: globalThis.__f1FirestoreState.collectionDocs.map(d => ({ id: d.id, data: () => d.data })),
          }),
    }),
    doc: (path) => ({
      get: () => globalThis.__f1FirestoreState.throwError
        ? Promise.reject(new Error('FS-ERR'))
        : Promise.resolve({
            exists: globalThis.__f1FirestoreState.docExists,
            id: path.split('/').pop(),
            data: () => globalThis.__f1FirestoreState.docData,
          }),
      set: (data, opts) => {
        if (globalThis.__f1FirestoreState.throwError) return Promise.reject(new Error('FS-SET-ERR'));
        globalThis.__f1FirestoreState.setCalls.push({ path, data, opts });
        return Promise.resolve();
      },
    }),
  });
  return {
    app: jest.fn(() => ({ name: 'test' })),
    firestore,
  };
});

jest.mock('../sports/f1_dashboard/f1_schema', () => ({
  paths: {
    result: (s, gp) => `f1_data/${s}/results/${gp}`,
    driver: (s, d) => `f1_data/${s}/drivers/${d}`,
    f1Prefs: (uid) => `owners/${uid}/f1_prefs/current`,
  },
  validateF1Prefs: jest.fn(() => ({ valid: true })),
}));

globalThis.__f1LiveCacheState = {
  raceStatus: { isLive: true, lap: 30, totalLaps: 70, session: 'Race' },
  positions: [{ driver_number: 1, position: 1 }],
  driverPosition: { name: 'Norris', position: 1 },
  throwError: false,
};

jest.mock('../sports/f1_dashboard/live_cache', () => ({
  getLiveCache: () => ({
    getRaceStatus: () => globalThis.__f1LiveCacheState.throwError
      ? Promise.reject(new Error('CACHE-ERR'))
      : Promise.resolve(globalThis.__f1LiveCacheState.raceStatus),
    getAllPositions: () => globalThis.__f1LiveCacheState.throwError
      ? Promise.reject(new Error('CACHE-ERR'))
      : Promise.resolve(globalThis.__f1LiveCacheState.positions),
    getDriverPosition: () => globalThis.__f1LiveCacheState.throwError
      ? Promise.reject(new Error('CACHE-ERR'))
      : Promise.resolve(globalThis.__f1LiveCacheState.driverPosition),
  }),
}));

globalThis.__f1CircuitState = {
  svg: '<svg>circuit</svg>',
  ids: ['monaco', 'silverstone'],
  circuits: { monaco: { name: 'Monaco', country: 'MC', laps: 78 } },
  overlaySvg: '<svg>overlay</svg>',
};

jest.mock('../sports/f1_dashboard/circuit_maps', () => ({
  generateCircuitSVG: (id) => globalThis.__f1CircuitState.svg,
  getCircuitIds: () => globalThis.__f1CircuitState.ids,
  getCircuit: (id) => globalThis.__f1CircuitState.circuits[id] || globalThis.__f1CircuitState.circuits.monaco,
}));

jest.mock('../sports/f1_dashboard/circuit_overlay', () => ({
  renderAllDriversOnCircuit: () => globalThis.__f1CircuitState.overlaySvg,
}));

globalThis.__f1FantasyState = {
  hasAddon: true,
  leaderboard: [{ uid: 'u1', points: 100 }],
};

jest.mock('../sports/f1_dashboard/f1_fantasy', () => ({
  calculateFantasyPoints: jest.fn(),
  getFantasyLeaderboard: () => globalThis.__f1FantasyState.throwError
    ? Promise.reject(new Error('LB-ERR'))
    : Promise.resolve(globalThis.__f1FantasyState.leaderboard),
  updateOwnerFantasyScore: jest.fn(),
}));

jest.mock('../sports/f1_dashboard/f1_paywall', () => ({
  hasF1Addon: () => Promise.resolve(globalThis.__f1FantasyState.hasAddon),
  requireF1Addon: () => (req, res, next) => next(),
}));

globalThis.__f1TelState = {
  session: { session_key: 999, session_type: 'Race', session_name: 'Race' },
  isLive: true,
  intervals: { gap_to_leader: '+5s', interval: '+1s' },
  laps: [{ lap_number: 1, lap_duration: 90, sector_1_duration: 30, sector_2_duration: 30, sector_3_duration: 30 }],
  stint: { compound: 'SOFT', tyre_age_at_start: 0, stint_number: 1 },
  pits: [],
  location: { x: 100, y: 200, z: 0 },
  telemetry: { rpm: 12000, speed: 300, gear: 7, throttle: 100, brake: 0, drs: 1 },
  allLocations: [{ driver_number: 1, x: 100, y: 200 }],
  fastestLap: { lap_number: 1, lap_duration: 88 },
  snapshot: { intervals: {}, laps: [], stint: {} },
};

jest.mock('../sports/f1_dashboard/f1_telemetry', () => ({
  getCurrentSession: () => globalThis.__f1TelState.throwError
    ? Promise.reject(new Error('TEL-ERR'))
    : Promise.resolve(globalThis.__f1TelState.session),
  isSessionLive: () => globalThis.__f1TelState.isLive,
  getDriverIntervals: () => globalThis.__f1TelState.intervalsError
    ? Promise.reject(new Error('INT-ERR'))
    : Promise.resolve(globalThis.__f1TelState.intervals),
  getDriverLapData: () => globalThis.__f1TelState.lapsError
    ? Promise.reject(new Error('LAPS-ERR'))
    : Promise.resolve(globalThis.__f1TelState.laps),
  getCurrentStint: () => globalThis.__f1TelState.stintError
    ? Promise.reject(new Error('STINT-ERR'))
    : Promise.resolve(globalThis.__f1TelState.stint),
  getDriverPits: () => globalThis.__f1TelState.pitsError
    ? Promise.reject(new Error('PITS-ERR'))
    : Promise.resolve(globalThis.__f1TelState.pits),
  getDriverLocation: () => globalThis.__f1TelState.dLocError
    ? Promise.reject(new Error('DLOC-ERR'))
    : Promise.resolve(globalThis.__f1TelState.location),
  getDriverTelemetry: () => globalThis.__f1TelState.telError
    ? Promise.reject(new Error('TEL-D-ERR'))
    : Promise.resolve(globalThis.__f1TelState.telemetry),
  getAllDriversLocation: () => globalThis.__f1TelState.locError
    ? Promise.reject(new Error('LOC-ERR'))
    : Promise.resolve(globalThis.__f1TelState.allLocations),
  getFastestLap: () => globalThis.__f1TelState.fastestLap,
  buildDriverSnapshot: (parts) => globalThis.__f1TelState.snapshot,
}));

const express = require('express');
const request = require('supertest');
const createF1Routes = require('../routes/f1');

function makeApp(uidOverride) {
  const app = express();
  app.use(express.json());
  const verifyToken = (req, res, next) => {
    req.user = { uid: uidOverride || 'test_uid' };
    next();
  };
  app.use('/api/f1', createF1Routes({ verifyToken }));
  return app;
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  globalThis.__f1FirestoreState.docExists = true;
  globalThis.__f1FirestoreState.docData = {};
  globalThis.__f1FirestoreState.collectionDocs = [];
  globalThis.__f1FirestoreState.setCalls = [];
  globalThis.__f1FirestoreState.throwError = false;
  globalThis.__f1LiveCacheState.throwError = false;
  globalThis.__f1FantasyState.throwError = false;
  globalThis.__f1TelState.throwError = false;
  globalThis.__f1TelState.lapsError = false;
  globalThis.__f1TelState.telError = false;
  globalThis.__f1TelState.locError = false;
  globalThis.__f1TelState.intervalsError = false;
  globalThis.__f1TelState.stintError = false;
  globalThis.__f1TelState.pitsError = false;
  globalThis.__f1TelState.dLocError = false;
});

afterEach(() => {
  if (console.error.mockRestore) console.error.mockRestore();
  if (console.log.mockRestore) console.log.mockRestore();
});

// ───── GET /calendar/:season ─────
describe('GET /api/f1/calendar/:season', () => {
  test('200 con gps', async () => {
    globalThis.__f1FirestoreState.collectionDocs = [
      { id: 'monaco', data: { name: 'Monaco GP', round: 1 } },
      { id: 'silverstone', data: { name: 'British GP', round: 2 } },
    ];
    const app = makeApp();
    const r = await request(app).get('/api/f1/calendar/2025');
    expect(r.status).toBe(200);
    expect(r.body.season).toBe('2025');
    expect(r.body.total).toBe(2);
  });
});

// ───── GET /results/:season/:gp_id ─────
describe('GET /api/f1/results/:season/:gp_id', () => {
  test('200 con doc existente', async () => {
    globalThis.__f1FirestoreState.docData = { winner: 'Norris' };
    const app = makeApp();
    const r = await request(app).get('/api/f1/results/2025/monaco');
    expect(r.status).toBe(200);
    expect(r.body.winner).toBe('Norris');
  });

  test('404 doc no existe', async () => {
    globalThis.__f1FirestoreState.docExists = false;
    const app = makeApp();
    const r = await request(app).get('/api/f1/results/2025/none');
    expect(r.status).toBe(404);
  });
});

// ───── GET /standings ─────
describe('GET /api/f1/standings/drivers + /constructors', () => {
  test('drivers 200', async () => {
    globalThis.__f1FirestoreState.collectionDocs = [
      { id: 'd1', data: { name: 'Norris', team: 'McLaren', points: 200 } },
    ];
    const app = makeApp();
    const r = await request(app).get('/api/f1/standings/drivers/2025');
    expect(r.status).toBe(200);
    expect(r.body.drivers.length).toBe(1);
  });

  test('constructors agrupa por team', async () => {
    globalThis.__f1FirestoreState.collectionDocs = [
      { id: 'd1', data: { team: 'McLaren', team_color: '#f80', points: 200 } },
      { id: 'd2', data: { team: 'McLaren', team_color: '#f80', points: 180 } },
      { id: 'd3', data: { team: 'Ferrari', points: 100 } },
    ];
    const app = makeApp();
    const r = await request(app).get('/api/f1/standings/constructors/2025');
    expect(r.status).toBe(200);
    expect(r.body.constructors.length).toBe(2);
    expect(r.body.constructors[0].team).toBe('McLaren');
    expect(r.body.constructors[0].points).toBe(380);
  });

  test('constructors con driver points=0 falsy → fallback || 0', async () => {
    globalThis.__f1FirestoreState.collectionDocs = [
      { id: 'd1', data: { team: 'X', team_color: '#000', points: 0 } },
    ];
    const app = makeApp();
    const r = await request(app).get('/api/f1/standings/constructors/2025');
    expect(r.status).toBe(200);
    expect(r.body.constructors[0].points).toBe(0);
  });
});

// ───── GET /driver/:season/:driver_id ─────
describe('GET /api/f1/driver/:season/:driver_id', () => {
  test('200', async () => {
    globalThis.__f1FirestoreState.docData = { name: 'Norris', team: 'McLaren' };
    const app = makeApp();
    const r = await request(app).get('/api/f1/driver/2025/norris');
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Norris');
  });

  test('404 no existe', async () => {
    globalThis.__f1FirestoreState.docExists = false;
    const app = makeApp();
    const r = await request(app).get('/api/f1/driver/2025/x');
    expect(r.status).toBe(404);
  });
});

// ───── POST /adopt ─────
describe('POST /api/f1/adopt', () => {
  test('200 driver existe + valida', async () => {
    globalThis.__f1FirestoreState.docData = { name: 'Norris', team: 'McLaren' };
    const app = makeApp();
    const r = await request(app).post('/api/f1/adopt').send({ driver_id: 'norris' });
    expect(r.status).toBe(200);
    expect(r.body.adopted).toBe('norris');
    expect(globalThis.__f1FirestoreState.setCalls.length).toBeGreaterThan(0);
  });

  test('400 sin driver_id', async () => {
    const app = makeApp();
    const r = await request(app).post('/api/f1/adopt').send({});
    expect(r.status).toBe(400);
  });

  test('404 driver no existe', async () => {
    globalThis.__f1FirestoreState.docExists = false;
    const app = makeApp();
    const r = await request(app).post('/api/f1/adopt').send({ driver_id: 'x' });
    expect(r.status).toBe(404);
  });

  test('401 sin uid', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/f1', createF1Routes({ verifyToken: (req, res, next) => next() }));
    const r = await request(app).post('/api/f1/adopt').send({ driver_id: 'norris' });
    expect(r.status).toBe(401);
  });

  test('400 validation falla', async () => {
    const schema = require('../sports/f1_dashboard/f1_schema');
    schema.validateF1Prefs.mockReturnValueOnce({ valid: false, error: 'invalid' });
    globalThis.__f1FirestoreState.docData = { name: 'X' };
    const app = makeApp();
    const r = await request(app).post('/api/f1/adopt').send({ driver_id: 'x' });
    expect(r.status).toBe(400);
  });
});

// ───── GET / PATCH /prefs ─────
describe('GET + PATCH /api/f1/prefs', () => {
  test('GET con doc', async () => {
    globalThis.__f1FirestoreState.docData = { adopted_driver: 'norris', notifications: true };
    const app = makeApp();
    const r = await request(app).get('/api/f1/prefs');
    expect(r.status).toBe(200);
    expect(r.body.adopted_driver).toBe('norris');
  });

  test('GET sin doc → defaults', async () => {
    globalThis.__f1FirestoreState.docExists = false;
    const app = makeApp();
    const r = await request(app).get('/api/f1/prefs');
    expect(r.status).toBe(200);
    expect(r.body.adopted_driver).toBeNull();
    expect(r.body.notifications).toBe(false);
  });

  test('GET sin uid → 401', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/f1', createF1Routes({ verifyToken: (req, res, next) => next() }));
    const r = await request(app).get('/api/f1/prefs');
    expect(r.status).toBe(401);
  });

  test('PATCH actualiza prefs', async () => {
    const app = makeApp();
    const r = await request(app).patch('/api/f1/prefs').send({ notifications: true });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.updated.notifications).toBe(true);
  });

  test('PATCH sin uid → 401', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/f1', createF1Routes({ verifyToken: (req, res, next) => next() }));
    const r = await request(app).patch('/api/f1/prefs').send({});
    expect(r.status).toBe(401);
  });
});

// ───── GET /live/* (cache) ─────
describe('GET /api/f1/live/* (cache)', () => {
  test('/live/status', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/status');
    expect(r.status).toBe(200);
    expect(r.body.isLive).toBe(true);
  });

  test('/live/positions', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/positions');
    expect(r.status).toBe(200);
    expect(r.body.positions.length).toBeGreaterThanOrEqual(0);
  });

  test('/live/driver/:n 200', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4');
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Norris');
  });

  test('/live/driver/:n 404 si no en cache', async () => {
    globalThis.__f1LiveCacheState.driverPosition = null;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/99');
    expect(r.status).toBe(404);
    globalThis.__f1LiveCacheState.driverPosition = { name: 'Norris', position: 1 };
  });
});

// ───── GET /circuit ─────
describe('GET /api/f1/circuit*', () => {
  test('/circuit/:id 200 svg', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/f1/circuit/monaco');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('svg');
  });

  test('/circuit/:id 404', async () => {
    globalThis.__f1CircuitState.svg = null;
    const app = makeApp();
    const r = await request(app).get('/api/f1/circuit/none');
    expect(r.status).toBe(404);
    globalThis.__f1CircuitState.svg = '<svg>circuit</svg>';
  });

  test('/circuits lista', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/f1/circuits');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(globalThis.__f1CircuitState.ids.length);
  });

  test('/circuit/:id/live overlay con prefs', async () => {
    globalThis.__f1FirestoreState.docData = { adopted_driver: 'norris' };
    const app = makeApp();
    const r = await request(app).get('/api/f1/circuit/monaco/live');
    expect(r.status).toBe(200);
  });

  test('/circuit/:id/live overlay sin prefs (doc no existe)', async () => {
    globalThis.__f1FirestoreState.docExists = false;
    const app = makeApp();
    const r = await request(app).get('/api/f1/circuit/monaco/live');
    expect(r.status).toBe(200);
  });

  test('/circuit/:id/live 404 svg null', async () => {
    globalThis.__f1CircuitState.overlaySvg = null;
    const app = makeApp();
    const r = await request(app).get('/api/f1/circuit/none/live');
    expect(r.status).toBe(404);
    globalThis.__f1CircuitState.overlaySvg = '<svg>overlay</svg>';
  });

  test('/circuit/:id/live SIN uid (auth fallback) → no busca prefs', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/f1', createF1Routes({ verifyToken: (req, res, next) => next() }));
    const r = await request(app).get('/api/f1/circuit/monaco/live');
    expect(r.status).toBe(200);
  });

  test('/circuit/:id/live positions con driverName/teamColor/x/y falsy → fallbacks', async () => {
    globalThis.__f1LiveCacheState.positions = [{ number: 4 }]; // sin driverName, teamColor, x, y
    const app = makeApp();
    const r = await request(app).get('/api/f1/circuit/monaco/live');
    expect(r.status).toBe(200);
    globalThis.__f1LiveCacheState.positions = [{ driver_number: 1, position: 1 }];
  });

  test('/circuit/:id/live positions con TODOS los campos truthy → branches truthy', async () => {
    globalThis.__f1LiveCacheState.positions = [{
      number: 4, driverName: 'Norris', teamColor: '#FF8000', x: 100, y: 200, driverId: 'norris',
    }];
    const app = makeApp();
    const r = await request(app).get('/api/f1/circuit/monaco/live');
    expect(r.status).toBe(200);
    globalThis.__f1LiveCacheState.positions = [{ driver_number: 1, position: 1 }];
  });

  test('/circuit/:id/live positions=null → fallback (positions || [])', async () => {
    globalThis.__f1LiveCacheState.positions = null;
    const app = makeApp();
    const r = await request(app).get('/api/f1/circuit/monaco/live');
    expect(r.status).toBe(200);
    globalThis.__f1LiveCacheState.positions = [{ driver_number: 1, position: 1 }];
  });
});

// ───── /addon /fantasy ─────
describe('GET /addon/status + /fantasy/leaderboard + /fantasy/me', () => {
  test('/addon/status active', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/f1/addon/status');
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(true);
  });

  test('/fantasy/leaderboard', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/f1/fantasy/leaderboard');
    expect(r.status).toBe(200);
    expect(r.body.total).toBeGreaterThanOrEqual(1);
  });

  test('/fantasy/me con doc', async () => {
    globalThis.__f1FirestoreState.docData = { fantasy_total: 250 };
    const app = makeApp();
    const r = await request(app).get('/api/f1/fantasy/me');
    expect(r.status).toBe(200);
    expect(r.body.fantasy_total).toBe(250);
  });

  test('/fantasy/me sin doc', async () => {
    globalThis.__f1FirestoreState.docExists = false;
    const app = makeApp();
    const r = await request(app).get('/api/f1/fantasy/me');
    expect(r.status).toBe(200);
    expect(r.body.fantasy_total).toBe(0);
  });

  test('/fantasy/me con doc pero fantasy_total ausente → fallback || 0', async () => {
    globalThis.__f1FirestoreState.docData = {}; // doc exists pero sin fantasy_total
    const app = makeApp();
    const r = await request(app).get('/api/f1/fantasy/me');
    expect(r.status).toBe(200);
    expect(r.body.fantasy_total).toBe(0);
  });
});

// ───── GET /live/session ─────
describe('GET /api/f1/live/session — telemetria OpenF1', () => {
  test('200 con session activa', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/session');
    expect(r.status).toBe(200);
    expect(r.body.session.session_key).toBe(999);
    expect(r.body.is_live).toBe(true);
  });

  test('200 con session=null', async () => {
    globalThis.__f1TelState.session = null;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/session');
    expect(r.status).toBe(200);
    expect(r.body.session).toBeNull();
    expect(r.body.is_live).toBe(false);
    globalThis.__f1TelState.session = { session_key: 999, session_type: 'Race' };
  });
});

// ───── GET /live/driver/:n/snapshot ─────
describe('GET /api/f1/live/driver/:n/snapshot', () => {
  test('200 snapshot completo', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4/snapshot');
    expect(r.status).toBe(200);
    expect(r.body.driver_number).toBe(4);
    expect(r.body.session.session_key).toBe(999);
  });

  test('400 driver_number invalido', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/abc/snapshot');
    expect(r.status).toBe(400);
  });

  test('200 sin sesion → snapshot null', async () => {
    globalThis.__f1TelState.session = null;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4/snapshot');
    expect(r.status).toBe(200);
    expect(r.body.snapshot).toBeNull();
    globalThis.__f1TelState.session = { session_key: 999, session_type: 'Race' };
  });
});

// ───── GET /live/locations ─────
describe('GET /api/f1/live/locations', () => {
  test('200 con locations', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/locations');
    expect(r.status).toBe(200);
    expect(r.body.locations.length).toBeGreaterThanOrEqual(1);
  });

  test('200 sin sesion', async () => {
    globalThis.__f1TelState.session = null;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/locations');
    expect(r.status).toBe(200);
    expect(r.body.locations).toEqual([]);
    globalThis.__f1TelState.session = { session_key: 999, session_type: 'Race' };
  });
});

// ───── GET /live/driver/:n/telemetry ─────
describe('GET /api/f1/live/driver/:n/telemetry', () => {
  test('200 con telemetria', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4/telemetry');
    expect(r.status).toBe(200);
    expect(r.body.telemetry.rpm).toBe(12000);
  });

  test('400 driver_number invalido', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/xyz/telemetry');
    expect(r.status).toBe(400);
  });

  test('200 sin sesion', async () => {
    globalThis.__f1TelState.session = null;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4/telemetry');
    expect(r.status).toBe(200);
    expect(r.body.telemetry).toBeNull();
    globalThis.__f1TelState.session = { session_key: 999, session_type: 'Race' };
  });
});

// ───── Error paths 500 (cobertura catch blocks) ─────
describe('500 error paths — cobertura catch blocks', () => {
  test('GET /calendar 500 si firestore falla', async () => {
    globalThis.__f1FirestoreState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/calendar/2025');
    expect(r.status).toBe(500);
  });

  test('GET /results 500', async () => {
    globalThis.__f1FirestoreState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/results/2025/x');
    expect(r.status).toBe(500);
  });

  test('GET /standings/drivers 500', async () => {
    globalThis.__f1FirestoreState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/standings/drivers/2025');
    expect(r.status).toBe(500);
  });

  test('GET /standings/constructors 500', async () => {
    globalThis.__f1FirestoreState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/standings/constructors/2025');
    expect(r.status).toBe(500);
  });

  test('GET /driver 500', async () => {
    globalThis.__f1FirestoreState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/driver/2025/x');
    expect(r.status).toBe(500);
  });

  test('POST /adopt 500', async () => {
    globalThis.__f1FirestoreState.throwError = true;
    const app = makeApp();
    const r = await request(app).post('/api/f1/adopt').send({ driver_id: 'x' });
    expect(r.status).toBe(500);
  });

  test('GET /prefs 500', async () => {
    globalThis.__f1FirestoreState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/prefs');
    expect(r.status).toBe(500);
  });

  test('PATCH /prefs 500', async () => {
    globalThis.__f1FirestoreState.throwError = true;
    const app = makeApp();
    const r = await request(app).patch('/api/f1/prefs').send({ notifications: true });
    expect(r.status).toBe(500);
  });

  test('GET /live/status 500', async () => {
    globalThis.__f1LiveCacheState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/status');
    expect(r.status).toBe(500);
  });

  test('GET /live/positions 500', async () => {
    globalThis.__f1LiveCacheState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/positions');
    expect(r.status).toBe(500);
  });

  test('GET /live/driver/:n 500', async () => {
    globalThis.__f1LiveCacheState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4');
    expect(r.status).toBe(500);
  });

  test('GET /circuit/:id/live 500', async () => {
    globalThis.__f1LiveCacheState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/circuit/monaco/live');
    expect(r.status).toBe(500);
  });

  test('GET /fantasy/leaderboard 500', async () => {
    globalThis.__f1FantasyState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/fantasy/leaderboard');
    expect(r.status).toBe(500);
  });

  test('GET /fantasy/me 500', async () => {
    globalThis.__f1FirestoreState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/fantasy/me');
    expect(r.status).toBe(500);
  });

  test('GET /live/session 500', async () => {
    globalThis.__f1TelState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/session');
    expect(r.status).toBe(500);
  });

  test('GET /live/driver/:n/snapshot 500', async () => {
    globalThis.__f1TelState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4/snapshot');
    expect(r.status).toBe(500);
  });

  test('GET /live/locations 500', async () => {
    globalThis.__f1TelState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/locations');
    expect(r.status).toBe(500);
  });

  test('GET /live/driver/:n/telemetry 500', async () => {
    globalThis.__f1TelState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4/telemetry');
    expect(r.status).toBe(500);
  });

  test('GET /live/driver/:n/laps 500', async () => {
    globalThis.__f1TelState.throwError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4/laps');
    expect(r.status).toBe(500);
  });
});

// ───── auth fallback (sin verifyToken) ─────
describe('auth fallback (sin verifyToken pasado)', () => {
  test('createF1Routes sin verifyToken usa fallback que pasa next', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/f1', createF1Routes({})); // sin verifyToken → linea 15 fallback
    const r = await request(app).get('/api/f1/calendar/2025');
    expect(r.status).toBe(200);
  });
});

// ───── Snapshot promise.all catch paths ─────
describe('snapshot Promise.all catch paths', () => {
  test('snapshot con telError en getDriverTelemetry → catch retorna null', async () => {
    globalThis.__f1TelState.telError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4/snapshot');
    expect(r.status).toBe(200);
  });

  test('snapshot con lapsError en getDriverLapData → catch retorna []', async () => {
    globalThis.__f1TelState.lapsError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4/snapshot');
    expect(r.status).toBe(200);
  });

  test('snapshot con intervalsError → catch retorna null', async () => {
    globalThis.__f1TelState.intervalsError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4/snapshot');
    expect(r.status).toBe(200);
  });

  test('snapshot con stintError → catch retorna null', async () => {
    globalThis.__f1TelState.stintError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4/snapshot');
    expect(r.status).toBe(200);
  });

  test('snapshot con pitsError → catch retorna []', async () => {
    globalThis.__f1TelState.pitsError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4/snapshot');
    expect(r.status).toBe(200);
  });

  test('snapshot con dLocError (getDriverLocation) → catch retorna null', async () => {
    globalThis.__f1TelState.dLocError = true;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4/snapshot');
    expect(r.status).toBe(200);
  });
});

// ───── addon status sin error ─────
describe('addon status hasF1Addon catch', () => {
  test('hasF1Addon throws → catch retorna false', async () => {
    const paywall = require('../sports/f1_dashboard/f1_paywall');
    paywall.hasF1Addon = () => Promise.reject(new Error('PW-ERR'));
    const app = makeApp();
    const r = await request(app).get('/api/f1/addon/status');
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(false);
    paywall.hasF1Addon = () => Promise.resolve(globalThis.__f1FantasyState.hasAddon);
  });
});

// ───── GET /live/driver/:n/laps ─────
describe('GET /api/f1/live/driver/:n/laps', () => {
  test('200 laps + fastest', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4/laps');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.laps)).toBe(true);
    expect(r.body.fastest_lap).toBeTruthy();
  });

  test('400 driver_number invalido', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/abc/laps');
    expect(r.status).toBe(400);
  });

  test('200 sin sesion', async () => {
    globalThis.__f1TelState.session = null;
    const app = makeApp();
    const r = await request(app).get('/api/f1/live/driver/4/laps');
    expect(r.status).toBe(200);
    expect(r.body.laps).toEqual([]);
    expect(r.body.fastest_lap).toBeNull();
    globalThis.__f1TelState.session = { session_key: 999, session_type: 'Race' };
  });
});
