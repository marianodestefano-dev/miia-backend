'use strict';
const { renderTemplate, extractVariables, validateTemplate } = require('../core/template_engine');

describe('extractVariables', () => {
  test('extrae variables de un template', () => {
    const vars = extractVariables('Hola {{nombre}}, tu turno es el {{fecha}}');
    expect(vars).toContain('nombre');
    expect(vars).toContain('fecha');
    expect(vars.length).toBe(2);
  });
  test('sin variables retorna array vacio', () => {
    expect(extractVariables('Hola sin variables')).toEqual([]);
  });
  test('variables duplicadas se deducan', () => {
    const vars = extractVariables('{{a}} y {{a}} de nuevo');
    expect(vars.length).toBe(1);
  });
  test('null/undefined retorna []', () => {
    expect(extractVariables(null)).toEqual([]);
    expect(extractVariables(undefined)).toEqual([]);
  });
});

describe('renderTemplate', () => {
  test('renderiza variables correctamente', () => {
    const result = renderTemplate('Hola {{nombre}}, bienvenido!', { nombre: 'Mariano' });
    expect(result).toBe('Hola Mariano, bienvenido!');
  });
  test('variable ausente → string vacio (non-strict)', () => {
    const result = renderTemplate('Hola {{nombre}}', {});
    expect(result).toBe('Hola ');
  });
  test('strict=true lanza error si falta variable', () => {
    expect(() => renderTemplate('Hola {{nombre}}', {}, { strict: true })).toThrow('Variables faltantes');
  });
  test('valor null → string vacio', () => {
    const result = renderTemplate('{{x}}', { x: null });
    expect(result).toBe('');
  });
  test('valor numero se convierte a string', () => {
    const result = renderTemplate('Numero: {{n}}', { n: 42 });
    expect(result).toBe('Numero: 42');
  });
  test('multiples variables', () => {
    const result = renderTemplate('{{a}} y {{b}}', { a: 'X', b: 'Y' });
    expect(result).toBe('X y Y');
  });
  test('lanza error si template no es string', () => {
    expect(() => renderTemplate(null, {})).toThrow('template requerido');
  });
});

describe('validateTemplate', () => {
  test('template valido', () => {
    const r = validateTemplate('Hola {{nombre}}');
    expect(r.valid).toBe(true);
    expect(r.variables).toContain('nombre');
  });
  test('template sin variables es valido', () => {
    const r = validateTemplate('Mensaje fijo');
    expect(r.valid).toBe(true);
  });
  test('template null es invalido', () => {
    const r = validateTemplate(null);
    expect(r.valid).toBe(false);
  });
  test('llaves desbalanceadas es invalido', () => {
    const r = validateTemplate('{{open sin cerrar');
    expect(r.valid).toBe(false);
  });
});
