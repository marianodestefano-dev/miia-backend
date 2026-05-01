'use strict';

/**
 * T91 (Mariano mapa) -- Privacy Data Inventory
 * Tests: getDataInventory, DATA_CATEGORIES, endpoint shape
 */

const { getDataInventory, DATA_CATEGORIES } = require('../core/privacy_data_map');

describe('T91 -- DATA_CATEGORIES estructura', () => {
  test('DATA_CATEGORIES es un array no vacio', () => {
    expect(Array.isArray(DATA_CATEGORIES)).toBe(true);
    expect(DATA_CATEGORIES.length).toBeGreaterThan(0);
  });

  test('cada categoria tiene campos requeridos', () => {
    for (const cat of DATA_CATEGORIES) {
      expect(typeof cat.name).toBe('string');
      expect(typeof cat.description).toBe('string');
      expect(typeof cat.location).toBe('string');
      expect(typeof cat.retention).toBe('string');
      expect(typeof cat.pii).toBe('boolean');
      expect(Array.isArray(cat.pii_types)).toBe(true);
      expect(typeof cat.access).toBe('string');
    }
  });

  test('hay al menos 3 categorias con PII', () => {
    const piiCats = DATA_CATEGORIES.filter(c => c.pii);
    expect(piiCats.length).toBeGreaterThanOrEqual(3);
  });

  test('conversations categoria tiene pii: true', () => {
    const conv = DATA_CATEGORIES.find(c => c.name === 'conversations');
    expect(conv).toBeDefined();
    expect(conv.pii).toBe(true);
    expect(conv.pii_types).toContain('phone_numbers');
  });

  test('ai_context_cache tiene pii: false', () => {
    const cache = DATA_CATEGORIES.find(c => c.name === 'ai_context_cache');
    expect(cache).toBeDefined();
    expect(cache.pii).toBe(false);
  });
});

describe('T91 -- getDataInventory', () => {
  test('exporta como funcion', () => {
    expect(typeof getDataInventory).toBe('function');
  });

  test('throws con uid null', () => {
    expect(() => getDataInventory(null)).toThrow('uid requerido');
  });

  test('throws con uid undefined', () => {
    expect(() => getDataInventory(undefined)).toThrow('uid requerido');
  });

  test('retorna inventario con todos los campos requeridos', () => {
    const inv = getDataInventory('testUid123456789012345678');
    expect(inv).toHaveProperty('uid_masked');
    expect(inv).toHaveProperty('generated_at');
    expect(inv).toHaveProperty('data_categories');
    expect(inv).toHaveProperty('summary');
    expect(inv).toHaveProperty('rights');
    expect(inv).toHaveProperty('full_report_endpoint');
  });

  test('uid_masked enmascara UID correctamente', () => {
    const inv = getDataInventory('A5pMESWlfmPWCoCPRbwy85EzUzy2');
    expect(inv.uid_masked).toBe('A5pMESWl...');
  });

  test('uid corto no se enmascara', () => {
    const inv = getDataInventory('uid1234');
    expect(inv.uid_masked).toBe('uid1234');
  });

  test('generated_at es ISO string valido', () => {
    const inv = getDataInventory('testUid');
    expect(() => new Date(inv.generated_at)).not.toThrow();
    expect(new Date(inv.generated_at).getTime()).not.toBeNaN();
  });

  test('summary.total_categories == DATA_CATEGORIES.length', () => {
    const inv = getDataInventory('testUid');
    expect(inv.summary.total_categories).toBe(DATA_CATEGORIES.length);
  });

  test('summary.pii + non_pii == total', () => {
    const inv = getDataInventory('testUid');
    expect(inv.summary.pii_categories + inv.summary.non_pii_categories).toBe(inv.summary.total_categories);
  });

  test('rights es array no vacio', () => {
    const inv = getDataInventory('testUid');
    expect(Array.isArray(inv.rights)).toBe(true);
    expect(inv.rights.length).toBeGreaterThan(0);
  });

  test('full_report_endpoint contiene privacy-report', () => {
    const inv = getDataInventory('testUid');
    expect(inv.full_report_endpoint).toContain('privacy-report');
  });
});
