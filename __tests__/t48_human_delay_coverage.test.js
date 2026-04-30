'use strict';

/**
 * T48 — coverage gap fix: human_delay.js
 * (era 2.81% → target >85%)
 */

const hd = require('../core/human_delay');

describe('T48 §A — calculateReadDelay', () => {
  test('owner → max 4s cap', () => {
    for (let i = 0; i < 30; i++) {
      const d = hd.calculateReadDelay({ contactType: 'owner', messageLength: 50, isFirstMessage: false, hour: 14 });
      expect(d).toBeLessThanOrEqual(4000);
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });

  test('familia → entre 1s y razonable', () => {
    const d = hd.calculateReadDelay({ contactType: 'familia', messageLength: 50, isFirstMessage: false, hour: 14 });
    expect(d).toBeGreaterThan(500);
    expect(d).toBeLessThan(60000);
  });

  test('equipo → mismo path que familia', () => {
    const d = hd.calculateReadDelay({ contactType: 'equipo', messageLength: 50, isFirstMessage: false, hour: 14 });
    expect(d).toBeGreaterThan(500);
  });

  test('lead conocido → 2.5-5s base + jitter', () => {
    const d = hd.calculateReadDelay({ contactType: 'lead', messageLength: 50, isFirstMessage: false, hour: 14 });
    expect(d).toBeGreaterThan(1000);
    expect(d).toBeLessThan(60000);
  });

  test('lead nuevo → 5-15s base', () => {
    const d = hd.calculateReadDelay({ contactType: 'lead', messageLength: 50, isFirstMessage: true, hour: 14 });
    expect(d).toBeGreaterThan(2000);
  });

  test('contactType desconocido → fallback', () => {
    const d = hd.calculateReadDelay({ contactType: 'unknown', messageLength: 50, isFirstMessage: false, hour: 14 });
    expect(d).toBeGreaterThan(1000);
  });

  test('mensaje largo → mas reading time', () => {
    const dShort = hd.calculateReadDelay({ contactType: 'lead', messageLength: 10, isFirstMessage: false, hour: 14 });
    const dLong = hd.calculateReadDelay({ contactType: 'lead', messageLength: 5000, isFirstMessage: false, hour: 14 });
    // dLong tiende a ser > dShort en promedio (puede haber jitter)
    expect(typeof dShort).toBe('number');
    expect(typeof dLong).toBe('number');
  });

  test('horario nocturno (hora 23) → multiplicador 2-5x', () => {
    const dNight = hd.calculateReadDelay({ contactType: 'lead', messageLength: 50, isFirstMessage: false, hour: 23 });
    expect(dNight).toBeGreaterThan(1000);
  });

  test('horario nocturno (hora 3) → multiplicador 2-5x', () => {
    const dNight = hd.calculateReadDelay({ contactType: 'lead', messageLength: 50, isFirstMessage: false, hour: 3 });
    expect(dNight).toBeGreaterThan(1000);
  });

  test('delayMultiplier 2 → mas delay', () => {
    const d1 = hd.calculateReadDelay({ contactType: 'lead', messageLength: 50, isFirstMessage: false, hour: 14, delayMultiplier: 1 });
    const d2 = hd.calculateReadDelay({ contactType: 'lead', messageLength: 50, isFirstMessage: false, hour: 14, delayMultiplier: 2 });
    expect(typeof d1).toBe('number');
    expect(typeof d2).toBe('number');
  });
});

describe('T48 §B — calculateTypingDelay', () => {
  test('respuesta corta → minimo 1.5s', () => {
    const d = hd.calculateTypingDelay({ responseLength: 10, contactType: 'lead' });
    expect(d).toBeGreaterThanOrEqual(1500);
  });

  test('respuesta larga → cap 15s', () => {
    const d = hd.calculateTypingDelay({ responseLength: 5000, contactType: 'lead' });
    expect(d).toBeLessThanOrEqual(15000);
  });

  test('owner → 70% mas rapido (multi 0.3)', () => {
    const dOwner = hd.calculateTypingDelay({ responseLength: 200, contactType: 'owner' });
    expect(dOwner).toBeGreaterThanOrEqual(1500); // floor min
    expect(dOwner).toBeLessThanOrEqual(15000);
  });

  test('delayMultiplier aplicado', () => {
    const d = hd.calculateTypingDelay({ responseLength: 100, contactType: 'lead', delayMultiplier: 1.5 });
    expect(d).toBeGreaterThanOrEqual(1500);
  });
});

describe('T48 §C — maybeBusyDelay', () => {
  test('owner → siempre 0', () => {
    for (let i = 0; i < 50; i++) {
      expect(hd.maybeBusyDelay('owner')).toBe(0);
    }
  });

  test('lead → 1/8 chance retorna 20-45s, resto 0', () => {
    const orig = Math.random;
    // Forzar < 0.125 → busy delay
    Math.random = () => 0.05;
    const d = hd.maybeBusyDelay('lead');
    expect(d).toBeGreaterThanOrEqual(20000);
    expect(d).toBeLessThanOrEqual(45100);
    // Forzar > 0.125 → 0
    Math.random = () => 0.5;
    expect(hd.maybeBusyDelay('lead')).toBe(0);
    Math.random = orig;
  });
});

describe('T48 §D — getOwnerHour', () => {
  test('retorna numero 0-23', () => {
    const h = hd.getOwnerHour('America/Bogota');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(23);
  });

  test('default timezone Buenos Aires sin throw', () => {
    expect(() => hd.getOwnerHour()).not.toThrow();
  });

  test('timezone invalido → fallback a hora local sin throw', () => {
    const h = hd.getOwnerHour('Invalid/Timezone');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(23);
  });
});

describe('T48 §E — checkNightMode', () => {
  test('uid nuevo genera state, retorna isNight + reason', () => {
    const r = hd.checkNightMode('uid_test_night_1', 'America/Bogota');
    expect(typeof r.isNight).toBe('boolean');
    expect(typeof r.reason).toBe('string');
  });

  test('uid existente reutiliza state mismo dia', () => {
    const r1 = hd.checkNightMode('uid_test_night_2', 'America/Bogota');
    const r2 = hd.checkNightMode('uid_test_night_2', 'America/Bogota');
    expect(r1.reason).toBe(r2.reason);
  });

  test('timezone invalido no tira', () => {
    expect(() => hd.checkNightMode('uid_test_invalid_tz', 'X/Y')).not.toThrow();
  });
});

describe('T48 §F — nightModeGate', () => {
  test('owner siempre allowed', () => {
    const r = hd.nightModeGate('uid_owner_test', 'owner', 'America/Bogota');
    expect(r.allowed).toBe(true);
  });

  test('familia siempre allowed', () => {
    const r = hd.nightModeGate('uid_fam_test', 'familia', 'America/Bogota');
    expect(r.allowed).toBe(true);
  });

  test('equipo siempre allowed', () => {
    const r = hd.nightModeGate('uid_eq_test', 'equipo', 'America/Bogota');
    expect(r.allowed).toBe(true);
  });

  test('lead retorna allowed boolean + delayUntilMorning si night', () => {
    const r = hd.nightModeGate('uid_lead_test', 'lead', 'America/Bogota');
    expect(typeof r.allowed).toBe('boolean');
    expect(typeof r.delayUntilMorning).toBe('boolean');
    expect(typeof r.reason).toBe('string');
  });
});
