'use strict';

const {
  maskPhone, maskEmail, truncateMessage,
  sanitizePhones, sanitizeEmails, sanitizeTokens, sanitizeCards,
  sanitizeText, sanitizeObject, createSafeLogger, isVerboseMode,
  PHONE_MASK_KEEP, DEFAULT_MAX_MESSAGE_LENGTH, VERBOSE_ENV_KEY,
} = require('../core/log_sanitizer');

beforeEach(() => { delete process.env[VERBOSE_ENV_KEY]; });
afterEach(() => { delete process.env[VERBOSE_ENV_KEY]; });

describe('Constantes', () => {
  test('PHONE_MASK_KEEP es 4', () => { expect(PHONE_MASK_KEEP).toBe(4); });
  test('DEFAULT_MAX_MESSAGE_LENGTH es 200', () => { expect(DEFAULT_MAX_MESSAGE_LENGTH).toBe(200); });
  test('VERBOSE_ENV_KEY es correcto', () => { expect(VERBOSE_ENV_KEY).toBe('MIIA_DEBUG_VERBOSE'); });
});

describe('isVerboseMode', () => {
  test('retorna false por default', () => { expect(isVerboseMode()).toBe(false); });
  test('retorna true con MIIA_DEBUG_VERBOSE=1', () => {
    process.env[VERBOSE_ENV_KEY] = '1';
    expect(isVerboseMode()).toBe(true);
  });
  test('retorna false con otros valores', () => {
    process.env[VERBOSE_ENV_KEY] = '0';
    expect(isVerboseMode()).toBe(false);
  });
});

describe('maskPhone', () => {
  test('enmascara numero largo', () => {
    const r = maskPhone('+541155667788');
    expect(r).toBe('****7788');
    expect(r).not.toContain('5411');
  });
  test('retorna null si input null', () => { expect(maskPhone(null)).toBeNull(); });
  test('devuelve **** para numeros cortos', () => { expect(maskPhone('1234')).toBe('****'); });
});

describe('maskEmail', () => {
  test('enmascara local part', () => {
    const r = maskEmail('mariano@miia-app.com');
    expect(r).toContain('@miia-app.com');
    expect(r).not.toContain('mariano');
  });
  test('retorna null si null', () => { expect(maskEmail(null)).toBeNull(); });
  test('maneja email sin @', () => {
    const r = maskEmail('noatemail');
    expect(r).toContain('****');
  });
});

describe('truncateMessage', () => {
  test('no trunca si es corto', () => {
    const r = truncateMessage('Hola', 200);
    expect(r).toBe('Hola');
  });
  test('trunca si supera maxLen', () => {
    const long = 'a'.repeat(300);
    const r = truncateMessage(long, 200);
    expect(r.length).toBeLessThan(long.length);
    expect(r).toContain('truncado');
  });
  test('usa DEFAULT_MAX_MESSAGE_LENGTH si no se especifica', () => {
    const long = 'b'.repeat(300);
    const r = truncateMessage(long);
    expect(r).toContain('truncado');
  });
  test('retorna null si null', () => { expect(truncateMessage(null)).toBeNull(); });
});

describe('sanitizePhones', () => {
  test('enmascara telefono en texto', () => {
    const r = sanitizePhones('Llamar a +541155667788 urgente');
    expect(r).not.toContain('541155');
    expect(r).toContain('7788');
  });
  test('no modifica texto sin telefono', () => {
    const r = sanitizePhones('hola como estas');
    expect(r).toBe('hola como estas');
  });
  test('retorna input si no es string', () => {
    expect(sanitizePhones(null)).toBeNull();
    expect(sanitizePhones(42)).toBe(42);
  });
});

describe('sanitizeEmails', () => {
  test('enmascara email en texto', () => {
    const r = sanitizeEmails('Contacto: mariano@miia-app.com hoy');
    expect(r).not.toContain('mariano@');
    expect(r).toContain('@miia-app.com');
  });
  test('no modifica texto sin email', () => {
    expect(sanitizeEmails('sin email aqui')).toBe('sin email aqui');
  });
});

describe('sanitizeTokens', () => {
  test('enmascara Bearer token', () => {
    const r = sanitizeTokens('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9');
    expect(r).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(r).toContain('****');
  });
  test('no modifica texto sin token', () => {
    expect(sanitizeTokens('hola mundo')).toBe('hola mundo');
  });
});

describe('sanitizeCards', () => {
  test('enmascara numero de tarjeta', () => {
    const r = sanitizeCards('Tarjeta: 4111-1111-1111-1111');
    expect(r).not.toContain('4111-1111-1111-1111');
    expect(r).toContain('****-****-****-****');
  });
  test('no modifica si no hay tarjeta', () => {
    expect(sanitizeCards('sin tarjeta')).toBe('sin tarjeta');
  });
});

describe('sanitizeText', () => {
  test('aplica todos los filtros', () => {
    const text = 'Lead +541155667788 email test@test.com token: Bearer abc12345678';
    const r = sanitizeText(text);
    expect(r).not.toContain('541155');
    expect(r).not.toContain('test@test');
    expect(r).not.toContain('abc12345678');
  });
  test('retorna sin cambios en modo verbose', () => {
    process.env[VERBOSE_ENV_KEY] = '1';
    const text = 'Lead +541155667788';
    expect(sanitizeText(text)).toBe(text);
  });
  test('trunca por default', () => {
    const long = 'x'.repeat(300);
    expect(sanitizeText(long)).toContain('truncado');
  });
  test('no trunca si truncate=false', () => {
    const long = 'x'.repeat(300);
    const r = sanitizeText(long, { truncate: false });
    expect(r.length).toBe(300);
  });
});

describe('sanitizeObject', () => {
  test('enmascara campo phone en objeto', () => {
    const obj = { phone: '+541155667788', name: 'Juan' };
    const r = sanitizeObject(obj);
    expect(r.phone).not.toContain('5411');
    expect(r.name).toBe('Juan');
  });
  test('enmascara campo email en objeto', () => {
    const obj = { email: 'mariano@miia-app.com' };
    const r = sanitizeObject(obj);
    expect(r.email).not.toContain('mariano@');
  });
  test('recursivo en objetos anidados', () => {
    const obj = { user: { phone: '+541155667788' } };
    const r = sanitizeObject(obj);
    expect(r.user.phone).not.toContain('5411');
  });
  test('retorna obj sin cambios en modo verbose', () => {
    process.env[VERBOSE_ENV_KEY] = '1';
    const obj = { phone: '+541155667788' };
    expect(sanitizeObject(obj).phone).toBe('+541155667788');
  });
  test('retorna input si no es objeto', () => {
    expect(sanitizeObject(null)).toBeNull();
    expect(sanitizeObject('texto')).toBe('texto');
  });
  test('maneja arrays', () => {
    const arr = [{ phone: '+541155667788' }];
    const r = sanitizeObject(arr);
    expect(Array.isArray(r)).toBe(true);
    expect(r[0].phone).not.toContain('5411');
  });
});

describe('createSafeLogger', () => {
  test('crea logger con metodos log/warn/error', () => {
    const logger = createSafeLogger('TEST');
    expect(typeof logger.log).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
  test('no lanza al llamar log/warn/error', () => {
    const logger = createSafeLogger('TEST');
    expect(() => logger.log('Mensaje con +541155667788')).not.toThrow();
    expect(() => logger.warn('Advertencia')).not.toThrow();
    expect(() => logger.error('Error', { phone: '+541155667788' })).not.toThrow();
  });
});
