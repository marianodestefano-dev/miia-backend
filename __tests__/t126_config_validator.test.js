'use strict';
const { validateTenantConfig, validateField, CONFIG_SCHEMA, VALID_TIMEZONES } = require('../core/config_validator');

describe('validateField', () => {
  test('campo requerido faltante retorna error', () => {
    const err = validateField('businessName', undefined, { type: 'string', required: true });
    expect(err).toMatch('requerido');
  });
  test('campo opcional faltante retorna null', () => {
    expect(validateField('language', undefined, { type: 'string', required: false })).toBeNull();
  });
  test('string sobre maxLength = error', () => {
    const err = validateField('businessName', 'x'.repeat(101), { type: 'string', maxLength: 100 });
    expect(err).toMatch('max 100 chars');
  });
  test('string con enum invalido = error', () => {
    const err = validateField('language', 'fr', { type: 'string', enum: ['es','en','pt'] });
    expect(err).toMatch('debe ser uno de');
  });
  test('numero fuera de rango = error', () => {
    const err = validateField('maxMessages', 2000, { type: 'number', max: 1000 });
    expect(err).toMatch('max 1000');
  });
  test('boolean no-boolean = error', () => {
    const err = validateField('autoReply', 'si', { type: 'boolean' });
    expect(err).toMatch('debe ser boolean');
  });
  test('array no-array = error', () => {
    const err = validateField('tags', 'string', { type: 'array' });
    expect(err).toMatch('debe ser array');
  });
  test('valor valido retorna null', () => {
    expect(validateField('language', 'es', { type: 'string', enum: ['es','en','pt'] })).toBeNull();
  });
});

describe('validateTenantConfig — inputs invalidos', () => {
  test('null retorna valid=false', () => {
    const r = validateTenantConfig(null);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
  test('array retorna valid=false', () => {
    expect(validateTenantConfig([])).toMatchObject({ valid: false });
  });
});

describe('validateTenantConfig — config minima valida', () => {
  test('con businessName + timezone = valido', () => {
    const r = validateTenantConfig({ businessName: 'Mi Negocio', timezone: 'America/Bogota' });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
  test('defaults aplicados en normalized', () => {
    const r = validateTenantConfig({ businessName: 'Test', timezone: 'UTC' });
    expect(r.normalized.language).toBe('es');
    expect(r.normalized.autoReply).toBe(true);
    expect(r.normalized.maxMessagesPerHour).toBe(50);
  });
});

describe('validateTenantConfig — errores', () => {
  test('businessName faltante = error', () => {
    const r = validateTenantConfig({ timezone: 'UTC' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('businessName'))).toBe(true);
  });
  test('timezone faltante = error', () => {
    const r = validateTenantConfig({ businessName: 'Test' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('timezone'))).toBe(true);
  });
  test('language invalido = error', () => {
    const r = validateTenantConfig({ businessName: 'Test', timezone: 'UTC', language: 'fr' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('language'))).toBe(true);
  });
  test('maxMessagesPerHour fuera de rango = error', () => {
    const r = validateTenantConfig({ businessName: 'Test', timezone: 'UTC', maxMessagesPerHour: 9999 });
    expect(r.valid).toBe(false);
  });
});

describe('validateTenantConfig — warnings', () => {
  test('timezone desconocido genera warning (no error)', () => {
    const r = validateTenantConfig({ businessName: 'Test', timezone: 'America/CustomCity' });
    expect(r.valid).toBe(true);
    expect(r.warnings.some(w => w.includes('timezone desconocido'))).toBe(true);
  });
  test('campo desconocido genera warning', () => {
    const r = validateTenantConfig({ businessName: 'Test', timezone: 'UTC', campoRaro: true });
    expect(r.warnings.some(w => w.includes('campoRaro'))).toBe(true);
  });
});

describe('CONFIG_SCHEMA y VALID_TIMEZONES', () => {
  test('schema tiene businessName y timezone como required', () => {
    expect(CONFIG_SCHEMA.businessName.required).toBe(true);
    expect(CONFIG_SCHEMA.timezone.required).toBe(true);
  });
  test('VALID_TIMEZONES incluye zonas de LATAM', () => {
    expect(VALID_TIMEZONES).toContain('America/Bogota');
    expect(VALID_TIMEZONES).toContain('America/Argentina/Buenos_Aires');
  });
});
