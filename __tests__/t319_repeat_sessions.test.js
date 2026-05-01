'use strict';

const { InputRepeatTracker, DEFAULT_WINDOW_MS, MAX_REPEATS, SIMILARITY_THRESHOLD } = require('../core/input_repeat_tracker');
const { groupIntoSessions, calculateSessionMetrics, SESSION_GAP_MS } = require('../core/session_analytics');

const NOW = 1000000000000;
const MIN = 60 * 1000;

describe('T319 -- input_repeat_tracker + session_analytics (25 tests)', () => {

  // Constants
  test('DEFAULT_WINDOW_MS = 10min', () => {
    expect(DEFAULT_WINDOW_MS).toBe(10 * 60 * 1000);
  });

  test('MAX_REPEATS = 3', () => {
    expect(MAX_REPEATS).toBe(3);
  });

  test('SIMILARITY_THRESHOLD = 0.95', () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.95);
  });

  test('SESSION_GAP_MS = 30min', () => {
    expect(SESSION_GAP_MS).toBe(30 * 60 * 1000);
  });

  // InputRepeatTracker — constructor
  test('constructor: defaults correctos', () => {
    const t = new InputRepeatTracker();
    expect(t.windowMs).toBe(DEFAULT_WINDOW_MS);
    expect(t.maxRepeats).toBe(MAX_REPEATS);
    expect(t.threshold).toBe(SIMILARITY_THRESHOLD);
  });

  test('constructor: opciones custom', () => {
    const t = new InputRepeatTracker({ windowMs: 5000, maxRepeats: 2, threshold: 0.8 });
    expect(t.windowMs).toBe(5000);
    expect(t.maxRepeats).toBe(2);
  });

  // record — primer mensaje
  test('primer mensaje: isRepeat=false, count=0', () => {
    const t = new InputRepeatTracker();
    const r = t.record('+571111', 'hola', NOW);
    expect(r.isRepeat).toBe(false);
    expect(r.repeatCount).toBe(0);
    expect(r.shouldPause).toBe(false);
  });

  // record — sin phone lanza
  test('record sin phone lanza Error', () => {
    const t = new InputRepeatTracker();
    expect(() => t.record(null, 'texto', NOW)).toThrow();
  });

  // record — mensaje diferente reset
  test('mensaje diferente: reset count a 0', () => {
    const t = new InputRepeatTracker();
    t.record('+571111', 'hola', NOW);
    const r = t.record('+571111', 'texto completamente diferente', NOW + 1000);
    expect(r.isRepeat).toBe(false);
    expect(r.repeatCount).toBe(0);
  });

  // record — repeticion detectada
  test('mensaje identico: isRepeat=true', () => {
    const t = new InputRepeatTracker();
    t.record('+571111', 'hola mundo', NOW);
    const r = t.record('+571111', 'hola mundo', NOW + 1000);
    expect(r.isRepeat).toBe(true);
    expect(r.repeatCount).toBe(1);
  });

  // record — auto-pause despues de MAX_REPEATS
  test('3 repeticiones: shouldPause=true', () => {
    const t = new InputRepeatTracker({ maxRepeats: 3 });
    t.record('+572222', 'spam spam spam', NOW);
    t.record('+572222', 'spam spam spam', NOW + 500);
    t.record('+572222', 'spam spam spam', NOW + 1000);
    const r = t.record('+572222', 'spam spam spam', NOW + 1500);
    expect(r.shouldPause).toBe(true);
  });

  // record — pausa persiste
  test('pausado: record posterior retorna shouldPause=true', () => {
    const t = new InputRepeatTracker({ maxRepeats: 2 });
    t.record('+573333', 'loop', NOW);
    t.record('+573333', 'loop', NOW + 100);
    t.record('+573333', 'loop', NOW + 200); // pausa aqui
    const r = t.record('+573333', 'otro texto', NOW + 300);
    expect(r.shouldPause).toBe(true);
  });

  // record — ventana vencida reset
  test('ventana vencida: reset aunque sea texto similar', () => {
    const t = new InputRepeatTracker({ windowMs: 5000 });
    t.record('+574444', 'hola mundo', NOW);
    t.record('+574444', 'hola mundo', NOW + 1000);
    // 6 segundos despues: ventana vencida
    const r = t.record('+574444', 'hola mundo', NOW + 6000);
    expect(r.isRepeat).toBe(false);
    expect(r.repeatCount).toBe(0);
  });

  // unpause
  test('unpause: despeja pausa', () => {
    const t = new InputRepeatTracker({ maxRepeats: 2 });
    t.record('+575555', 'loop', NOW);
    t.record('+575555', 'loop', NOW + 100);
    t.record('+575555', 'loop', NOW + 200);
    t.unpause('+575555');
    const state = t.getState('+575555');
    expect(state.pausedAt).toBeNull();
    expect(state.repeatCount).toBe(0);
  });

  // getState / clear
  test('getState: null para phone desconocido', () => {
    const t = new InputRepeatTracker();
    expect(t.getState('+599999')).toBeNull();
  });

  test('clear: elimina estado', () => {
    const t = new InputRepeatTracker();
    t.record('+576666', 'hola', NOW);
    t.clear('+576666');
    expect(t.getState('+576666')).toBeNull();
  });

  // groupIntoSessions
  test('groupIntoSessions: lista vacia retorna []', () => {
    expect(groupIntoSessions([])).toEqual([]);
  });

  test('groupIntoSessions: mensajes sin timestamp se filtran', () => {
    const msgs = [{ text: 'a' }, { text: 'b' }];
    expect(groupIntoSessions(msgs)).toEqual([]);
  });

  test('groupIntoSessions: 3 msgs cercanos = 1 sesion', () => {
    const msgs = [
      { timestamp: NOW },
      { timestamp: NOW + 5 * MIN },
      { timestamp: NOW + 10 * MIN },
    ];
    const sessions = groupIntoSessions(msgs);
    expect(sessions.length).toBe(1);
    expect(sessions[0].length).toBe(3);
  });

  test('groupIntoSessions: gap > 30min = 2 sesiones', () => {
    const msgs = [
      { timestamp: NOW },
      { timestamp: NOW + 31 * MIN },
    ];
    const sessions = groupIntoSessions(msgs);
    expect(sessions.length).toBe(2);
  });

  test('groupIntoSessions: gap custom', () => {
    const msgs = [
      { timestamp: NOW },
      { timestamp: NOW + 6 * MIN },
    ];
    // gap custom de 5 min
    const sessions = groupIntoSessions(msgs, 5 * MIN);
    expect(sessions.length).toBe(2);
  });

  // calculateSessionMetrics
  test('calculateSessionMetrics: array vacio', () => {
    const r = calculateSessionMetrics([]);
    expect(r.sessionCount).toBe(0);
    expect(r.avgDurationMs).toBe(0);
  });

  test('calculateSessionMetrics: 1 sesion 1 msg (duracion=0)', () => {
    const msgs = [{ timestamp: NOW }];
    const r = calculateSessionMetrics(msgs);
    expect(r.sessionCount).toBe(1);
    expect(r.avgDurationMs).toBe(0);
    expect(r.avgMessagesPerSession).toBe(1);
  });

  test('calculateSessionMetrics: 1 sesion con duracion', () => {
    const msgs = [
      { timestamp: NOW },
      { timestamp: NOW + 10 * MIN },
      { timestamp: NOW + 20 * MIN },
    ];
    const r = calculateSessionMetrics(msgs);
    expect(r.sessionCount).toBe(1);
    expect(r.avgDurationMs).toBe(20 * MIN);
    expect(r.avgMessagesPerSession).toBe(3);
  });

  test('calculateSessionMetrics: 2 sesiones separadas', () => {
    const msgs = [
      { timestamp: NOW },
      { timestamp: NOW + 5 * MIN },
      { timestamp: NOW + 40 * MIN },
      { timestamp: NOW + 45 * MIN },
    ];
    const r = calculateSessionMetrics(msgs);
    expect(r.sessionCount).toBe(2);
    expect(r.avgMessagesPerSession).toBe(2);
  });

  test('calculateSessionMetrics: null retorna sessionCount=0', () => {
    const r = calculateSessionMetrics(null);
    expect(r.sessionCount).toBe(0);
  });
});
