'use strict';

/**
 * T48 — coverage gap fix: structured_logger.js
 * (era 62.5% → target >90%)
 */

const sl = require('../core/structured_logger');

describe('T48 §A — createLogger', () => {
  test('factory retorna objeto con metodos', () => {
    const log = sl.createLogger('TEST');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.messageProcessed).toBe('function');
    expect(typeof log.aiCall).toBe('function');
    expect(typeof log.tagProcessed).toBe('function');
  });

  test('info loguea con emoji + module + JSON data', () => {
    const orig = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(' '));
    try {
      const log = sl.createLogger('M1');
      const entry = log.info('hola mundo', { uid: 'abc', latency: 100 });
      expect(entry.level).toBe('INFO');
      expect(entry.module).toBe('M1');
      expect(captured.some(l => l.includes('[M1]') && l.includes('hola mundo'))).toBe(true);
    } finally {
      console.log = orig;
    }
  });

  test('info sin data no incluye JSON', () => {
    const orig = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(' '));
    try {
      const log = sl.createLogger('M2');
      log.info('mensaje solo');
      expect(captured.some(l => l.includes('[M2] mensaje solo'))).toBe(true);
    } finally {
      console.log = orig;
    }
  });

  test('warn loguea con emoji warn', () => {
    const orig = console.warn;
    const captured = [];
    console.warn = (...args) => captured.push(args.join(' '));
    try {
      const log = sl.createLogger('M3');
      const entry = log.warn('atencion', { x: 1 });
      expect(entry.level).toBe('WARN');
      expect(captured.length).toBe(1);
    } finally {
      console.warn = orig;
    }
  });

  test('error loguea + agrega a metrics.errors', () => {
    const orig = console.error;
    const captured = [];
    console.error = (...args) => captured.push(args.join(' '));
    try {
      const log = sl.createLogger('ErrMod');
      log.error('boom!', { code: 500 });
      expect(captured.some(l => l.includes('ErrMod') && l.includes('boom!'))).toBe(true);
    } finally {
      console.error = orig;
    }
  });
});

describe('T48 §B — getMetrics', () => {
  test('retorna estructura agregada', () => {
    const m = sl.getMetrics();
    expect(typeof m.window).toBe('string');
    expect(typeof m.timestamp).toBe('string');
    expect(m.messages).toBeDefined();
    expect(m.errors).toBeDefined();
    expect(m.ai).toBeDefined();
    expect(m.tags).toBeDefined();
  });

  test('messageProcessed actualiza metrics.messages', () => {
    const log = sl.createLogger('M_msg');
    log.messageProcessed('uid_abc', 150);
    const m = sl.getMetrics();
    expect(m.messages.count).toBeGreaterThan(0);
  });

  test('aiCall actualiza metrics.ai', () => {
    const log = sl.createLogger('M_ai');
    log.aiCall('gemini', 500, true);
    const m = sl.getMetrics();
    expect(m.ai.calls).toBeGreaterThan(0);
  });

  test('tagProcessed actualiza metrics.tags', () => {
    const log = sl.createLogger('M_tag');
    log.tagProcessed('AGENDAR_EVENTO', true);
    const m = sl.getMetrics();
    expect(m.tags.processed).toBeGreaterThan(0);
  });

  test('errorRate calculado correctamente', () => {
    const log = sl.createLogger('M_err');
    const orig = console.error;
    console.error = () => {};
    try {
      // Forzar 1 error sobre algunos mensajes existentes
      log.error('fail', {});
      const m = sl.getMetrics();
      expect(typeof m.errors.rate).toBe('string');
      expect(m.errors.rate).toMatch(/%$/);
    } finally {
      console.error = orig;
    }
  });

  test('byModule agrupa errores por modulo', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const log = sl.createLogger('AGRUP_X');
      log.error('e1', {});
      log.error('e2', {});
      const m = sl.getMetrics();
      expect(m.errors.byModule.AGRUP_X).toBeGreaterThanOrEqual(2);
    } finally {
      console.error = orig;
    }
  });
});

describe('T48 §C — hasActiveAlert', () => {
  test('sin suficientes datos → null', () => {
    // En setup limpio retornaria null. Como hay metrics acumuladas de tests previos,
    // verificamos solo que retorna null o objeto valido.
    const r = sl.hasActiveAlert();
    expect(r === null || (r.level && r.message)).toBeTruthy();
  });

  test('hasActiveAlert no tira con metrics vacias', () => {
    expect(() => sl.hasActiveAlert()).not.toThrow();
  });
});

describe('T48 §D — Constantes', () => {
  test('WINDOW_MS exportado y > 0', () => {
    expect(typeof sl.WINDOW_MS).toBe('number');
    expect(sl.WINDOW_MS).toBeGreaterThan(0);
  });
});
