'use strict';
const { InputRepeatTracker, DEFAULT_WINDOW_MS, MAX_REPEATS, SIMILARITY_THRESHOLD } = require('../core/input_repeat_tracker');

describe('InputRepeatTracker — constantes', () => {
  test('DEFAULT_WINDOW_MS = 10 minutos', () => {
    expect(DEFAULT_WINDOW_MS).toBe(10 * 60 * 1000);
  });
  test('MAX_REPEATS = 3', () => {
    expect(MAX_REPEATS).toBe(3);
  });
  test('SIMILARITY_THRESHOLD = 0.95', () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.95);
  });
});

describe('InputRepeatTracker — validacion inputs', () => {
  test('lanza error si phone es undefined', () => {
    const t = new InputRepeatTracker();
    expect(() => t.record(undefined, 'hola')).toThrow('phone requerido');
  });
  test('retorna isRepeat=false si text es vacio', () => {
    const t = new InputRepeatTracker();
    const r = t.record('+573001', '');
    expect(r.isRepeat).toBe(false);
    expect(r.shouldPause).toBe(false);
  });
});

describe('InputRepeatTracker — primer mensaje', () => {
  test('primer mensaje nunca es repeat', () => {
    const t = new InputRepeatTracker();
    const r = t.record('+573001', 'Hola, quiero info');
    expect(r.isRepeat).toBe(false);
    expect(r.repeatCount).toBe(0);
    expect(r.shouldPause).toBe(false);
  });
});

describe('InputRepeatTracker — deteccion de repeat', () => {
  test('mensaje identico dentro de ventana = isRepeat true', () => {
    const t = new InputRepeatTracker({ windowMs: 60000 });
    t.record('+573001', 'Hola necesito ayuda', 1000);
    const r = t.record('+573001', 'Hola necesito ayuda', 2000);
    expect(r.isRepeat).toBe(true);
    expect(r.repeatCount).toBe(1);
  });

  test('mensaje muy diferente = isRepeat false, reset count', () => {
    const t = new InputRepeatTracker({ windowMs: 60000 });
    t.record('+573001', 'Hola necesito ayuda', 1000);
    t.record('+573001', 'Hola necesito ayuda', 2000);
    const r = t.record('+573001', 'Quiero cancelar mi suscripcion', 3000);
    expect(r.isRepeat).toBe(false);
    expect(r.repeatCount).toBe(0);
  });

  test('despues de ventana vencida, reset aunque sea identico', () => {
    const t = new InputRepeatTracker({ windowMs: 5000 });
    t.record('+573001', 'Hola', 0);
    const r = t.record('+573001', 'Hola', 6000); // 6s > 5s window
    expect(r.isRepeat).toBe(false);
    expect(r.repeatCount).toBe(0);
  });

  test('shouldPause = true despues de maxRepeats', () => {
    const t = new InputRepeatTracker({ windowMs: 60000, maxRepeats: 3 });
    const txt = 'Hola necesito ayuda urgente';
    t.record('+573002', txt, 1000);
    t.record('+573002', txt, 2000); // repeat 1
    t.record('+573002', txt, 3000); // repeat 2
    const r = t.record('+573002', txt, 4000); // repeat 3 => pause
    expect(r.shouldPause).toBe(true);
    expect(r.repeatCount).toBe(3);
  });

  test('estado pausado persiste en llamadas siguientes', () => {
    const t = new InputRepeatTracker({ windowMs: 60000, maxRepeats: 2 });
    const txt = 'Quiero el precio';
    t.record('+573003', txt, 1000);
    t.record('+573003', txt, 2000); // repeat 1
    t.record('+573003', txt, 3000); // repeat 2 => pause
    const r = t.record('+573003', 'Otro mensaje completamente diferente', 4000);
    expect(r.shouldPause).toBe(true); // sigue pausado
  });
});

describe('InputRepeatTracker — unpause', () => {
  test('unpause limpia pausa y resetea count', () => {
    const t = new InputRepeatTracker({ windowMs: 60000, maxRepeats: 2 });
    const txt = 'Cuanto cuesta';
    t.record('+573004', txt, 1000);
    t.record('+573004', txt, 2000);
    t.record('+573004', txt, 3000); // pause
    t.unpause('+573004');
    const state = t.getState('+573004');
    expect(state.pausedAt).toBeNull();
    expect(state.repeatCount).toBe(0);
  });
  test('unpause lanza error si phone es falsy', () => {
    const t = new InputRepeatTracker();
    expect(() => t.unpause('')).toThrow('phone requerido');
  });
});

describe('InputRepeatTracker — getState y clear', () => {
  test('getState retorna null si phone no fue registrado', () => {
    const t = new InputRepeatTracker();
    expect(t.getState('+999')).toBeNull();
  });
  test('clear elimina estado del phone', () => {
    const t = new InputRepeatTracker();
    t.record('+573005', 'algo', 1000);
    t.clear('+573005');
    expect(t.getState('+573005')).toBeNull();
  });
});
