'use strict';

/**
 * EXTRA #4.c — Test integracion core/logger.js sanitize.
 *
 * Valida que logger.info/warn/error con PII apliquen sanitizer en produccion
 * y sean no-op en dev/verbose. Cubre el wire-in real de EXTRA #1 + #4.c.
 */

function withEnv(overrides, fn) {
  const backup = {};
  for (const k of Object.keys(overrides)) {
    backup[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(backup)) {
      if (backup[k] === undefined) delete process.env[k];
      else process.env[k] = backup[k];
    }
  }
}

describe('logger.js integracion sanitizer (EXTRA #4.c)', () => {
  let logger;
  beforeAll(() => {
    logger = require('../core/logger');
  });

  test('_sanitizeArgs en production sanitiza strings con phone', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined }, () => {
      const args = ['owner +573054169969 logged in'];
      const sanitized = logger._sanitizeArgs(args);
      expect(sanitized[0]).toContain('+57***9969');
      expect(sanitized[0]).not.toContain('573054169969');
    });
  });

  test('_sanitizeArgs en dev pasa tal cual', () => {
    withEnv({ NODE_ENV: 'development', MIIA_DEBUG_VERBOSE: undefined }, () => {
      const args = ['owner +573054169969 logged in'];
      const sanitized = logger._sanitizeArgs(args);
      expect(sanitized[0]).toBe('owner +573054169969 logged in');
    });
  });

  test('_sanitizeArgs verbose flag pasa tal cual', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: 'true' }, () => {
      const args = ['phone +573054169969'];
      const sanitized = logger._sanitizeArgs(args);
      expect(sanitized[0]).toBe('phone +573054169969');
    });
  });

  test('_sanitizeArgs aplica sanitizeObject a objetos plain', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined }, () => {
      const args = [{ phone: '+573054169969', name: 'X' }];
      const sanitized = logger._sanitizeArgs(args);
      expect(sanitized[0].phone).toContain('+57***9969');
    });
  });

  test('_sanitizeArgs NO sanitiza instancias de Error (pino las serializa)', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined }, () => {
      const err = new Error('test +573054169969 in error msg');
      const args = [err];
      const sanitized = logger._sanitizeArgs(args);
      // Error queda intacto (pino lo serializa)
      expect(sanitized[0]).toBe(err);
    });
  });

  test('_sanitizeArgs preserva tipos primitivos (number, boolean)', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined }, () => {
      const args = [42, true, null, undefined];
      const sanitized = logger._sanitizeArgs(args);
      expect(sanitized).toEqual([42, true, null, undefined]);
    });
  });

  test('logger.info no rompe con string puro en produccion', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined }, () => {
      // No expectativa de output (pino escribe a stdout); solo verificar no-throw
      expect(() => logger.info('lead +573054169969 escribio')).not.toThrow();
    });
  });

  test('logger.warn / .error / .debug / .trace / .fatal aceptan args sanitizados', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined }, () => {
      expect(() => logger.warn('w +573054169969')).not.toThrow();
      expect(() => logger.error('e +573054169969')).not.toThrow();
      expect(() => logger.debug('d +573054169969')).not.toThrow();
      expect(() => logger.trace('t +573054169969')).not.toThrow();
      expect(() => logger.fatal('f +573054169969')).not.toThrow();
    });
  });
});
