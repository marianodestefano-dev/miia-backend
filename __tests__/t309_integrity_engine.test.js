'use strict';

/**
 * T309 -- integrity_engine unit tests (25/25)
 */

const {
  attemptAutoRepair,
  getIntegrityStats,
  startIntegrityEngine,
  stopIntegrityEngine,
  verifyCalendarEvent,
  PROMISE_PATTERNS,
  PREFERENCE_PATTERNS,
} = require('../core/integrity_engine');

describe('T309 -- integrity_engine (25 tests)', () => {

  afterEach(() => {
    stopIntegrityEngine(); // Limpiar si arranq
  });

  // PROMISE_PATTERNS

  test('PROMISE_PATTERNS: es array de objetos con pattern, action, tag', () => {
    expect(Array.isArray(PROMISE_PATTERNS)).toBe(true);
    expect(PROMISE_PATTERNS.length).toBeGreaterThan(0);
    PROMISE_PATTERNS.forEach(p => {
      expect(p.pattern).toBeInstanceOf(RegExp);
      expect(typeof p.action).toBe('string');
      expect(typeof p.tag).toBe('string');
    });
  });

  test('PROMISE_PATTERNS: detecta promesa de agenda ("te agendé")', () => {
    const msg = 'te agendé la reunion para el viernes';
    const match = PROMISE_PATTERNS.some(p => p.pattern.test(msg));
    expect(match).toBe(true);
    const p = PROMISE_PATTERNS.find(p => p.pattern.test(msg));
    expect(p.action).toBe('agendar');
  });

  test('PROMISE_PATTERNS: detecta promesa de email ("te mandé el mail")', () => {
    const msg = 'te mandé el mail con los detalles';
    const match = PROMISE_PATTERNS.some(p => p.pattern.test(msg));
    expect(match).toBe(true);
    const p = PROMISE_PATTERNS.find(p => p.pattern.test(msg));
    expect(p.action).toBe('email');
  });

  test('PROMISE_PATTERNS: detecta promesa de recordatorio ("te recuerdo")', () => {
    const msg = 'te recuerdo mañana a las 9';
    const match = PROMISE_PATTERNS.some(p => p.pattern.test(msg));
    expect(match).toBe(true);
    const p = PROMISE_PATTERNS.find(p => p.pattern.test(msg));
    expect(p.action).toBe('recordar');
  });

  test('PROMISE_PATTERNS: detecta cancelacion ("ya cancelé")', () => {
    const msg = 'ya cancelé la reunion del lunes';
    const match = PROMISE_PATTERNS.some(p => p.pattern.test(msg));
    expect(match).toBe(true);
    const p = PROMISE_PATTERNS.find(p => p.pattern.test(msg));
    expect(p.action).toBe('cancelar');
  });

  test('PROMISE_PATTERNS: detecta mover evento ("ya moví")', () => {
    const msg = 'ya moví la reunion para el jueves';
    const match = PROMISE_PATTERNS.some(p => p.pattern.test(msg));
    expect(match).toBe(true);
    const p = PROMISE_PATTERNS.find(p => p.pattern.test(msg));
    expect(p.action).toBe('mover');
  });

  test('PROMISE_PATTERNS: mensaje neutral no matchea ninguna promesa', () => {
    const msg = 'hola como estas?';
    const match = PROMISE_PATTERNS.some(p => p.pattern.test(msg));
    expect(match).toBe(false);
  });

  // PREFERENCE_PATTERNS

  test('PREFERENCE_PATTERNS: es array de objetos con pattern, type, category', () => {
    expect(Array.isArray(PREFERENCE_PATTERNS)).toBe(true);
    expect(PREFERENCE_PATTERNS.length).toBeGreaterThan(0);
    PREFERENCE_PATTERNS.forEach(p => {
      expect(p.pattern).toBeInstanceOf(RegExp);
      expect(typeof p.type).toBe('string');
      expect(typeof p.category).toBe('string');
    });
  });

  test('PREFERENCE_PATTERNS: detecta hincha de equipo de deporte', () => {
    const msg = 'soy hincha de River Plate';
    const match = PREFERENCE_PATTERNS.some(p => p.pattern.test(msg));
    expect(match).toBe(true);
    const p = PREFERENCE_PATTERNS.find(p => p.pattern.test(msg));
    expect(p.category).toBe('deporte_o_general');
  });

  test('PREFERENCE_PATTERNS: detecta ubicacion ("vivo en")', () => {
    const msg = 'vivo en Bogota Colombia';
    const match = PREFERENCE_PATTERNS.some(p => p.pattern.test(msg));
    expect(match).toBe(true);
    const p = PREFERENCE_PATTERNS.find(p => p.pattern.test(msg));
    expect(p.category).toBe('ubicacion');
  });

  test('PREFERENCE_PATTERNS: detecta cumpleanos', () => {
    const msg = 'mi cumple es el 15 de marzo';
    const match = PREFERENCE_PATTERNS.some(p => p.pattern.test(msg));
    expect(match).toBe(true);
    const p = PREFERENCE_PATTERNS.find(p => p.pattern.test(msg));
    expect(p.category).toBe('cumpleanos');
  });

  test('PREFERENCE_PATTERNS: detecta profesion ("soy médico")', () => {
    const msg = 'soy médico especialista en cardiología';
    const match = PREFERENCE_PATTERNS.some(p => p.pattern.test(msg));
    expect(match).toBe(true);
    const p = PREFERENCE_PATTERNS.find(p => p.pattern.test(msg));
    expect(p.category).toBe('profesion');
  });

  test('PREFERENCE_PATTERNS: mensaje sin preferencia no matchea', () => {
    const msg = 'necesito una cotización para 10 personas';
    const match = PREFERENCE_PATTERNS.some(p => p.pattern.test(msg));
    expect(match).toBe(false);
  });

  // attemptAutoRepair

  test('attemptAutoRepair: agendar con fecha parseable retorna tag AGENDAR_EVENTO', () => {
    const msg = 'te agendé la reunión para el 15 de julio a las 10';
    const result = attemptAutoRepair(msg, 'agendar', '+5411111111', 'Juan');
    expect(result).not.toBeNull();
    expect(result).toContain('[AGENDAR_EVENTO:');
    expect(result).toContain('julio'.replace('julio', '')); // 07 en la fecha
    expect(result).toMatch(/\[AGENDAR_EVENTO:.+\|.+\|.+\|/);
  });

  test('attemptAutoRepair: agendar con fecha "5 de enero a las 2 pm" retorna tag', () => {
    const msg = 'te agendé la cita para el 5 de enero a las 2 pm';
    const result = attemptAutoRepair(msg, 'agendar', '+5411111111', 'Juan');
    expect(result).not.toBeNull();
    expect(result).toContain('[AGENDAR_EVENTO:');
    expect(result).toContain('+5411111111');
  });

  test('attemptAutoRepair: agendar sin fecha reconocible retorna null', () => {
    const msg = 'te agendé algo para cuando puedas';
    const result = attemptAutoRepair(msg, 'agendar', null, null);
    expect(result).toBeNull();
  });

  test('attemptAutoRepair: cancelar siempre retorna tag CANCELAR_EVENTO', () => {
    const msg = 'ya eliminé esa tarea de tu agenda para mañana a las 9:15 AM';
    const result = attemptAutoRepair(msg, 'cancelar', '+5411111111', 'Juan');
    expect(result).not.toBeNull();
    expect(result).toContain('[CANCELAR_EVENTO:');
  });

  test('attemptAutoRepair: mover retorna null (requiere 2 fechas)', () => {
    const msg = 'ya moví la reunion al martes';
    const result = attemptAutoRepair(msg, 'mover', null, null);
    expect(result).toBeNull();
  });

  test('attemptAutoRepair: accion desconocida retorna null', () => {
    const result = attemptAutoRepair('mensaje', 'accion_rara', null, null);
    expect(result).toBeNull();
  });

  test('attemptAutoRepair: usa contactPhone si disponible en tag', () => {
    const msg = 'te agendé la cita para el 20 de agosto a las 14';
    const result = attemptAutoRepair(msg, 'agendar', '+5411234567', null);
    expect(result).not.toBeNull();
    expect(result).toContain('+5411234567');
  });

  // getIntegrityStats

  test('getIntegrityStats: retorna objeto con campos esperados', () => {
    const stats = getIntegrityStats();
    expect(typeof stats).toBe('object');
    expect('lastPollAt' in stats).toBe(true);
    expect('promisesDetected' in stats).toBe(true);
    expect('promisesFulfilled' in stats).toBe(true);
    expect('promisesBroken' in stats).toBe(true);
    expect('preferencesLearned' in stats).toBe(true);
    expect('isRunning' in stats).toBe(true);
  });

  // startIntegrityEngine / stopIntegrityEngine

  test('stopIntegrityEngine: no lanza si no estaba corriendo', () => {
    expect(() => stopIntegrityEngine()).not.toThrow();
  });

  test('startIntegrityEngine y stopIntegrityEngine: ciclo sin crash', () => {
    jest.useFakeTimers();
    const fakeDeps = {
      ownerUid: 'uid_test',
      generateAI: async () => '',
      safeSendMessage: async () => {},
      ownerPhone: '+5411111111',
    };
    expect(() => startIntegrityEngine(fakeDeps)).not.toThrow();
    expect(() => stopIntegrityEngine()).not.toThrow();
    jest.useRealTimers();
  });

  // verifyCalendarEvent

  test('verifyCalendarEvent: retorna true si listCalendarEvents es null', async () => {
    const result = await verifyCalendarEvent(null, 'uid', '2026-07-15', 'Reunion', 0);
    expect(result).toBe(true);
  });

  test('verifyCalendarEvent: retorna true si evento encontrado en Calendar', async () => {
    jest.useFakeTimers();
    const mockList = jest.fn().mockResolvedValue([{ summary: 'Reunion de equipo ventas' }]);
    const promise = verifyCalendarEvent(mockList, 'uid', '2026-07-15', 'Reunion de equipo', 0);
    await jest.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe(true);
    jest.useRealTimers();
  });

  test('verifyCalendarEvent: retorna false si evento NO encontrado y retryCount=0', async () => {
    jest.useFakeTimers();
    const mockList = jest.fn().mockResolvedValue([{ summary: 'Otro evento sin relacion' }]);
    const promise = verifyCalendarEvent(mockList, 'uid', '2026-07-15', 'Reunion de ventas XYZ', 0);
    await jest.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe(false);
    jest.useRealTimers();
  });
});
