'use strict';
const { validateSchema, validate, SUPPORTED_TYPES } = require('../core/schema_validator');

describe('SUPPORTED_TYPES', () => {
  test('contiene tipos basicos', () => {
    expect(SUPPORTED_TYPES).toContain('string');
    expect(SUPPORTED_TYPES).toContain('number');
    expect(SUPPORTED_TYPES).toContain('boolean');
    expect(SUPPORTED_TYPES).toContain('object');
    expect(SUPPORTED_TYPES).toContain('array');
  });
});

describe('validate — tipo basico', () => {
  test('string valido', () => {
    expect(validate('hola', { type: 'string' }).valid).toBe(true);
  });
  test('numero donde se espera string = invalido', () => {
    const r = validate(42, { type: 'string' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('string'))).toBe(true);
  });
  test('boolean valido', () => {
    expect(validate(true, { type: 'boolean' }).valid).toBe(true);
  });
  test('array valido', () => {
    expect(validate([1,2], { type: 'array' }).valid).toBe(true);
  });
  test('null con tipo null = valido', () => {
    expect(validate(null, { type: 'null' }).valid).toBe(true);
  });
  test('multiples tipos aceptados', () => {
    expect(validate('str', { type: ['string', 'null'] }).valid).toBe(true);
    expect(validate(null, { type: ['string', 'null'] }).valid).toBe(true);
  });
});

describe('validate — string constraints', () => {
  test('minLength OK', () => {
    expect(validate('hola', { type: 'string', minLength: 2 }).valid).toBe(true);
  });
  test('minLength falla', () => {
    expect(validate('hi', { type: 'string', minLength: 5 }).valid).toBe(false);
  });
  test('maxLength OK', () => {
    expect(validate('hola', { type: 'string', maxLength: 10 }).valid).toBe(true);
  });
  test('maxLength falla', () => {
    expect(validate('hola mundo!', { type: 'string', maxLength: 5 }).valid).toBe(false);
  });
  test('enum valido', () => {
    expect(validate('es', { type: 'string', enum: ['es','en','pt'] }).valid).toBe(true);
  });
  test('enum invalido', () => {
    expect(validate('fr', { type: 'string', enum: ['es','en','pt'] }).valid).toBe(false);
  });
  test('pattern valido', () => {
    expect(validate('abc123', { type: 'string', pattern: '^[a-z0-9]+$' }).valid).toBe(true);
  });
  test('pattern invalido', () => {
    expect(validate('ABC', { type: 'string', pattern: '^[a-z]+$' }).valid).toBe(false);
  });
});

describe('validate — number constraints', () => {
  test('minimum OK', () => {
    expect(validate(5, { type: 'number', minimum: 1 }).valid).toBe(true);
  });
  test('minimum falla', () => {
    expect(validate(0, { type: 'number', minimum: 1 }).valid).toBe(false);
  });
  test('maximum falla', () => {
    expect(validate(101, { type: 'number', maximum: 100 }).valid).toBe(false);
  });
});

describe('validate — object', () => {
  const schema = {
    type: 'object',
    required: ['name', 'age'],
    properties: {
      name: { type: 'string', minLength: 1 },
      age: { type: 'number', minimum: 0 },
      email: { type: 'string' },
    }
  };

  test('objeto valido', () => {
    expect(validate({ name: 'Juan', age: 30 }, schema).valid).toBe(true);
  });
  test('campo requerido faltante = invalido', () => {
    const r = validate({ name: 'Juan' }, schema);
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('age'))).toBe(true);
  });
  test('tipo incorrecto en propiedad = invalido', () => {
    const r = validate({ name: 123, age: 30 }, schema);
    expect(r.valid).toBe(false);
  });
  test('additionalProperties false rechaza campo extra', () => {
    const s = { ...schema, additionalProperties: false };
    const r = validate({ name: 'Juan', age: 30, extra: true }, s);
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('extra'))).toBe(true);
  });
});

describe('validate — array', () => {
  test('array de strings valido', () => {
    expect(validate(['a','b','c'], { type: 'array', items: { type: 'string' } }).valid).toBe(true);
  });
  test('minItems falla', () => {
    expect(validate([], { type: 'array', minItems: 1 }).valid).toBe(false);
  });
  test('item con tipo incorrecto = invalido', () => {
    const r = validate(['a', 123], { type: 'array', items: { type: 'string' } });
    expect(r.valid).toBe(false);
  });
});
