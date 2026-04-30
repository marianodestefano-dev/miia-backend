'use strict';

/**
 * T59 — constants registry tests + paridad con valores actuales hot paths
 */

const C = require('../lib/config/constants');

describe('T59 §A — constants registry shape + frozen', () => {
  test('exporta todas las categorias esperadas', () => {
    expect(C.AI).toBeDefined();
    expect(C.RATE_LIMIT).toBeDefined();
    expect(C.LOOP_WATCHER).toBeDefined();
    expect(C.HUMAN_DELAY).toBeDefined();
    expect(C.VALIDATOR).toBeDefined();
    expect(C.METRICS).toBeDefined();
    expect(C.AUDIT).toBeDefined();
    expect(C.HEALTH).toBeDefined();
    expect(C.TIMEZONE_DEFAULT).toBe('America/Bogota');
  });

  test('AI frozen — no se puede mutar', () => {
    expect(Object.isFrozen(C.AI)).toBe(true);
    expect(() => { 'use strict'; C.AI.FETCH_TIMEOUT_MS = 999; }).toThrow();
  });

  test('RATE_LIMIT frozen', () => {
    expect(Object.isFrozen(C.RATE_LIMIT)).toBe(true);
  });

  test('todos los frozen sub-objetos', () => {
    expect(Object.isFrozen(C.LOOP_WATCHER)).toBe(true);
    expect(Object.isFrozen(C.HUMAN_DELAY)).toBe(true);
    expect(Object.isFrozen(C.VALIDATOR)).toBe(true);
    expect(Object.isFrozen(C.METRICS)).toBe(true);
    expect(Object.isFrozen(C.AUDIT)).toBe(true);
    expect(Object.isFrozen(C.HEALTH)).toBe(true);
  });
});

describe('T59 §B — paridad valores actuales hot paths', () => {
  test('AI.FETCH_TIMEOUT_MS = 45000', () => {
    expect(C.AI.FETCH_TIMEOUT_MS).toBe(45000);
  });
  test('AI.RETRY_DELAYS_MS frozen array', () => {
    expect(Array.isArray(C.AI.RETRY_DELAYS_MS)).toBe(true);
    expect(Object.isFrozen(C.AI.RETRY_DELAYS_MS)).toBe(true);
    expect(C.AI.RETRY_DELAYS_MS.length).toBe(3);
  });
  test('AI.DEFAULT_MODEL gemini-2.5-flash (paridad gemini_client.js)', () => {
    expect(C.AI.DEFAULT_MODEL).toBe('gemini-2.5-flash');
  });
  test('LOOP_WATCHER.THRESHOLD = 10 (paridad loop_watcher.js)', () => {
    const lw = require('../core/loop_watcher');
    expect(C.LOOP_WATCHER.THRESHOLD).toBe(lw.LOOP_THRESHOLD);
  });
  test('LOOP_WATCHER.WINDOW_MS = 30000 (paridad loop_watcher.js)', () => {
    const lw = require('../core/loop_watcher');
    expect(C.LOOP_WATCHER.WINDOW_MS).toBe(lw.LOOP_WINDOW_MS);
  });
  test('VALIDATOR.MAX_MESSAGE_LENGTH = 4000 (paridad miia_validator.js)', () => {
    const v = require('../core/miia_validator');
    expect(C.VALIDATOR.MAX_MESSAGE_LENGTH).toBe(v.MAX_MESSAGE_LENGTH);
  });
  test('METRICS.ROLLING_WINDOW_MS = 5min (paridad structured_logger + tenant_metrics)', () => {
    const sl = require('../core/structured_logger');
    const tm = require('../core/tenant_metrics');
    expect(C.METRICS.ROLLING_WINDOW_MS).toBe(sl.WINDOW_MS);
    expect(C.METRICS.ROLLING_WINDOW_MS).toBe(tm.WINDOW_MS);
  });
});

describe('T59 §C — RATE_LIMIT thresholds escalados', () => {
  test('GREEN < YELLOW < ORANGE < RED < STOP', () => {
    expect(C.RATE_LIMIT.GREEN_THRESHOLD).toBeLessThan(C.RATE_LIMIT.YELLOW_THRESHOLD);
    expect(C.RATE_LIMIT.YELLOW_THRESHOLD).toBeLessThan(C.RATE_LIMIT.ORANGE_THRESHOLD);
    expect(C.RATE_LIMIT.ORANGE_THRESHOLD).toBeLessThan(C.RATE_LIMIT.RED_THRESHOLD);
    expect(C.RATE_LIMIT.RED_THRESHOLD).toBeLessThan(C.RATE_LIMIT.STOP_THRESHOLD);
  });
  test('CONTACT_LIMIT_FAMILY > CONTACT_LIMIT_DEFAULT (familia raja mas)', () => {
    expect(C.RATE_LIMIT.CONTACT_LIMIT_FAMILY).toBeGreaterThan(C.RATE_LIMIT.CONTACT_LIMIT_DEFAULT);
  });
});

describe('T59 §D — HEALTH severity ladder', () => {
  test('severity ordenada', () => {
    expect(C.HEALTH.SEVERITY.OK).toBeLessThan(C.HEALTH.SEVERITY.UNKNOWN);
    expect(C.HEALTH.SEVERITY.UNKNOWN).toBeLessThan(C.HEALTH.SEVERITY.DEGRADED);
    expect(C.HEALTH.SEVERITY.DEGRADED).toBeLessThan(C.HEALTH.SEVERITY.CRITICAL);
    expect(C.HEALTH.SEVERITY.CRITICAL).toBeLessThan(C.HEALTH.SEVERITY.ERROR);
  });
  test('severity frozen', () => {
    expect(Object.isFrozen(C.HEALTH.SEVERITY)).toBe(true);
  });
  test('TENANT_OK_RATIO 0.9, DEGRADED 0.5', () => {
    expect(C.HEALTH.TENANT_OK_RATIO).toBe(0.9);
    expect(C.HEALTH.TENANT_DEGRADED_RATIO).toBe(0.5);
  });
});

describe('T59 §E — HUMAN_DELAY caps logicos', () => {
  test('TYPING_MIN_MS < TYPING_MAX_MS', () => {
    expect(C.HUMAN_DELAY.TYPING_MIN_MS).toBeLessThan(C.HUMAN_DELAY.TYPING_MAX_MS);
  });
  test('OWNER_MAX_MS < GENERIC_MAX_MS', () => {
    expect(C.HUMAN_DELAY.OWNER_MAX_MS).toBeLessThan(C.HUMAN_DELAY.GENERIC_MAX_MS);
  });
  test('OWNER_TYPING_MULTIPLIER < 1 (owner mas rapido)', () => {
    expect(C.HUMAN_DELAY.OWNER_TYPING_MULTIPLIER).toBeLessThan(1);
  });
  test('NIGHT_MULTIPLIER_MIN < NIGHT_MULTIPLIER_MAX', () => {
    expect(C.HUMAN_DELAY.NIGHT_MULTIPLIER_MIN).toBeLessThan(C.HUMAN_DELAY.NIGHT_MULTIPLIER_MAX);
  });
});

describe('T59 §F — AUDIT defaults', () => {
  test('BUFFER_SIZE positivo', () => {
    expect(C.AUDIT.BUFFER_SIZE).toBeGreaterThan(0);
  });
  test('GENESIS_HASH 64 chars hex', () => {
    expect(C.AUDIT.GENESIS_HASH.length).toBe(64);
    expect(C.AUDIT.GENESIS_HASH).toMatch(/^0+$/);
  });
});

describe('T59 §G — sentry sample rates', () => {
  test('SENTRY_TRACES_SAMPLE entre 0 y 1', () => {
    expect(C.AI.SENTRY_TRACES_SAMPLE).toBeGreaterThan(0);
    expect(C.AI.SENTRY_TRACES_SAMPLE).toBeLessThanOrEqual(1);
  });
  test('SENTRY_PROFILES_SAMPLE entre 0 y 1', () => {
    expect(C.AI.SENTRY_PROFILES_SAMPLE).toBeGreaterThan(0);
    expect(C.AI.SENTRY_PROFILES_SAMPLE).toBeLessThanOrEqual(1);
  });
});
