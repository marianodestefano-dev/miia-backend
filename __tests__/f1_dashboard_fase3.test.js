'use strict';

const { CIRCUITS, generateCircuitSVG, getCircuitIds, getCircuit } = require('../sports/f1_dashboard/circuit_maps');
const { normToSVG, renderDriverOnCircuit, renderAllDriversOnCircuit } = require('../sports/f1_dashboard/circuit_overlay');

describe('F1.17 -- SVG Circuit Maps (REWRITE 2026-05-12 firma Mariano — trazados REALES)', function() {
  describe('CIRCUITS data', function() {
    test('expone al menos 25 circuitos (calendario 2026 + alias legacy)', function() {
      // Mariano firmó reemplazo SVGs garabateados por trazados REALES open source.
      // CIRCUITS ahora es Proxy lazy con fileIds reales (mc-1929, bh-2002, ...) +
      // aliases legacy ("monaco", "britain", ...). Total > 25 (no exactly 24).
      expect(Object.keys(CIRCUITS).length).toBeGreaterThanOrEqual(25);
    });

    test('cada circuito accesible expone campos requeridos (API nueva REAL)', function() {
      for (const id of Object.keys(CIRCUITS).slice(0, 10)) {
        const c = CIRCUITS[id];
        expect(c).toHaveProperty('id');
        expect(c).toHaveProperty('name');
        expect(c).toHaveProperty('location');
        expect(c).toHaveProperty('country');
        expect(c).toHaveProperty('gp');
        expect(c).toHaveProperty('color');
        expect(c).toHaveProperty('length_km'); // del GeoJSON real bacinger
      }
    });

    test('incluye circuitos principales (alias legacy)', function() {
      const ids = Object.keys(CIRCUITS);
      expect(ids).toContain('monaco');
      expect(ids).toContain('britain');
      expect(ids).toContain('italy');
      expect(ids).toContain('belgium');
    });

    test('getCircuitIds retorna >=25 IDs', function() {
      expect(getCircuitIds().length).toBeGreaterThanOrEqual(25);
    });

    test('getCircuit retorna datos REALES de Mónaco desde GeoJSON bacinger', function() {
      const m = getCircuit('monaco');
      expect(m).not.toBeNull();
      expect(m.name).toBe('Circuit de Monaco');
      expect(m.id).toBe('mc-1929');
      expect(m.location).toBe('Monaco');
      expect(m.country).toBe('MC');
      expect(m.length_m).toBe(3337); // metadata real del GeoJSON
      expect(m.length_km).toBeCloseTo(3.337, 3);
    });

    test('getCircuit retorna null para ID inexistente', function() {
      expect(getCircuit('unknown_circuit')).toBeNull();
    });

    test('CIRCUITS Proxy: in operator funciona', function() {
      expect('monaco' in CIRCUITS).toBe(true);
      expect('unknown_xx' in CIRCUITS).toBe(false);
    });

    test('CIRCUITS Proxy: Symbol property → undefined (no string)', function() {
      const sym = Symbol('test');
      expect(CIRCUITS[sym]).toBeUndefined();
    });

    test('CIRCUITS Proxy: getOwnPropertyDescriptor por ID válido', function() {
      const desc = Object.getOwnPropertyDescriptor(CIRCUITS, 'monaco');
      expect(desc).toBeDefined();
      expect(desc.enumerable).toBe(true);
      expect(desc.value.name).toBe('Circuit de Monaco');
    });

    test('CIRCUITS Proxy: getOwnPropertyDescriptor por ID inválido → undefined', function() {
      const desc = Object.getOwnPropertyDescriptor(CIRCUITS, 'inexistente_yy');
      expect(desc).toBeUndefined();
    });

    test('getCircuit con circuito sin country color usa DEFAULT_TRACK_COLOR', function() {
      const ar = getCircuit('ar-1952'); // Argentina, no en COUNTRY_COLOR
      expect(ar).not.toBeNull();
      expect(ar.color).toBe('#00E5FF'); // DEFAULT_TRACK_COLOR
    });

    test('resolveCircuitId: input con espacios + dashes normaliza', function() {
      const { resolveCircuitId } = require('../sports/f1_dashboard/circuit_maps');
      expect(resolveCircuitId('saudi arabia')).toBe('sa-2021');
      expect(resolveCircuitId('saudi-arabia')).toBe('sa-2021');
      expect(resolveCircuitId('las  vegas')).toBe('us-2023');
    });

    test('resolveCircuitId: input normaliza pero no encuentra alias → null', function() {
      const { resolveCircuitId } = require('../sports/f1_dashboard/circuit_maps');
      expect(resolveCircuitId('zzz unknown circuit')).toBeNull();
    });

    test('resolveCircuitId: input null/undefined/non-string → null', function() {
      const { resolveCircuitId } = require('../sports/f1_dashboard/circuit_maps');
      expect(resolveCircuitId(null)).toBeNull();
      expect(resolveCircuitId(undefined)).toBeNull();
      expect(resolveCircuitId(42)).toBeNull();
      expect(resolveCircuitId('')).toBeNull();
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

    test('viewport custom partial sin width/height usa defaults', function() {
      const svg = generateCircuitSVG('monaco', { viewport: {} });
      expect(svg).toContain('viewBox="0 0 800 500"');
    });

    test('driverPos con showLabel false omite label', function() {
      const svg = generateCircuitSVG('monaco', {
        driverPos: { x: 100, y: 100 },
        driverName: 'Norris',
        showLabel: false,
      });
      expect(svg).toContain('<circle');
      expect(svg).not.toMatch(/<text[^>]*>Norris<\/text>/);
    });

    test('circuito sin country color usa fallback en SVG', function() {
      const svg = generateCircuitSVG('ar-1952'); // Argentina, no en COUNTRY_COLOR
      expect(svg).toContain('#00E5FF');
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
