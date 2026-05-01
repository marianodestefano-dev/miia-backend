'use strict';
const { applyVariables, truncate, splitMessage, formatMessage, MAX_SINGLE_MESSAGE, SPLIT_THRESHOLD } = require('../core/message_formatter');

describe('applyVariables', () => {
  test('null retorna string vacio', () => { expect(applyVariables(null)).toBe(''); });
  test('template sin variables = sin cambios', () => {
    expect(applyVariables('hola mundo')).toBe('hola mundo');
  });
  test('reemplaza variable simple', () => {
    expect(applyVariables('hola {{nombre}}', { nombre: 'Maria' })).toBe('hola Maria');
  });
  test('multiples variables', () => {
    expect(applyVariables('{{a}} y {{b}}', { a: 'uno', b: 'dos' })).toBe('uno y dos');
  });
  test('variable no encontrada = string vacio', () => {
    expect(applyVariables('hola {{desconocido}}')).toBe('hola ');
  });
  test('valor numerico se convierte a string', () => {
    expect(applyVariables('precio: {{precio}}', { precio: 100 })).toBe('precio: 100');
  });
  test('variable null en contexto = string vacio', () => {
    expect(applyVariables('{{nombre}}', { nombre: null })).toBe('');
  });
});

describe('truncate', () => {
  test('texto corto no se trunca', () => {
    expect(truncate('corto', 100)).toBe('corto');
  });
  test('texto largo se trunca con ...', () => {
    const long = 'x'.repeat(200);
    const result = truncate(long, 100);
    expect(result.length).toBe(100);
    expect(result.endsWith('...')).toBe(true);
  });
  test('texto exactamente al limite no se trunca', () => {
    const text = 'x'.repeat(100);
    expect(truncate(text, 100)).toBe(text);
  });
  test('null retorna vacio', () => { expect(truncate(null)).toBe(''); });
});

describe('splitMessage', () => {
  test('texto corto retorna array de 1', () => {
    expect(splitMessage('hola mundo')).toHaveLength(1);
  });
  test('texto largo se divide', () => {
    const longText = 'palabra '.repeat(300); // ~2400 chars
    const parts = splitMessage(longText);
    expect(parts.length).toBeGreaterThan(1);
  });
  test('todas las partes tienen contenido', () => {
    const longText = 'Esto es una oracion normal. '.repeat(100);
    const parts = splitMessage(longText);
    expect(parts.every(p => p.length > 0)).toBe(true);
  });
  test('texto vacio retorna array vacio', () => {
    expect(splitMessage('')).toEqual([]);
    expect(splitMessage(null)).toEqual([]);
  });
  test('mantiene el contenido completo al dividir', () => {
    const text = 'a '.repeat(1000);
    const parts = splitMessage(text);
    const reconstructed = parts.join(' ').replace(/\s+/g, ' ').trim();
    const original = text.trim().replace(/\s+/g, ' ');
    expect(reconstructed.replace(/\s/g, '')).toContain(original.slice(0, 100).replace(/\s/g, ''));
  });
});

describe('formatMessage', () => {
  test('null retorna parts vacio', () => {
    const r = formatMessage(null);
    expect(r.parts).toEqual([]);
    expect(r.wasTruncated).toBe(false);
    expect(r.wasSplit).toBe(false);
  });
  test('mensaje corto = 1 part, no truncado, no split', () => {
    const r = formatMessage('hola {{nombre}}', { nombre: 'Juan' });
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]).toBe('hola Juan');
    expect(r.wasTruncated).toBe(false);
    expect(r.wasSplit).toBe(false);
  });
  test('mensaje largo se marca como split', () => {
    const template = 'texto '.repeat(400); // ~2400 chars
    const r = formatMessage(template, {});
    expect(r.wasSplit).toBe(true);
    expect(r.parts.length).toBeGreaterThan(1);
  });
  test('mensaje muy largo se trunca', () => {
    const template = 'x'.repeat(5000);
    const r = formatMessage(template, {}, { maxLength: MAX_SINGLE_MESSAGE });
    expect(r.wasTruncated).toBe(true);
  });
  test('aplica variables antes de splitear', () => {
    const template = '{{greeting}} '.repeat(500);
    const r = formatMessage(template, { greeting: 'hola' });
    expect(r.parts[0]).toContain('hola');
  });
});
