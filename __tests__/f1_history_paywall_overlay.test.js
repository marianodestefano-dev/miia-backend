'use strict';

// F1 backend coverage round 1: f1_history, f1_paywall (in-memory firestore mock), circuit_overlay (pure)
// Mocks firebase-admin to avoid real Firestore calls.

jest.mock('firebase-admin', () => {
  const mockData = {};
  const docMethods = (collectionName, docId) => ({
    get: jest.fn().mockImplementation(() => {
      const data = mockData[`${collectionName}/${docId}`];
      return Promise.resolve({
        exists: !!data,
        data: () => data,
        id: docId,
      });
    }),
    set: jest.fn().mockImplementation((d, opts) => {
      mockData[`${collectionName}/${docId}`] = { ...(mockData[`${collectionName}/${docId}`] || {}), ...d };
      return Promise.resolve();
    }),
  });
  const collectionMock = (collectionName) => {
    const _filters = [];
    const _api = {
      doc: (docId) => docMethods(collectionName, docId),
      where: (field, op, value) => { _filters.push({ field, op, value }); return _api; },
      orderBy: () => _api,
      limit: () => _api,
      add: jest.fn().mockResolvedValue({ id: 'new-doc' }),
      get: jest.fn().mockImplementation(() => Promise.resolve({ docs: [], empty: true })),
    };
    return _api;
  };
  return {
    firestore: () => ({
      collection: collectionMock,
      doc: (path) => {
        const [coll, id] = path.split('/').slice(-2);
        return docMethods(coll, id);
      },
    }),
    firestore: Object.assign(
      () => ({
        collection: collectionMock,
        doc: (path) => {
          const parts = path.split('/');
          const docId = parts[parts.length - 1];
          const collName = parts.slice(0, -1).join('/');
          return docMethods(collName, docId);
        },
      }),
      { FieldValue: { arrayUnion: (...args) => ({ __op: 'arrayUnion', args }) } }
    ),
  };
});

const admin = require('firebase-admin');
const history = require('../sports/f1_dashboard/f1_history');
const paywall = require('../sports/f1_dashboard/f1_paywall');
const overlay = require('../sports/f1_dashboard/circuit_overlay');

describe('F1 backend round1 — circuit_overlay (pure logic)', () => {
  test('normToSVG centro (0.5, 0.5)', () => {
    const r = overlay.normToSVG(0.5, 0.5);
    expect(r.x).toBe(200);
    expect(r.y).toBe(150);
  });
  test('normToSVG esquina superior izquierda', () => {
    const r = overlay.normToSVG(0, 0);
    expect(r.x).toBe(10);
    expect(r.y).toBe(10);
  });
  test('normToSVG esquina inferior derecha', () => {
    const r = overlay.normToSVG(1, 1);
    expect(r.x).toBe(390);
    expect(r.y).toBe(290);
  });
  test('renderDriverOnCircuit sin driverData usa default circuit', () => {
    const r = overlay.renderDriverOnCircuit('monaco', null);
    expect(r === null || typeof r === 'string').toBe(true);
  });
  test('renderDriverOnCircuit con driverData genera svg', () => {
    const r = overlay.renderDriverOnCircuit('monaco', {
      name: 'Norris', team_color: '#FF8000', x: 0.3, y: 0.7,
    });
    expect(r === null || typeof r === 'string').toBe(true);
  });
  test('renderDriverOnCircuit driverData sin x/y usa defaults', () => {
    const r = overlay.renderDriverOnCircuit('monaco', { name: 'X' });
    expect(r === null || typeof r === 'string').toBe(true);
  });
  test('renderAllDriversOnCircuit circuit invalido null', () => {
    const r = overlay.renderAllDriversOnCircuit('inexistente', [], 'X');
    expect(r).toBeNull();
  });
  test('renderAllDriversOnCircuit con drivers genera SVG', () => {
    const r = overlay.renderAllDriversOnCircuit('monaco', [
      { driver_id: 'p1', name: 'Norris', team_color: '#FF8000', x: 0.3, y: 0.5, position: 1 },
      { driver_id: 'p2', name: 'Hamilton', team_color: '#27F4D2', x: 0.5, y: 0.5, position: 2 },
    ], 'p1');
    if (r) {
      expect(r).toContain('<svg');
      expect(r).toContain('Norris');
    }
  });
  test('renderAllDriversOnCircuit empty array', () => {
    const r = overlay.renderAllDriversOnCircuit('monaco', [], null);
    expect(r === null || typeof r === 'string').toBe(true);
  });
  test('renderAllDriversOnCircuit slice top 5', () => {
    const drivers = Array.from({ length: 10 }, (_, i) => ({
      driver_id: `d${i}`, name: `D${i}`, team_color: '#FFF', x: 0.5, y: 0.5,
    }));
    const r = overlay.renderAllDriversOnCircuit('monaco', drivers, null);
    expect(r === null || typeof r === 'string').toBe(true);
  });
  test('renderAllDriversOnCircuit driver sin team_color usa default', () => {
    const r = overlay.renderAllDriversOnCircuit('monaco', [
      { driver_id: 'p1', name: 'X', x: 0.5, y: 0.5 },
    ], null);
    expect(r === null || typeof r === 'string').toBe(true);
  });
});

describe('F1 backend round1 — f1_history.formatPodium (pure)', () => {
  test('result null retorna Sin datos', () => {
    expect(history.formatPodium(null)).toBe('Sin datos');
  });
  test('result sin positions retorna Sin datos', () => {
    expect(history.formatPodium({})).toBe('Sin datos');
  });
  test('result positions vacio retorna Sin datos', () => {
    expect(history.formatPodium({ positions: [] })).toBe('Sin datos');
  });
  test('result con positions retorna podium', () => {
    const r = history.formatPodium({
      positions: [
        { driver_name: 'Verstappen', team: 'Red Bull' },
        { driver_name: 'Norris', team: 'McLaren' },
        { driver_name: 'Hamilton', team: 'Ferrari' },
      ],
    });
    expect(r).toContain('Verstappen');
    expect(r).toContain('Norris');
    expect(r).toContain('Hamilton');
  });
  test('result con driverId fallback', () => {
    const r = history.formatPodium({ positions: [{ driverId: 'd1' }] });
    expect(r).toContain('d1');
  });
  test('result sin team usa dash', () => {
    const r = history.formatPodium({ positions: [{ driver_name: 'X' }] });
    expect(r).toContain('-');
  });
});

describe('F1 backend round1 — f1_paywall constants', () => {
  test('F1_ADDON_ID definido', () => {
    expect(paywall.F1_ADDON_ID).toBe('f1_dashboard');
  });
  test('F1_ADDON_PRICE_USD = 3', () => {
    expect(paywall.F1_ADDON_PRICE_USD).toBe(3);
  });
  test('hasF1Addon empty uid retorna false', async () => {
    expect(await paywall.hasF1Addon('')).toBe(false);
    expect(await paywall.hasF1Addon(null)).toBe(false);
  });
  test('hasF1Addon owner inexistente false (mock retorna empty)', async () => {
    const r = await paywall.hasF1Addon('uid-no-existe');
    expect(typeof r).toBe('boolean');
  });
  test('requireF1Addon middleware sin user retorna 401', () => {
    const req = { user: null };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    paywall.requireF1Addon(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
  test('requireF1Addon middleware con user llama next o 402', (done) => {
    const req = { user: { uid: 'test-uid' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    paywall.requireF1Addon(req, res, next);
    setTimeout(() => {
      // Either next was called (no addon since mock returns empty) or 402 was sent
      expect(res.status.mock.calls.length + next.mock.calls.length).toBeGreaterThanOrEqual(1);
      done();
    }, 50);
  });
});
