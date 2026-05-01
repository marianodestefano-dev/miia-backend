'use strict';

/**
 * T313 -- conversation_search_engine unit tests (25/25)
 */

const {
  searchContacts,
  searchMessages,
  searchAll,
  computeRelevance,
  normalizeText,
  buildSnippet,
  getMatchedFields,
  isValidMode,
  SEARCH_MODES,
  MAX_RESULTS,
  MIN_QUERY_LENGTH,
  RELEVANCE_THRESHOLD,
} = require('../core/conversation_search_engine');

describe('T313 -- conversation_search_engine (25 tests)', () => {

  // Constantes

  test('SEARCH_MODES frozen con 3 modos', () => {
    expect(Object.isFrozen(SEARCH_MODES)).toBe(true);
    expect(SEARCH_MODES.length).toBe(3);
    ['contacts', 'conversations', 'all'].forEach(m => {
      expect(SEARCH_MODES).toContain(m);
    });
  });

  test('MAX_RESULTS=50, MIN_QUERY_LENGTH=2, RELEVANCE_THRESHOLD=0.3', () => {
    expect(MAX_RESULTS).toBe(50);
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(RELEVANCE_THRESHOLD).toBe(0.3);
  });

  test('isValidMode: modos validos retornan true', () => {
    expect(isValidMode('contacts')).toBe(true);
    expect(isValidMode('conversations')).toBe(true);
    expect(isValidMode('all')).toBe(true);
  });

  test('isValidMode: modos invalidos retornan false', () => {
    expect(isValidMode('leads')).toBe(false);
    expect(isValidMode('')).toBe(false);
    expect(isValidMode(null)).toBe(false);
  });

  // normalizeText

  test('normalizeText: convierte a minusculas y remueve acentos', () => {
    expect(normalizeText('Análisis')).toBe('analisis');
    expect(normalizeText('PRECIO')).toBe('precio');
    expect(normalizeText('María José')).toBe('maria jose');
  });

  test('normalizeText: remueve caracteres especiales', () => {
    const result = normalizeText('¿Cuál es el precio?');
    expect(result).not.toContain('?');
    expect(result).not.toContain('¿');
    expect(result).toContain('precio');
  });

  test('normalizeText: null y undefined retornan string vacio', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
    expect(normalizeText('')).toBe('');
  });

  // computeRelevance

  test('computeRelevance: match exacto retorna 1', () => {
    expect(computeRelevance('juan', 'juan')).toBe(1);
  });

  test('computeRelevance: target empieza con query retorna 0.9', () => {
    expect(computeRelevance('juan', 'juan perez')).toBe(0.9);
  });

  test('computeRelevance: target contiene query retorna 0.7', () => {
    expect(computeRelevance('perez', 'juan perez martinez')).toBe(0.7);
  });

  test('computeRelevance: palabras parciales retornan valor entre 0 y 0.6', () => {
    const score = computeRelevance('juan carlos', 'carlos hernandez');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(0.6);
  });

  test('computeRelevance: sin coincidencias retorna 0', () => {
    expect(computeRelevance('xyz', 'abc def')).toBe(0);
  });

  // searchContacts

  test('searchContacts: encuentra por nombre', () => {
    const contacts = [
      { name: 'Juan Perez', phone: '+5411111111', tags: [] },
      { name: 'Maria Lopez', phone: '+5422222222', tags: [] },
    ];
    const result = searchContacts(contacts, 'Juan', {});
    expect(result.total).toBe(1);
    expect(result.results[0].contact.name).toBe('Juan Perez');
  });

  test('searchContacts: encuentra por telefono', () => {
    const contacts = [{ name: 'Ana', phone: '5411234567', tags: [] }];
    const result = searchContacts(contacts, '5411234567', {});
    expect(result.total).toBe(1);
  });

  test('searchContacts: encuentra por tags', () => {
    const contacts = [
      { name: 'Test', phone: '+5411111111', tags: ['vip', 'colombia'] },
      { name: 'Otro', phone: '+5422222222', tags: ['lead'] },
    ];
    const result = searchContacts(contacts, 'vip', {});
    expect(result.total).toBe(1);
    expect(result.results[0].matchedIn).toContain('tags');
  });

  test('searchContacts: sin resultados retorna total=0', () => {
    const contacts = [{ name: 'Juan', phone: '1111', tags: [] }];
    const result = searchContacts(contacts, 'xyz_no_existe', {});
    expect(result.total).toBe(0);
    expect(result.results).toEqual([]);
  });

  test('searchContacts: lanza error si query < MIN_QUERY_LENGTH', () => {
    expect(() => searchContacts([], 'x', {})).toThrow('caracteres');
  });

  test('searchContacts: lanza error si contacts no es array', () => {
    expect(() => searchContacts('no-array', 'test', {})).toThrow('array');
  });

  test('searchContacts: respeta limit en opts', () => {
    const contacts = Array.from({ length: 10 }, (_, i) => ({
      name: 'Juan ' + i, phone: '+541100000' + i, tags: [],
    }));
    const result = searchContacts(contacts, 'Juan', { limit: 3 });
    expect(result.results.length).toBe(3);
    expect(result.total).toBe(10);
  });

  // searchMessages

  test('searchMessages: encuentra por keyword en texto', () => {
    const messages = [
      { text: 'quiero saber el precio del plan', phone: '+5411111111' },
      { text: 'hola buenos dias', phone: '+5422222222' },
    ];
    const result = searchMessages(messages, 'precio', {});
    expect(result.total).toBe(1);
    expect(result.results[0].snippet).toContain('precio');
  });

  test('searchMessages: snippet tiene contexto del match', () => {
    const messages = [{ text: 'el precio mensual del plan esencial es 50 dolares', phone: '+5411111111' }];
    const result = searchMessages(messages, 'precio', {});
    expect(result.results[0].snippet).not.toBe('');
  });

  test('searchMessages: lanza error si query muy corta', () => {
    expect(() => searchMessages([], 'a', {})).toThrow('caracteres');
  });

  // buildSnippet

  test('buildSnippet: retorna texto centrado en el match', () => {
    const text = 'hola como estas, el precio mensual es 100 dolares, gracias';
    const snippet = buildSnippet(text, 'precio');
    expect(snippet).toContain('precio');
  });

  test('buildSnippet: texto vacio retorna string vacio', () => {
    expect(buildSnippet('', 'query')).toBe('');
    expect(buildSnippet(null, 'query')).toBe('');
  });

  // searchAll

  test('searchAll: combina contacts y messages en resultado unificado', () => {
    const contacts = [{ name: 'Precio Plus', phone: '+5411111111', tags: [] }];
    const messages = [{ text: 'precio del plan mensual', phone: '+5411111111' }];
    const result = searchAll(contacts, messages, 'precio', {});
    expect(result.mode).toBe('all');
    expect(result.totalResults).toBeGreaterThanOrEqual(2);
    expect(result.contacts).toBeDefined();
    expect(result.conversations).toBeDefined();
  });

  test('searchAll: acepta arrays vacios para contacts o messages', () => {
    const result = searchAll([], [], 'precio plan', {});
    expect(result.totalResults).toBe(0);
  });
});
