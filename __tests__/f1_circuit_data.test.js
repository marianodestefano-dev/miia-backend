'use strict';

/**
 * Tests circuit_data.js — loader GeoJSON bacinger/f1-circuits.
 * 100% branches objetivo (regla Mariano 2026-05-02).
 */

const cd = require('../sports/f1_dashboard/circuit_data');

beforeEach(() => cd._clearCache());

describe('circuit_data — CIRCUITS_MANIFEST', () => {
  test('expone constantes manifest + dir frozen', () => {
    expect(typeof cd.CIRCUITS_MANIFEST).toBe('object');
    expect(Object.isFrozen(cd.CIRCUITS_MANIFEST)).toBe(true);
    expect(typeof cd.CIRCUITS_DIR).toBe('string');
  });

  test('manifest incluye circuitos calendario 2026 principales', () => {
    expect(cd.CIRCUITS_MANIFEST['mc-1929']).toBeDefined();
    expect(cd.CIRCUITS_MANIFEST['bh-2002']).toBeDefined();
    expect(cd.CIRCUITS_MANIFEST['gb-1948']).toBeDefined();
    expect(cd.CIRCUITS_MANIFEST['it-1922']).toBeDefined();
    expect(cd.CIRCUITS_MANIFEST['es-2026']).toBeDefined(); // Madrid NUEVO 2026
  });

  test('manifest tiene campos location, name, gp, country', () => {
    const m = cd.CIRCUITS_MANIFEST['mc-1929'];
    expect(m.location).toBe('Monaco');
    expect(m.name).toBe('Circuit de Monaco');
    expect(m.country).toBe('MC');
    expect(m.gp).toBe('Monaco Grand Prix');
  });
});

describe('circuit_data — listCircuits', () => {
  test('default excluye historicos', () => {
    const list = cd.listCircuits();
    expect(Array.isArray(list)).toBe(true);
    const hasHistorical = list.some((c) => c.historical === true);
    expect(hasHistorical).toBe(false);
    expect(list.length).toBeGreaterThanOrEqual(25);
  });

  test('includeHistorical=true expone todos', () => {
    const all = cd.listCircuits({ includeHistorical: true });
    expect(all.length).toBeGreaterThanOrEqual(40);
    const hasHistorical = all.some((c) => c.historical === true);
    expect(hasHistorical).toBe(true);
  });

  test('opts undefined → default activos', () => {
    const list = cd.listCircuits();
    expect(list.every((c) => !c.historical)).toBe(true);
  });

  test('opts.includeHistorical false explicito', () => {
    const list = cd.listCircuits({ includeHistorical: false });
    expect(list.every((c) => !c.historical)).toBe(true);
  });
});

describe('circuit_data — getCircuitMeta', () => {
  test('devuelve metadata + id si existe', () => {
    const m = cd.getCircuitMeta('mc-1929');
    expect(m).not.toBeNull();
    expect(m.id).toBe('mc-1929');
    expect(m.location).toBe('Monaco');
  });

  test('null si circuit id desconocido', () => {
    expect(cd.getCircuitMeta('xx-9999')).toBeNull();
  });
});

describe('circuit_data — findCircuitId', () => {
  test('resuelve por location case-insensitive', () => {
    expect(cd.findCircuitId('Monaco')).toBe('mc-1929');
    expect(cd.findCircuitId('monaco')).toBe('mc-1929');
    expect(cd.findCircuitId('MONACO')).toBe('mc-1929');
  });

  test('resuelve por country code', () => {
    expect(cd.findCircuitId('MC')).toBe('mc-1929');
    expect(cd.findCircuitId('mc')).toBe('mc-1929');
  });

  test('resuelve por name oficial', () => {
    expect(cd.findCircuitId('Circuit de Monaco')).toBe('mc-1929');
  });

  test('null si no encuentra', () => {
    expect(cd.findCircuitId('Inexistente')).toBeNull();
  });

  test('null para input invalido', () => {
    expect(cd.findCircuitId(null)).toBeNull();
    expect(cd.findCircuitId(undefined)).toBeNull();
    expect(cd.findCircuitId('')).toBeNull();
    expect(cd.findCircuitId(42)).toBeNull();
    expect(cd.findCircuitId({})).toBeNull();
  });
});

describe('circuit_data — loadCircuit + cache', () => {
  test('carga GeoJSON real de Monaco con LineString', () => {
    const data = cd.loadCircuit('mc-1929');
    expect(data).not.toBeNull();
    expect(data.type).toBe('FeatureCollection');
    expect(Array.isArray(data.features)).toBe(true);
    expect(data.features[0].geometry.type).toBe('LineString');
    expect(data.features[0].properties.Name).toBe('Circuit de Monaco');
  });

  test('cache hit en segunda llamada (misma referencia)', () => {
    const first = cd.loadCircuit('mc-1929');
    const second = cd.loadCircuit('mc-1929');
    expect(second).toBe(first);
  });

  test('null si circuit id no en manifest', () => {
    expect(cd.loadCircuit('xx-9999')).toBeNull();
  });

  test('null para input invalido', () => {
    expect(cd.loadCircuit(null)).toBeNull();
    expect(cd.loadCircuit('')).toBeNull();
    expect(cd.loadCircuit(42)).toBeNull();
    expect(cd.loadCircuit(undefined)).toBeNull();
  });
});

describe('circuit_data — getCircuitBBox', () => {
  test('Monaco bbox lat ~43.7N, lon ~7.4E', () => {
    const bbox = cd.getCircuitBBox('mc-1929');
    expect(Array.isArray(bbox)).toBe(true);
    expect(bbox.length).toBe(4);
    // [minLon, minLat, maxLon, maxLat]
    expect(bbox[0]).toBeGreaterThan(7.4);
    expect(bbox[0]).toBeLessThan(7.5);
    expect(bbox[1]).toBeGreaterThan(43.7);
    expect(bbox[1]).toBeLessThan(43.8);
  });

  test('null si circuit no existe', () => {
    expect(cd.getCircuitBBox('xx-9999')).toBeNull();
  });

  test('fallback al feature.bbox cuando GeoJSON top-level bbox falta (defensive)', () => {
    // Simulamos GeoJSON sin bbox top-level cargando manualmente y mockeando cache.
    // _cache es Map interno — podemos setear directo via require.
    const fs = require('fs');
    const path = require('path');
    const real = JSON.parse(
      fs.readFileSync(path.join(cd.CIRCUITS_DIR, 'mc-1929.geojson'), 'utf8'),
    );
    delete real.bbox;
    // Cache manual (acceso al Map interno via _clearCache + override loadCircuit)
    cd._clearCache();
    // Mock fs.readFileSync temporalmente para retornar el GeoJSON sin bbox top-level
    const origRead = fs.readFileSync;
    fs.readFileSync = function (p, enc) {
      if (typeof p === 'string' && p.endsWith('mc-1929.geojson')) {
        return JSON.stringify(real);
      }
      return origRead.call(fs, p, enc);
    };
    try {
      const bbox = cd.getCircuitBBox('mc-1929');
      expect(Array.isArray(bbox)).toBe(true);
      expect(bbox.length).toBe(4);
    } finally {
      fs.readFileSync = origRead;
      cd._clearCache();
    }
  });
});

describe('circuit_data — getCircuitCoordinates', () => {
  test('Monaco devuelve array de [lon, lat]', () => {
    const coords = cd.getCircuitCoordinates('mc-1929');
    expect(Array.isArray(coords)).toBe(true);
    expect(coords.length).toBeGreaterThan(10);
    expect(coords[0].length).toBe(2);
    expect(typeof coords[0][0]).toBe('number'); // lon
    expect(typeof coords[0][1]).toBe('number'); // lat
  });

  test('null si circuit no existe', () => {
    expect(cd.getCircuitCoordinates('xx-9999')).toBeNull();
  });
});

describe('circuit_data — _clearCache', () => {
  test('clearCache permite re-load', () => {
    const first = cd.loadCircuit('mc-1929');
    cd._clearCache();
    const second = cd.loadCircuit('mc-1929');
    // Different object reference post-clear
    expect(second).not.toBe(first);
    expect(second.features[0].properties.Name).toBe(first.features[0].properties.Name);
  });
});
