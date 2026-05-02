'use strict';

jest.mock('firebase-admin', () => ({
  firestore: Object.assign(() => ({
    doc: () => ({ get: jest.fn().mockResolvedValue({ exists: false }), set: jest.fn().mockResolvedValue() }),
    collection: () => ({ get: jest.fn().mockResolvedValue({ docs: [] }) }),
    collectionGroup: () => ({ get: jest.fn().mockResolvedValue({ docs: [] }) }),
  }), {
    FieldValue: {
      arrayUnion: (...args) => ({ __op: 'arrayUnion', args }),
      increment: (n) => ({ __op: 'increment', n }),
    },
  }),
}));

const fantasy = require('../sports/f1_dashboard/f1_fantasy');
const circuits = require('../sports/f1_dashboard/circuit_maps');

describe('F1 R2 — f1_fantasy calculateFantasyPoints', () => {
  test('P1 sin bonus = 25', () => {
    const r = fantasy.calculateFantasyPoints({ position: 1 }, 'Driver');
    expect(r.points).toBe(25);
    expect(r.breakdown.race).toBe(25);
  });
  test('P10 = 1', () => {
    expect(fantasy.calculateFantasyPoints({ position: 10 }, 'D').points).toBe(1);
  });
  test('P11 = 0', () => {
    expect(fantasy.calculateFantasyPoints({ position: 11 }, 'D').points).toBe(0);
  });
  test('DNF = 0 race points', () => {
    const r = fantasy.calculateFantasyPoints({ position: 5, dnf: true }, 'D');
    expect(r.breakdown.race).toBe(0);
    expect(r.points).toBe(0);
  });
  test('fastest_lap matches driver +2', () => {
    const r = fantasy.calculateFantasyPoints({ position: 5, fastest_lap: 'D' }, 'D');
    expect(r.points).toBe(12); // 10 + 2
    expect(r.breakdown.fastest_lap).toBe(2);
  });
  test('fastest_lap diferente driver no aplica', () => {
    const r = fantasy.calculateFantasyPoints({ position: 5, fastest_lap: 'Other' }, 'D');
    expect(r.points).toBe(10);
    expect(r.breakdown.fastest_lap).toBeUndefined();
  });
  test('pole_position matches driver +3', () => {
    const r = fantasy.calculateFantasyPoints({ position: 1, pole_position: 'D' }, 'D');
    expect(r.points).toBe(28); // 25 + 3
    expect(r.breakdown.pole).toBe(3);
  });
  test('pole_position diferente driver no aplica', () => {
    const r = fantasy.calculateFantasyPoints({ position: 1, pole_position: 'Other' }, 'D');
    expect(r.points).toBe(25);
    expect(r.breakdown.pole).toBeUndefined();
  });
  test('overtake bonus: P5+ -> top3 +5', () => {
    const r = fantasy.calculateFantasyPoints({ position: 1, started_pos: 8 }, 'D');
    expect(r.points).toBe(30); // 25 + 5
    expect(r.breakdown.overtake_bonus).toBe(5);
  });
  test('overtake no aplica si started_pos <= 4', () => {
    const r = fantasy.calculateFantasyPoints({ position: 1, started_pos: 4 }, 'D');
    expect(r.points).toBe(25);
    expect(r.breakdown.overtake_bonus).toBeUndefined();
  });
  test('overtake no aplica si terminó P>3', () => {
    const r = fantasy.calculateFantasyPoints({ position: 5, started_pos: 10 }, 'D');
    expect(r.breakdown.overtake_bonus).toBeUndefined();
  });
  test('combo: P1 + fastest_lap + pole + overtake', () => {
    const r = fantasy.calculateFantasyPoints({
      position: 1, started_pos: 8, fastest_lap: 'D', pole_position: 'D',
    }, 'D');
    expect(r.points).toBe(35); // 25 + 2 + 3 + 5
  });
  test('breakdown.total presente', () => {
    const r = fantasy.calculateFantasyPoints({ position: 5 }, 'D');
    expect(r.breakdown.total).toBe(10);
  });
  test('F1_POINTS export', () => {
    expect(fantasy.F1_POINTS[1]).toBe(25);
    expect(fantasy.F1_POINTS[10]).toBe(1);
  });
});

describe('F1 R2 — circuit_maps', () => {
  test('CIRCUITS export tiene monaco', () => {
    expect(circuits.CIRCUITS.monaco).toBeDefined();
    expect(circuits.CIRCUITS.monaco.country).toBeDefined();
  });
  test('getCircuit valido', () => {
    const c = circuits.getCircuit('monaco');
    expect(c).toBeDefined();
    expect(c.name).toBeDefined();
  });
  test('getCircuit inexistente undefined', () => {
    expect(circuits.getCircuit('inexistente')).toBeNull();
  });
  test('getCircuitIds retorna array de ids', () => {
    const ids = circuits.getCircuitIds();
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain('monaco');
  });
  test('generateCircuitSVG valido sin opts', () => {
    const svg = circuits.generateCircuitSVG('monaco');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });
  test('generateCircuitSVG circuit invalido null', () => {
    expect(circuits.generateCircuitSVG('inexistente')).toBeNull();
  });
  test('generateCircuitSVG con driverPos', () => {
    const svg = circuits.generateCircuitSVG('monaco', {
      driverPos: { x: 100, y: 100 }, driverName: 'Norris', teamColor: '#FF8000',
    });
    expect(svg).toContain('<circle');
    expect(svg).toContain('Norris');
    expect(svg).toContain('#FF8000');
  });
  test('generateCircuitSVG con driverPos sin label (showLabel false)', () => {
    const svg = circuits.generateCircuitSVG('monaco', {
      driverPos: { x: 100, y: 100 }, driverName: 'Norris', showLabel: false,
    });
    expect(svg).toContain('<circle');
    expect(svg).not.toContain('>Norris<');
  });
  test('generateCircuitSVG sin driverName no incluye text', () => {
    const svg = circuits.generateCircuitSVG('monaco', { driverPos: { x: 100, y: 100 } });
    expect(svg).toContain('<circle');
  });
  test('generateCircuitSVG default teamColor cuando no provided', () => {
    const svg = circuits.generateCircuitSVG('monaco', { driverPos: { x: 100, y: 100 } });
    expect(svg).toContain('#00E5FF');
  });
});
