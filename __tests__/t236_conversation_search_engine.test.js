'use strict';

const {
  searchContacts, searchMessages, searchAll, computeRelevance, normalizeText,
  buildSnippet, getMatchedFields, isValidMode,
  SEARCH_MODES, MAX_RESULTS, MIN_QUERY_LENGTH, RELEVANCE_THRESHOLD,
} = require('../core/conversation_search_engine');

describe('Constantes', () => {
  test('SEARCH_MODES tiene 3 modos', () => { expect(SEARCH_MODES.length).toBe(3); });
  test('frozen SEARCH_MODES', () => { expect(() => { SEARCH_MODES.push('x'); }).toThrow(); });
  test('MAX_RESULTS es 50', () => { expect(MAX_RESULTS).toBe(50); });
  test('MIN_QUERY_LENGTH es 2', () => { expect(MIN_QUERY_LENGTH).toBe(2); });
  test('RELEVANCE_THRESHOLD es 0.3', () => { expect(RELEVANCE_THRESHOLD).toBe(0.3); });
});

describe('isValidMode', () => {
  test('contacts es valido', () => { expect(isValidMode('contacts')).toBe(true); });
  test('all es valido', () => { expect(isValidMode('all')).toBe(true); });
  test('sms no es valido', () => { expect(isValidMode('sms')).toBe(false); });
});

describe('normalizeText', () => {
  test('convierte a minuscula', () => { expect(normalizeText('HOLA')).toBe('hola'); });
  test('elimina acentos', () => { expect(normalizeText('Martín')).toBe('martin'); });
  test('elimina caracteres especiales', () => { expect(normalizeText('hola!')).toBe('hola'); });
  test('retorna vacio si null', () => { expect(normalizeText(null)).toBe(''); });
  test('normaliza espacios multiples', () => { expect(normalizeText('hola  mundo')).toBe('hola mundo'); });
});

describe('computeRelevance', () => {
  test('match exacto retorna 1', () => { expect(computeRelevance('hola', 'hola')).toBe(1); });
  test('target empieza con query retorna 0.9', () => { expect(computeRelevance('mar', 'martin')).toBe(0.9); });
  test('target contiene query retorna 0.7', () => { expect(computeRelevance('ana', 'susana perez')).toBe(0.7); });
  test('sin coincidencia retorna 0', () => { expect(computeRelevance('xyz', 'abc def')).toBe(0); });
  test('null query retorna 0', () => { expect(computeRelevance(null, 'texto')).toBe(0); });
  test('match parcial de palabras funciona', () => {
    const r = computeRelevance('juan perez', 'juan carlos perez gonzalez');
    expect(r).toBeGreaterThan(RELEVANCE_THRESHOLD);
  });
});

describe('searchContacts', () => {
  const contacts = [
    { phone: '+541155667788', name: 'Juan Perez', email: 'juan@test.com', tags: ['lead', 'vip'] },
    { phone: '+541155668899', name: 'Maria Lopez', email: 'maria@test.com', tags: ['client'] },
    { phone: '+541155669900', name: 'Carlos Gomez', email: 'carlos@test.com', notes: 'quiere precio especial' },
    { phone: '+541155660011', name: 'Ana Martinez', tags: ['lead'] },
  ];

  test('lanza si contacts no es array', () => {
    expect(() => searchContacts('no-array', 'juan')).toThrow('debe ser array');
  });
  test('lanza si query muy corta', () => {
    expect(() => searchContacts(contacts, 'a')).toThrow('al menos');
  });
  test('encuentra por nombre', () => {
    const r = searchContacts(contacts, 'juan');
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0].contact.name).toBe('Juan Perez');
  });
  test('encuentra por email', () => {
    const r = searchContacts(contacts, 'maria@test');
    expect(r.results.length).toBeGreaterThan(0);
  });
  test('encuentra por tags', () => {
    const r = searchContacts(contacts, 'vip');
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0].contact.name).toBe('Juan Perez');
  });
  test('no devuelve resultados sin match', () => {
    const r = searchContacts(contacts, 'zzzznotfound');
    expect(r.results.length).toBe(0);
  });
  test('retorna estructura correcta', () => {
    const r = searchContacts(contacts, 'juan');
    expect(r.query).toBe('juan');
    expect(r.mode).toBe('contacts');
    expect(r.total).toBeGreaterThanOrEqual(0);
    expect(r.limit).toBe(MAX_RESULTS);
  });
  test('ordena por relevance descendente', () => {
    const r = searchContacts(contacts, 'juan perez');
    if (r.results.length > 1) {
      expect(r.results[0].relevance).toBeGreaterThanOrEqual(r.results[1].relevance);
    }
  });
  test('respeta limit personalizado', () => {
    const r = searchContacts(contacts, 'lead', { limit: 1 });
    expect(r.results.length).toBeLessThanOrEqual(1);
  });
});

describe('searchMessages', () => {
  const messages = [
    { text: 'Hola quiero saber el precio del producto', phone: '+54111', timestamp: '2026-05-01T10:00:00Z' },
    { text: 'Buenos dias tengo una consulta sobre envios', phone: '+54222' },
    { text: 'Gracias por la informacion sobre precios', phone: '+54333' },
  ];

  test('lanza si messages no es array', () => {
    expect(() => searchMessages('no-array', 'precio')).toThrow('debe ser array');
  });
  test('lanza si query muy corta', () => {
    expect(() => searchMessages(messages, 'a')).toThrow('al menos');
  });
  test('encuentra mensajes con match', () => {
    const r = searchMessages(messages, 'precio');
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0].snippet).toBeDefined();
  });
  test('retorna estructura correcta', () => {
    const r = searchMessages(messages, 'consulta');
    expect(r.query).toBe('consulta');
    expect(r.mode).toBe('conversations');
  });
  test('no devuelve mensajes sin match', () => {
    const r = searchMessages(messages, 'zzztopico');
    expect(r.results.length).toBe(0);
  });
});

describe('buildSnippet', () => {
  test('retorna texto corto completo', () => {
    const r = buildSnippet('Hola mundo', 'hola');
    expect(r).toContain('Hola');
  });
  test('trunca texto largo', () => {
    const long = 'x'.repeat(300);
    const r = buildSnippet(long, 'x');
    expect(r.length).toBeLessThan(300);
  });
  test('retorna vacio si text null', () => {
    expect(buildSnippet(null, 'query')).toBe('');
  });
});

describe('searchAll', () => {
  test('lanza si query muy corta', () => {
    expect(() => searchAll([], [], 'a')).toThrow('al menos');
  });
  test('retorna contacts y conversations en resultado', () => {
    const contacts = [{ phone: '+54111', name: 'Juan Test' }];
    const messages = [{ text: 'Quiero informacion de Juan' }];
    const r = searchAll(contacts, messages, 'juan');
    expect(r.contacts).toBeDefined();
    expect(r.conversations).toBeDefined();
    expect(r.mode).toBe('all');
    expect(r.totalResults).toBeGreaterThanOrEqual(0);
  });
  test('acepta arrays vacios', () => {
    const r = searchAll([], [], 'hola');
    expect(r.contacts.results.length).toBe(0);
    expect(r.conversations.results.length).toBe(0);
  });
});

describe('getMatchedFields', () => {
  test('retorna campos con match', () => {
    const contact = { name: 'Juan Perez', phone: '+54111', email: 'juan@test.com' };
    const fields = getMatchedFields('juan', contact);
    expect(fields).toContain('name');
  });
  test('retorna array vacio si sin match', () => {
    const contact = { name: 'Pedro', phone: '+54999' };
    const fields = getMatchedFields('xyz', contact);
    expect(fields).toEqual([]);
  });
});
