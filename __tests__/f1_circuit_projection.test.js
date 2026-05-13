'use strict';

/**
 * Tests circuit_projection.js — proyección lat/lon → SVG.
 * 100% branches.
 */

const cp = require('../sports/f1_dashboard/circuit_projection');

describe('circuit_projection — projectPoint', () => {
  const bbox = [7.421, 43.732, 7.430, 43.741]; // Monaco approx

  test('punto en esquina min lon/max lat va al borde superior (padding top)', () => {
    const p = cp.projectPoint(7.421, 43.741, bbox, { width: 800, height: 500, padding: 30 });
    // Y siempre = padding cuando lat = maxLat (top). X puede tener offset aspect.
    expect(p.y).toBeCloseTo(30, 0);
    expect(p.x).toBeGreaterThanOrEqual(30); // al menos padding
  });

  test('punto en esquina max va al borde opuesto', () => {
    const p = cp.projectPoint(7.430, 43.732, bbox, { width: 800, height: 500, padding: 30 });
    // Esquina max → con padding 30 y aspect Monaco más vertical, debería ir cerca de los bordes.
    expect(p.x).toBeLessThanOrEqual(800);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(500);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });

  test('viewport default si no se pasa', () => {
    const p = cp.projectPoint(7.4255, 43.7365, bbox);
    expect(typeof p.x).toBe('number');
    expect(typeof p.y).toBe('number');
  });

  test('viewport sin width/height usa defaults', () => {
    const p = cp.projectPoint(7.4255, 43.7365, bbox, {});
    expect(p.x).toBeGreaterThan(0);
    expect(p.y).toBeGreaterThan(0);
  });

  test('viewport con padding 0', () => {
    const p = cp.projectPoint(7.421, 43.741, bbox, { width: 800, height: 500, padding: 0 });
    // Sin padding, el punto en esquina min va al borde 0,0 (modulo aspect offset).
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });

  test('bbox degenerado (dLon=0) no rompe', () => {
    const flatBbox = [7.421, 43.732, 7.421, 43.741];
    const p = cp.projectPoint(7.421, 43.737, flatBbox, { width: 800, height: 500, padding: 30 });
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });

  test('bbox degenerado (dLat=0) no rompe', () => {
    const flatBbox = [7.421, 43.732, 7.430, 43.732];
    const p = cp.projectPoint(7.4255, 43.732, flatBbox, { width: 800, height: 500, padding: 30 });
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });

  test('circuito ancho (aspect > viewport) → fit por ancho con bandas top/bottom', () => {
    // BBox muy ancho horizontalmente
    const wideBbox = [-1, 0, 1, 0.1];
    const p = cp.projectPoint(0, 0.05, wideBbox, { width: 800, height: 500, padding: 0 });
    // Centro proyectado debería estar cerca de centro horizontal
    expect(p.x).toBeCloseTo(400, 0);
  });

  test('circuito alto (aspect < viewport) → fit por alto con bandas izquierda/derecha', () => {
    const tallBbox = [0, -1, 0.1, 1];
    const p = cp.projectPoint(0.05, 0, tallBbox, { width: 800, height: 500, padding: 0 });
    // Centro vertical
    expect(p.y).toBeCloseTo(250, 0);
  });
});

describe('circuit_projection — projectPath', () => {
  const bbox = [0, 0, 10, 10];

  test('proyecta array de coords', () => {
    const coords = [
      [0, 0],
      [5, 5],
      [10, 10],
    ];
    const projected = cp.projectPath(coords, bbox);
    expect(projected.length).toBe(3);
    expect(projected[0]).toHaveProperty('x');
    expect(projected[0]).toHaveProperty('y');
  });

  test('array vacío → []', () => {
    expect(cp.projectPath([], bbox)).toEqual([]);
  });

  test('null → []', () => {
    expect(cp.projectPath(null, bbox)).toEqual([]);
  });

  test('undefined → []', () => {
    expect(cp.projectPath(undefined, bbox)).toEqual([]);
  });

  test('viewport custom', () => {
    const coords = [[5, 5]];
    const projected = cp.projectPath(coords, bbox, { width: 200, height: 200, padding: 10 });
    expect(projected[0].x).toBeCloseTo(100, 0);
    expect(projected[0].y).toBeCloseTo(100, 0);
  });
});

describe('circuit_projection — pointsToSvgPath', () => {
  test('genera M + L + Z para circuito cerrado', () => {
    const points = [
      { x: 100, y: 200 },
      { x: 110, y: 205 },
      { x: 120, y: 210 },
    ];
    const d = cp.pointsToSvgPath(points);
    expect(d).toContain('M 100.00 200.00');
    expect(d).toContain('L 110.00 205.00');
    expect(d).toContain('L 120.00 210.00');
    expect(d.endsWith('Z')).toBe(true);
  });

  test('closePath false → sin Z', () => {
    const points = [{ x: 100, y: 200 }, { x: 110, y: 205 }];
    const d = cp.pointsToSvgPath(points, false);
    expect(d.endsWith('Z')).toBe(false);
  });

  test('closePath true explícito → con Z', () => {
    const points = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
    const d = cp.pointsToSvgPath(points, true);
    expect(d.endsWith('Z')).toBe(true);
  });

  test('array vacío → string vacío', () => {
    expect(cp.pointsToSvgPath([])).toBe('');
  });

  test('null/undefined → string vacío', () => {
    expect(cp.pointsToSvgPath(null)).toBe('');
    expect(cp.pointsToSvgPath(undefined)).toBe('');
  });

  test('single point → solo M + Z', () => {
    const d = cp.pointsToSvgPath([{ x: 100, y: 100 }]);
    expect(d).toBe('M 100.00 100.00 Z');
  });
});

describe('circuit_projection — DEFAULT_VIEWPORT export', () => {
  test('export constantes default', () => {
    expect(cp.DEFAULT_VIEWPORT.width).toBe(800);
    expect(cp.DEFAULT_VIEWPORT.height).toBe(500);
    expect(cp.DEFAULT_VIEWPORT.padding).toBe(30);
  });
});
