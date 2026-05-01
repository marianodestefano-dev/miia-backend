'use strict';

const {
  detectSector, listSectors, isValidSector,
  SECTOR_KEYWORDS, SECTOR_LABELS,
} = require('../core/sector_detector');

describe('detectSector â€” validacion', () => {
  test('lanza si text undefined', () => {
    expect(() => detectSector(undefined)).toThrow('text requerido');
  });
  test('lanza si text vacio', () => {
    expect(() => detectSector('')).toThrow('text requerido');
  });
});

describe('detectSector â€” deteccion por keywords', () => {
  test('detecta sector food con pizza restaurante', () => {
    const r = detectSector('tengo un restaurante de pizza y comida italiana');
    expect(r.sector).toBe('food');
    expect(r.confidence).toBeGreaterThan(0);
  });
  test('detecta sector health con clinica medico', () => {
    const r = detectSector('clinica medica y dental con doctores especializados');
    expect(r.sector).toBe('health');
  });
  test('detecta sector retail con tienda ropa', () => {
    const r = detectSector('tengo una tienda de ropa y accesorios de moda');
    expect(r.sector).toBe('retail');
  });
  test('detecta sector beauty con peluqueria salon', () => {
    const r = detectSector('salon de belleza y peluqueria profesional');
    expect(r.sector).toBe('beauty');
  });
  test('detecta sector tech con software desarrollo', () => {
    const r = detectSector('empresa de software y desarrollo de apps');
    expect(r.sector).toBe('tech');
  });
  test('retorna other cuando no hay keywords reconocidas', () => {
    const r = detectSector('negocio generico sin descripcion especifica xyq');
    expect(r.sector).toBe('other');
    expect(r.confidence).toBe(0);
    expect(r.scores).toEqual({});
  });
});

describe('detectSector â€” scores y confidence', () => {
  test('incluye scores de todos los sectores que matchearon', () => {
    const r = detectSector('gym y fitness con clases de yoga pilates entrenamiento');
    expect(r.scores).toBeDefined();
    expect(typeof r.scores['fitness']).toBe('number');
    expect(r.scores['fitness']).toBeGreaterThan(0);
  });
  test('confidence es numero entre 0 y 1', () => {
    const r = detectSector('restaurante de comida rapida');
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });
  test('text con acentos normaliza correctamente (clinica)', () => {
    const r = detectSector('clinica de nutricion y psicologia');
    expect(r.sector).toBe('health');
  });
  test('sector con mas keywords gana sobre secundario', () => {
    const r = detectSector('restaurante cafe panaderia comida pizza delivery');
    expect(r.sector).toBe('food');
    expect(r.scores['food']).toBeGreaterThan(1);
  });
});

describe('listSectors', () => {
  test('retorna array de sectores con sector y label', () => {
    const sectors = listSectors();
    expect(Array.isArray(sectors)).toBe(true);
    expect(sectors.length).toBe(Object.keys(SECTOR_LABELS).length);
    for (const s of sectors) {
      expect(s).toHaveProperty('sector');
      expect(s).toHaveProperty('label');
    }
  });
});

describe('isValidSector', () => {
  test('retorna true para sectores validos', () => {
    expect(isValidSector('food')).toBe(true);
    expect(isValidSector('retail')).toBe(true);
    expect(isValidSector('other')).toBe(true);
  });
  test('retorna false para sectores invalidos', () => {
    expect(isValidSector('fake_sector')).toBe(false);
    expect(isValidSector('')).toBe(false);
  });
});
