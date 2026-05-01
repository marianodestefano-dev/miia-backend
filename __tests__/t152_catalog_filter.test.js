'use strict';

const {
  parseFilters, applyFilters, filterByNaturalLanguage,
} = require('../core/catalog_filter');

const PRODUCTS = [
  { id: 'p1', name: 'Zapatos Nike', category: 'calzado', price: 80, stock: 5, available: true },
  { id: 'p2', name: 'Camiseta', category: 'ropa', price: 30, stock: 0, available: false },
  { id: 'p3', name: 'Laptop HP', category: 'tecnologia', price: 800, stock: 2, available: true },
  { id: 'p4', name: 'Mesa madera', category: 'muebles', price: 250, stock: 1, available: true },
  { id: 'p5', name: 'Proteina', category: 'nutricion', price: 45, stock: 3, available: true },
];

describe('parseFilters â€” validacion', () => {
  test('lanza si query undefined', () => {
    expect(() => parseFilters(undefined)).toThrow('query requerido');
  });
  test('lanza si query vacio', () => {
    expect(() => parseFilters('')).toThrow('query requerido');
  });
});

describe('parseFilters â€” precio', () => {
  test('parsea precio maximo "menos de 100"', () => {
    const f = parseFilters('zapatos menos de 100');
    expect(f.priceMax).toBe(100);
    expect(f.priceMin).toBeNull();
  });
  test('parsea precio maximo "hasta $50"', () => {
    const f = parseFilters('quiero algo hasta $50');
    expect(f.priceMax).toBe(50);
  });
  test('parsea precio minimo "mas de 200"', () => {
    const f = parseFilters('productos mas de 200');
    expect(f.priceMin).toBe(200);
    expect(f.priceMax).toBeNull();
  });
  test('parsea rango "entre 50 y 200"', () => {
    const f = parseFilters('productos entre 50 y 200');
    expect(f.priceMin).toBe(50);
    expect(f.priceMax).toBe(200);
  });
  test('parsea rango con $ "entre $30 y $100"', () => {
    const f = parseFilters('entre $30 y $100');
    expect(f.priceMin).toBe(30);
    expect(f.priceMax).toBe(100);
  });
  test('retorna null si no hay precio en query', () => {
    const f = parseFilters('zapatos deportivos');
    expect(f.priceMin).toBeNull();
    expect(f.priceMax).toBeNull();
  });
});

describe('parseFilters â€” disponibilidad', () => {
  test('detecta disponibles "tienes en stock"', () => {
    const f = parseFilters('tienes zapatos en stock');
    expect(f.availability).toBe('available');
  });
  test('detecta disponibles "disponible"', () => {
    const f = parseFilters('algo disponible para hoy');
    expect(f.availability).toBe('available');
  });
  test('detecta no disponibles "agotado"', () => {
    const f = parseFilters('que esta agotado');
    expect(f.availability).toBe('unavailable');
  });
  test('null si no hay palabra de disponibilidad', () => {
    const f = parseFilters('zapatos rojos');
    expect(f.availability).toBeNull();
  });
});

describe('applyFilters', () => {
  test('lanza si products no es array', () => {
    expect(() => applyFilters(null, {})).toThrow('array');
  });
  test('lanza si filters undefined', () => {
    expect(() => applyFilters([], undefined)).toThrow('filters requerido');
  });
  test('sin filtros retorna todos los productos', () => {
    const r = applyFilters(PRODUCTS, { priceMin: null, priceMax: null, categories: [], availability: null });
    expect(r.length).toBe(PRODUCTS.length);
  });
  test('filtra por precio maximo', () => {
    const r = applyFilters(PRODUCTS, { priceMin: null, priceMax: 100, categories: [], availability: null });
    expect(r.every(p => p.price <= 100)).toBe(true);
    expect(r.length).toBe(3); // 80, 30, 45
  });
  test('filtra por precio minimo', () => {
    const r = applyFilters(PRODUCTS, { priceMin: 200, priceMax: null, categories: [], availability: null });
    expect(r.every(p => p.price >= 200)).toBe(true);
    expect(r.length).toBe(2); // 800, 250
  });
  test('filtra por rango de precio', () => {
    const r = applyFilters(PRODUCTS, { priceMin: 40, priceMax: 100, categories: [], availability: null });
    expect(r.length).toBe(2); // 80, 45
  });
  test('filtra por categoria', () => {
    const r = applyFilters(PRODUCTS, { priceMin: null, priceMax: null, categories: ['calzado'], availability: null });
    expect(r.length).toBe(1);
    expect(r[0].id).toBe('p1');
  });
  test('filtra por disponibles excluye sin stock', () => {
    const r = applyFilters(PRODUCTS, { priceMin: null, priceMax: null, categories: [], availability: 'available' });
    expect(r.every(p => p.stock !== 0 && p.available !== false)).toBe(true);
    expect(r.length).toBe(4); // p2 excluido
  });
  test('filtra por no disponibles', () => {
    const r = applyFilters(PRODUCTS, { priceMin: null, priceMax: null, categories: [], availability: 'unavailable' });
    expect(r.length).toBe(1);
    expect(r[0].id).toBe('p2');
  });
});

describe('filterByNaturalLanguage', () => {
  test('retorna filtered y filters', () => {
    const r = filterByNaturalLanguage(PRODUCTS, 'productos menos de 100');
    expect(r).toHaveProperty('filtered');
    expect(r).toHaveProperty('filters');
    expect(r.filters.priceMax).toBe(100);
    expect(r.filtered.every(p => p.price <= 100)).toBe(true);
  });
  test('filtra por disponibilidad desde lenguaje natural', () => {
    const r = filterByNaturalLanguage(PRODUCTS, 'que tengas disponible');
    expect(r.filters.availability).toBe('available');
    expect(r.filtered.length).toBe(4);
  });
});
