'use strict';
const { PresenceTracker, DEFAULT_COOLDOWN_MS, DEFAULT_AWAY_THRESHOLD_MS } = require('../core/presence_tracker');

const UID = 'presenceTestUid1234567890';
const NOW = Date.now();

describe('constantes', () => {
  test('DEFAULT_COOLDOWN_MS = 90 minutos', () => {
    expect(DEFAULT_COOLDOWN_MS).toBe(90 * 60 * 1000);
  });
  test('DEFAULT_AWAY_THRESHOLD_MS = 5 minutos', () => {
    expect(DEFAULT_AWAY_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });
});

describe('recordActivity y getPresence', () => {
  let pt;
  beforeEach(() => { pt = new PresenceTracker({ cooldownMs: 60000, awayThresholdMs: 5000 }); });

  test('lanza si uid falta en recordActivity', () => {
    expect(() => pt.recordActivity(null)).toThrow('uid requerido');
  });
  test('lanza si uid falta en getPresence', () => {
    expect(() => pt.getPresence(null)).toThrow('uid requerido');
  });
  test('uid sin actividad = offline', () => {
    expect(pt.getPresence(UID, NOW)).toBe('offline');
  });
  test('actividad reciente = online', () => {
    pt.recordActivity(UID, NOW);
    expect(pt.getPresence(UID, NOW + 1000)).toBe('online');
  });
  test('entre awayThreshold y cooldown = away', () => {
    pt.recordActivity(UID, NOW);
    expect(pt.getPresence(UID, NOW + 10000)).toBe('away');
  });
  test('despues de cooldown = offline', () => {
    pt.recordActivity(UID, NOW);
    expect(pt.getPresence(UID, NOW + 70000)).toBe('offline');
  });
});

describe('isInCooldown', () => {
  let pt;
  beforeEach(() => { pt = new PresenceTracker({ cooldownMs: 60000, awayThresholdMs: 5000 }); });

  test('online = inCooldown true', () => {
    pt.recordActivity(UID, NOW);
    expect(pt.isInCooldown(UID, NOW)).toBe(true);
  });
  test('away = inCooldown true', () => {
    pt.recordActivity(UID, NOW);
    expect(pt.isInCooldown(UID, NOW + 10000)).toBe(true);
  });
  test('offline = inCooldown false', () => {
    expect(pt.isInCooldown(UID, NOW)).toBe(false);
  });
  test('post-cooldown = inCooldown false', () => {
    pt.recordActivity(UID, NOW);
    expect(pt.isInCooldown(UID, NOW + 70000)).toBe(false);
  });
});

describe('getCooldownRemaining', () => {
  let pt;
  beforeEach(() => { pt = new PresenceTracker({ cooldownMs: 60000, awayThresholdMs: 5000 }); });

  test('sin actividad = 0', () => {
    expect(pt.getCooldownRemaining(UID, NOW)).toBe(0);
  });
  test('actividad reciente = mayor que 0', () => {
    pt.recordActivity(UID, NOW);
    expect(pt.getCooldownRemaining(UID, NOW + 10000)).toBeGreaterThan(0);
  });
  test('post-cooldown = 0', () => {
    pt.recordActivity(UID, NOW);
    expect(pt.getCooldownRemaining(UID, NOW + 70000)).toBe(0);
  });
});

describe('setOffline y getLastSeen y clear', () => {
  let pt;
  beforeEach(() => { pt = new PresenceTracker({ cooldownMs: 60000, awayThresholdMs: 5000 }); });

  test('setOffline marca offline', () => {
    pt.recordActivity(UID, NOW);
    pt.setOffline(UID);
    expect(pt.getPresence(UID, NOW)).toBe('offline');
  });
  test('getLastSeen retorna timestamp', () => {
    pt.recordActivity(UID, NOW);
    expect(pt.getLastSeen(UID)).toBe(NOW);
  });
  test('getLastSeen null si sin actividad', () => {
    expect(pt.getLastSeen(UID)).toBeNull();
  });
  test('clear(uid) limpia ese uid', () => {
    pt.recordActivity(UID, NOW);
    pt.clear(UID);
    expect(pt.getPresence(UID, NOW)).toBe('offline');
  });
  test('clear() sin arg limpia todo', () => {
    pt.recordActivity(UID, NOW);
    pt.recordActivity('uid2', NOW);
    pt.clear();
    expect(pt.getPresence(UID, NOW)).toBe('offline');
    expect(pt.getPresence('uid2', NOW)).toBe('offline');
  });
});
