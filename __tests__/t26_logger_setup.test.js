'use strict';

/**
 * Tests: T26 — Pino logger setup minimo (Fase 0).
 *
 * Origen: T18 propuesta logger. Wi firmo T26 mail [163] — "Implementar
 * Pino logger setup minimo (Fase 0): npm i pino + crear core/logger.js
 * wrapper minimalista. NO migrar call sites todavia."
 *
 * §A — Tests estaticos sobre source core/logger.js.
 * §B — Tests runtime: API minima + child + metadata baseline.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LOGGER_PATH = path.resolve(__dirname, '../core/logger.js');
const LOGGER_SOURCE = fs.readFileSync(LOGGER_PATH, 'utf8');

// ════════════════════════════════════════════════════════════════════
// §A — Verificacion estatica de source core/logger.js
// ════════════════════════════════════════════════════════════════════

describe('T26 §A — core/logger.js setup base', () => {
  test('A.1 — comentario T26-IMPLEMENT presente', () => {
    expect(LOGGER_SOURCE).toMatch(/T26-IMPLEMENT/);
  });

  test('A.2 — require pino', () => {
    expect(LOGGER_SOURCE).toMatch(/require\(['"]pino['"]\)/);
  });

  test('A.3 — config metadata baseline (service, env, version)', () => {
    expect(LOGGER_SOURCE).toMatch(/SERVICE_NAME\s*=\s*['"]miia-backend['"]/);
    expect(LOGGER_SOURCE).toMatch(/NODE_ENV/);
    expect(LOGGER_SOURCE).toMatch(/PKG_VERSION/);
  });

  test('A.4 — niveles estandar pino exportados', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      const re = new RegExp(`${level}:\\s*\\(\\.\\.\\.args\\)\\s*=>\\s*_logger\\.${level}`);
      expect(LOGGER_SOURCE).toMatch(re);
    }
  });

  test('A.5 — child logger function expuesta', () => {
    expect(LOGGER_SOURCE).toMatch(/function child\(bindings\)/);
    expect(LOGGER_SOURCE).toMatch(/return _logger\.child\(bindings/);
  });

  test('A.6 — flushSync function expuesta (SIGTERM defensive)', () => {
    expect(LOGGER_SOURCE).toMatch(/function flushSync/);
    expect(LOGGER_SOURCE).toMatch(/_logger\.flush/);
  });

  test('A.7 — module.exports incluye logger + flushSync + child', () => {
    expect(LOGGER_SOURCE).toMatch(/module\.exports\s*=\s*logger/);
    expect(LOGGER_SOURCE).toMatch(/module\.exports\.flushSync\s*=\s*flushSync/);
    expect(LOGGER_SOURCE).toMatch(/module\.exports\.child\s*=\s*child/);
  });

  test('A.8 — MIIA_LOG_LEVEL env var soportada', () => {
    expect(LOGGER_SOURCE).toMatch(/MIIA_LOG_LEVEL/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — Tests runtime: API minima funcional
// ════════════════════════════════════════════════════════════════════

describe('T26 §B — logger runtime API', () => {
  let logger;

  beforeAll(() => {
    logger = require('../core/logger');
  });

  test('B.1 — logger expone trace, debug, info, warn, error, fatal', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      expect(typeof logger[level]).toBe('function');
    }
  });

  test('B.2 — logger.info no throw con string simple', () => {
    expect(() => logger.info('test mensaje T26')).not.toThrow();
  });

  test('B.3 — logger.info no throw con metadata + mensaje', () => {
    expect(() => logger.info({ uid: 'abc', extra: 1 }, 'test con meta')).not.toThrow();
  });

  test('B.4 — logger.error acepta Error object', () => {
    expect(() => logger.error(new Error('test error T26'))).not.toThrow();
  });

  test('B.5 — child(bindings) retorna nuevo logger', () => {
    const childLog = logger.child({ component: 'test' });
    expect(typeof childLog.info).toBe('function');
    expect(typeof childLog.error).toBe('function');
    expect(() => childLog.info('test child')).not.toThrow();
  });

  test('B.6 — config baseline expuesta para tests', () => {
    expect(logger._config).toBeDefined();
    expect(logger._config.SERVICE_NAME).toBe('miia-backend');
    expect(logger._config.BASELINE_META.service).toBe('miia-backend');
    expect(['development', 'production', 'test']).toContain(logger._config.NODE_ENV);
  });

  test('B.7 — flushSync no throw', () => {
    expect(() => logger.flushSync()).not.toThrow();
  });

  test('B.8 — _pino interno expuesto para tests', () => {
    expect(logger._pino).toBeDefined();
    expect(typeof logger._pino.info).toBe('function');
  });
});
