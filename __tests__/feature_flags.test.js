'use strict';

const ff = require('../core/feature_flags');

const FLAG = 'MIIA_MODO_DEPORTE_ENABLED';

beforeEach(() => {
  for (const f of ff.FLAG_NAMES) delete process.env[f];
});
afterEach(() => {
  for (const f of ff.FLAG_NAMES) delete process.env[f];
});

describe('FLAG_NAMES', () => {
  test('frozen', () => { expect(() => { ff.FLAG_NAMES.push('x'); }).toThrow(); });
  test('contiene 4 flags', () => {
    expect(ff.FLAG_NAMES).toContain('MIIA_MODO_DEPORTE_ENABLED');
    expect(ff.FLAG_NAMES).toContain('PISO3_CATALOGO_ENABLED');
    expect(ff.FLAG_NAMES).toContain('PISO3_AUDIO_IN_ENABLED');
    expect(ff.FLAG_NAMES).toContain('PISO3_AUDIO_OUT_ENABLED');
  });
});

describe('isFlagEnabled', () => {
  test('flag undefined -> false', () => {
    expect(ff.isFlagEnabled(undefined)).toBe(false);
  });
  test('flag empty -> false', () => {
    expect(ff.isFlagEnabled('')).toBe(false);
  });
  test('flag no-string -> false', () => {
    expect(ff.isFlagEnabled(123)).toBe(false);
  });
  test('flag no en lista -> false', () => {
    expect(ff.isFlagEnabled('FAKE_FLAG')).toBe(false);
  });
  test('env var no seteada -> false', () => {
    expect(ff.isFlagEnabled(FLAG)).toBe(false);
  });
  test('"1" -> true', () => {
    process.env[FLAG] = '1';
    expect(ff.isFlagEnabled(FLAG)).toBe(true);
  });
  test('"true" -> true', () => {
    process.env[FLAG] = 'true';
    expect(ff.isFlagEnabled(FLAG)).toBe(true);
  });
  test('"on" -> true', () => {
    process.env[FLAG] = 'on';
    expect(ff.isFlagEnabled(FLAG)).toBe(true);
  });
  test('"yes" -> true', () => {
    process.env[FLAG] = 'yes';
    expect(ff.isFlagEnabled(FLAG)).toBe(true);
  });
  test('"TRUE" mayuscula -> true', () => {
    process.env[FLAG] = 'TRUE';
    expect(ff.isFlagEnabled(FLAG)).toBe(true);
  });
  test('"0" -> false', () => {
    process.env[FLAG] = '0';
    expect(ff.isFlagEnabled(FLAG)).toBe(false);
  });
  test('"false" -> false', () => {
    process.env[FLAG] = 'false';
    expect(ff.isFlagEnabled(FLAG)).toBe(false);
  });
  test('valor random -> false', () => {
    process.env[FLAG] = 'maybe';
    expect(ff.isFlagEnabled(FLAG)).toBe(false);
  });
});

describe('getAllFlags', () => {
  test('todos false por default', () => {
    const r = ff.getAllFlags();
    for (const f of ff.FLAG_NAMES) expect(r[f]).toBe(false);
  });
  test('parcialmente encendido', () => {
    process.env.PISO3_CATALOGO_ENABLED = '1';
    const r = ff.getAllFlags();
    expect(r.PISO3_CATALOGO_ENABLED).toBe(true);
    expect(r.PISO3_AUDIO_IN_ENABLED).toBe(false);
  });
});

describe('logFlagsState', () => {
  test('llama logger.info con state', () => {
    const calls = [];
    const logger = { info: (obj, msg) => calls.push({ obj, msg }) };
    ff.logFlagsState(logger);
    expect(calls.length).toBe(1);
    expect(calls[0].obj.all).toBeDefined();
    expect(Array.isArray(calls[0].obj.enabled)).toBe(true);
  });
  test('logger sin info no rompe', () => {
    expect(() => ff.logFlagsState({})).not.toThrow();
  });
  test('logger null no rompe', () => {
    expect(() => ff.logFlagsState(null)).not.toThrow();
  });
  test('retorna snapshot flags', () => {
    process.env.PISO3_CATALOGO_ENABLED = '1';
    const r = ff.logFlagsState();
    expect(r.PISO3_CATALOGO_ENABLED).toBe(true);
  });
});
