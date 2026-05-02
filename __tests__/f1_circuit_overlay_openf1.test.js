'use strict';
/**
 * Tests for circuit_overlay.js -- MiiaF1.41 real OpenF1 GPS coords
 * calcLocationBounds / openF1ToSVG / renderDriversFromOpenF1
 */

const {
  calcLocationBounds,
  openF1ToSVG,
  renderDriversFromOpenF1,
} = require('../sports/f1_dashboard/circuit_overlay');

// -- calcLocationBounds --

describe('calcLocationBounds()', () => {
  test('null locationData -> default bounds', () => {
    const b = calcLocationBounds(null);
    expect(b.xMin).toBe(-1000);
    expect(b.xMax).toBe(1000);
    expect(b.yMin).toBe(-1000);
    expect(b.yMax).toBe(1000);
  });

  test('empty array -> default bounds', () => {
    const b = calcLocationBounds([]);
    expect(b.xMin).toBe(-1000);
    expect(b.xMax).toBe(1000);
  });

  test('single point -> min===max for that coord', () => {
    const b = calcLocationBounds([{ x: 500, y: -300 }]);
    expect(b.xMin).toBe(500);
    expect(b.xMax).toBe(500);
    expect(b.yMin).toBe(-300);
    expect(b.yMax).toBe(-300);
  });

  test('multiple points -> correct min/max', () => {
    const data = [
      { x: 100, y: -500 },
      { x: 800, y: -200 },
      { x: -50, y: -700 },
    ];
    const b = calcLocationBounds(data);
    expect(b.xMin).toBe(-50);
    expect(b.xMax).toBe(800);
    expect(b.yMin).toBe(-700);
    expect(b.yMax).toBe(-200);
  });
});

// -- openF1ToSVG --

describe('openF1ToSVG()', () => {
  test('zero xRange y yRange -> usa 1 como denominador (no div/0)', () => {
    const bounds = { xMin: 500, xMax: 500, yMin: -300, yMax: -300 };
    const pos = openF1ToSVG(500, -300, bounds);
    // (500-500)/1 * 380 + 10 = 10; (-300-(-300))/1 * 280 + 10 = 10
    expect(pos.x).toBe(10);
    expect(pos.y).toBe(10);
  });

  test('coordenadas en extremo min -> x=10, y=10', () => {
    const bounds = { xMin: 0, xMax: 1000, yMin: 0, yMax: 1000 };
    const pos = openF1ToSVG(0, 0, bounds);
    expect(pos.x).toBe(10);
    expect(pos.y).toBe(10);
  });

  test('coordenadas en extremo max -> x=390, y=290', () => {
    const bounds = { xMin: 0, xMax: 1000, yMin: 0, yMax: 1000 };
    const pos = openF1ToSVG(1000, 1000, bounds);
    expect(pos.x).toBe(390);
    expect(pos.y).toBe(290);
  });

  test('coordenadas en el medio -> valores intermedios', () => {
    const bounds = { xMin: 0, xMax: 1000, yMin: 0, yMax: 1000 };
    const pos = openF1ToSVG(500, 500, bounds);
    // (500/1000)*380+10 = 200; (500/1000)*280+10 = 150
    expect(pos.x).toBe(200);
    expect(pos.y).toBe(150);
  });
});

// -- renderDriversFromOpenF1 --

describe('renderDriversFromOpenF1()', () => {
  test('circuitId invalido -> null', () => {
    const result = renderDriversFromOpenF1('nonexistent_circuit', [], null);
    expect(result).toBeNull();
  });

  test('null locationData -> SVG con overlays vacios (sin pilotos)', () => {
    const svg = renderDriversFromOpenF1('australia', null, null);
    expect(svg).not.toBeNull();
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('<circle');
  });

  test('locationData vacia -> SVG sin circles', () => {
    const svg = renderDriversFromOpenF1('australia', [], null);
    expect(svg).not.toBeNull();
    expect(svg).not.toContain('<circle');
  });

  test('piloto sin adoptado -> circles sin golden ring', () => {
    const data = [{ driver_number: 1, x: 500, y: -300, team_colour: '#FF0000' }];
    const svg = renderDriversFromOpenF1('australia', data, null);
    expect(svg).toContain('<circle');
    expect(svg).not.toContain('stroke="#FFD700"');
    expect(svg).not.toContain('font-weight="700"');
  });

  test('piloto adoptado -> golden ring + acronimo', () => {
    const data = [
      { driver_number: 1, x: 500, y: -300, team_colour: '#FF0000', driver_acronym: 'VER' },
    ];
    const svg = renderDriversFromOpenF1('australia', data, 1);
    expect(svg).toContain('stroke="#FFD700"');
    expect(svg).toContain('VER');
    expect(svg).toContain('r="10"');
  });

  test('sin driver_acronym usa driver_number como label', () => {
    const data = [{ driver_number: 44, x: 500, y: -300, team_colour: '#00D2BE' }];
    const svg = renderDriversFromOpenF1('australia', data, 44);
    expect(svg).toContain('44');
  });

  test('driver repetido (misma sesion) -> renderiza solo el primero', () => {
    const data = [
      { driver_number: 1, x: 500, y: -300 },
      { driver_number: 1, x: 600, y: -400 },
    ];
    const svg = renderDriversFromOpenF1('australia', data, null);
    // Solo debe haber 1 circle
    const matches = svg.match(/<circle /g) || [];
    expect(matches.length).toBe(1);
  });

  test('team_color fallback cuando no hay team_colour', () => {
    const data = [{ driver_number: 16, x: 500, y: -300, team_color: '#DC0000' }];
    const svg = renderDriversFromOpenF1('australia', data, null);
    expect(svg).toContain('#DC0000');
  });

  test('sin team_colour ni team_color -> usa #888 default', () => {
    const data = [{ driver_number: 16, x: 500, y: -300 }];
    const svg = renderDriversFromOpenF1('australia', data, null);
    expect(svg).toContain('#888');
  });

  test('multiples pilotos incluyendo adoptado -> todos renderizan', () => {
    const data = [
      { driver_number: 1, x: 100, y: -100, driver_acronym: 'VER' },
      { driver_number: 11, x: 200, y: -200 },
      { driver_number: 44, x: 300, y: -300 },
    ];
    const svg = renderDriversFromOpenF1('australia', data, 1);
    const circles = svg.match(/<circle /g) || [];
    // 3 drivers + 1 golden ring = 4 circles
    expect(circles.length).toBe(4);
    expect(svg).toContain('VER');
    expect(svg).toContain('stroke="#FFD700"');
  });

  test('SVG contiene path del circuito y color de fondo', () => {
    const svg = renderDriversFromOpenF1('bahrain', [], null);
    expect(svg).toContain('<rect width="400" height="300" fill="#0A0A12"/>');
    expect(svg).toContain('<path d=');
  });
});

// -- renderDriverOnCircuit / renderAllDriversOnCircuit -- branch coverage --

const { renderDriverOnCircuit, renderAllDriversOnCircuit } = require('../sports/f1_dashboard/circuit_overlay');

describe('renderDriverOnCircuit() -- branch || fallbacks (L32,L36)', () => {
  test('driverData sin x/y -> usa 0.5 como fallback', () => {
    const svg = renderDriverOnCircuit('australia', { name: 'Piloto', team_color: '#fff' });
    expect(svg).not.toBeNull();
  });

  test('driverData sin team_color -> usa #00E5FF fallback', () => {
    const svg = renderDriverOnCircuit('australia', { name: 'Piloto', x: 0.5, y: 0.5 });
    expect(svg).not.toBeNull();
  });
});

describe('renderAllDriversOnCircuit() -- branch || fallbacks (L56,L59)', () => {
  test('driver sin x/y -> usa 0.5 fallback', () => {
    const svg = renderAllDriversOnCircuit('australia', [{ driver_id: 'x', name: 'A' }], null);
    expect(svg).toContain('<circle');
  });

  test('driver sin team_color -> usa #888 fallback', () => {
    const svg = renderAllDriversOnCircuit('australia', [{ driver_id: 'x', name: 'A', x: 0.5, y: 0.5 }], null);
    expect(svg).toContain('#888');
  });

  test('driver highlightado en renderAllDrivers', () => {
    const svg = renderAllDriversOnCircuit('australia', [{ driver_id: 'd1', name: 'Max', x: 0.5, y: 0.5, team_color: '#FF0000' }], 'd1');
    expect(svg).toContain('font-weight="700"');
  });
});

describe('renderDriverOnCircuit() -- null driverData y invalid circuit', () => {
  test('null driverData -> generateCircuitSVG sin overlay (L31)', () => {
    const svg = renderDriverOnCircuit('australia', null);
    expect(svg).not.toBeNull();
    expect(svg).not.toContain('<circle');
  });
});

describe('renderAllDriversOnCircuit() -- invalid circuit y null driversData (L50-53)', () => {
  test('circuitId invalido -> null (L50)', () => {
    const r = renderAllDriversOnCircuit('no_existe', [], null);
    expect(r).toBeNull();
  });

  test('driversData null -> usa [] fallback (L53)', () => {
    const svg = renderAllDriversOnCircuit('australia', null, null);
    expect(svg).not.toBeNull();
    expect(svg).not.toContain('<circle');
  });
});
