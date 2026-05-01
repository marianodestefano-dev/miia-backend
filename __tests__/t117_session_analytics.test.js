'use strict';
const { groupIntoSessions, calculateSessionMetrics, SESSION_GAP_MS } = require('../core/session_analytics');

const MIN_MS = 60 * 1000;
const GAP = 31 * MIN_MS; // 31min > 30min gap

describe('SESSION_GAP_MS = 30min', () => {
  test('SESSION_GAP_MS = 1800000', () => {
    expect(SESSION_GAP_MS).toBe(30 * 60 * 1000);
  });
});

describe('groupIntoSessions', () => {
  test('array vacio retorna []', () => {
    expect(groupIntoSessions([])).toEqual([]);
  });
  test('mensajes sin timestamp son ignorados', () => {
    const msgs = [{ text: 'a' }, { text: 'b' }];
    expect(groupIntoSessions(msgs)).toEqual([]);
  });
  test('mensajes en una sola sesion (gap < 30min)', () => {
    const msgs = [
      { text: 'a', timestamp: 1000 },
      { text: 'b', timestamp: 1000 + 10 * MIN_MS },
      { text: 'c', timestamp: 1000 + 20 * MIN_MS }
    ];
    const sessions = groupIntoSessions(msgs);
    expect(sessions.length).toBe(1);
    expect(sessions[0].length).toBe(3);
  });
  test('mensajes en 2 sesiones separadas por gap > 30min', () => {
    const base = 1000000;
    const msgs = [
      { timestamp: base },
      { timestamp: base + 5 * MIN_MS },
      { timestamp: base + GAP + 5 * MIN_MS }, // nueva sesion
      { timestamp: base + GAP + 10 * MIN_MS }
    ];
    const sessions = groupIntoSessions(msgs);
    expect(sessions.length).toBe(2);
    expect(sessions[0].length).toBe(2);
    expect(sessions[1].length).toBe(2);
  });
});

describe('calculateSessionMetrics', () => {
  test('null/undefined retorna 0s', () => {
    const r = calculateSessionMetrics(null);
    expect(r.sessionCount).toBe(0);
    expect(r.avgDurationMs).toBe(0);
  });
  test('1 mensaje = 1 sesion, duracion 0', () => {
    const r = calculateSessionMetrics([{ timestamp: 1000 }]);
    expect(r.sessionCount).toBe(1);
    expect(r.avgDurationMs).toBe(0);
  });
  test('2 sesiones correctamente', () => {
    const base = 1000000;
    const msgs = [
      { timestamp: base },
      { timestamp: base + 10 * MIN_MS }, // sesion 1: 10min
      { timestamp: base + 10 * MIN_MS + GAP }, // gap de 31min desde ultimo de sesion 1
      { timestamp: base + 10 * MIN_MS + GAP + 20 * MIN_MS } // sesion 2: 20min
    ];
    const r = calculateSessionMetrics(msgs);
    expect(r.sessionCount).toBe(2);
    expect(r.avgDurationMs).toBe(Math.round((10 * MIN_MS + 20 * MIN_MS) / 2));
    expect(r.avgMessagesPerSession).toBe(2);
  });
});
