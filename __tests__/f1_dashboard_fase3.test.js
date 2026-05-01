'use strict';

const { CIRCUITS, generateCircuitSVG, getCircuitIds, getCircuit } = require('../sports/f1_dashboard/circuit_maps');
const { normToSVG, renderDriverOnCircuit, renderAllDriversOnCircuit } = require('../sports/f1_dashboard/circuit_overlay');

describe('F1.17 -- SVG Circuit Maps', function() {
  describe('CIRCUITS data', function() {
    test('tiene 24 circuitos', function() {
      expect(Object.keys(CIRCUITS).length).toBe(24);
    });

    test('cada circuito tiene campos requeridos', function() {
      for (const [id, c] of Object.entries(CIRCUITS)) {
        expect(c).toHaveProperty('name');
        expect(c).toHaveProperty('country');
        expect(c).toHaveProperty('laps');
        expect(c).toHaveProperty('path');
        expect(c).toHaveProperty('color');
      }
    });

    test('incluye circuitos principales', function() {
      const ids = Object.keys(CIRCUITS);
      expect(ids).toContain('monaco');
      expect(ids).toContain('britain');
      expect(ids).toContain('italy');
      expect(ids).toContain('belgium');
    });

    test('getCircuitIds retorna 24 IDs', function() {
      expect(getCircuitIds().length).toBe(24);
    });

    test('getCircuit retorna datos correctos', function() {
      const m = getCircuit('monaco');
      expect(m).not.toBeNull();
      expect(m.name).toBe('Circuit de Monaco');
      expect(m.laps).toBe(78);
    });

    test('getCircuit retorna null para ID inexistente', function() {
      expect(getCircuit('unknown_circuit')).toBeNull();
    });
  });

  describe('generateCircuitSVG', function() {
    test('genera SVG valido para monaco', function() {
      const svg = generateCircuitSVG('monaco');
      expect(svg).not.toBeNull();
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
      expect(svg).toContain('viewBox');
    });

    test('retorna null para circuito inexistente', function() {
      expect(generateCircuitSVG('unknown')).toBeNull();
    });

    test('incluye overlay del piloto si se pasa driverPos', function() {
      const svg = generateCircuitSVG('monaco', { driverPos: { x: 200, y: 150 }, driverName: 'Norris' });
      expect(svg).toContain('<circle');
      expect(svg).toContain('Norris');
    });

    test('SVG tiene fondo oscuro #0A0A12', function() {
      const svg = generateCircuitSVG('italy');
      expect(svg).toContain('#0A0A12');
    });
  });
});

describe('F1.18 -- Circuit position overlay', function() {
  describe('normToSVG', function() {
    test('(0,0) -> cerca de (10,10)', function() {
      const p = normToSVG(0, 0);
      expect(p.x).toBe(10);
      expect(p.y).toBe(10);
    });

    test('(1,1) -> cerca de (390,290)', function() {
      const p = normToSVG(1, 1);
      expect(p.x).toBe(390);
      expect(p.y).toBe(290);
    });

    test('(0.5,0.5) -> centro', function() {
      const p = normToSVG(0.5, 0.5);
      expect(p.x).toBe(200);
      expect(p.y).toBe(150);
    });
  });

  describe('renderDriverOnCircuit', function() {
    test('genera SVG con circulo del piloto', function() {
      const svg = renderDriverOnCircuit('monaco', { name: 'Norris', team_color: '#FF8000', x: 0.5, y: 0.5 });
      expect(svg).toContain('<circle');
      expect(svg).toContain('Norris');
    });

    test('genera SVG sin overlay si driverData es null', function() {
      const svg = renderDriverOnCircuit('monaco', null);
      expect(svg).toContain('<svg');
      expect(svg).not.toContain('<circle');
    });

    test('retorna null para circuito inexistente', function() {
      const svg = renderDriverOnCircuit('monaco', null);
      expect(svg).not.toBeNull(); // monaco existe
      const svgNull = renderDriverOnCircuit('unknown', null);
      expect(svgNull).toBeNull();
    });
  });

  describe('renderAllDriversOnCircuit', function() {
    test('genera SVG con multiples pilotos', function() {
      const drivers = [
        { name: 'Norris', team_color: '#FF8000', x: 0.3, y: 0.5, driver_id: 'norris' },
        { name: 'Verstappen', team_color: '#3671C6', x: 0.6, y: 0.4, driver_id: 'verstappen' },
      ];
      const svg = renderAllDriversOnCircuit('monaco', drivers, 'norris');
      expect(svg).toContain('<circle');
      expect(svg).toContain('Norris');
    });

    test('retorna null para circuito inexistente', function() {
      const svg = renderAllDriversOnCircuit('unknown', [], null);
      expect(svg).toBeNull();
    });
  });
});
