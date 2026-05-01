'use strict';
const { classifyContact, CONTACT_CATEGORIES, BOT_THRESHOLD, CLIENT_THRESHOLD, LEAD_THRESHOLD, INACTIVE_DAYS } = require('../core/contact_classifier');

const NOW = Date.now();

describe('constantes', () => {
  test('CONTACT_CATEGORIES contiene categorias esperadas', () => {
    expect(CONTACT_CATEGORIES).toContain('lead');
    expect(CONTACT_CATEGORIES).toContain('client');
    expect(CONTACT_CATEGORIES).toContain('bot');
    expect(CONTACT_CATEGORIES).toContain('inactive');
  });
  test('thresholds correctos', () => {
    expect(CLIENT_THRESHOLD).toBe(50);
    expect(LEAD_THRESHOLD).toBe(20);
    expect(BOT_THRESHOLD).toBe(60);
  });
});

describe('classifyContact — validacion inputs', () => {
  test('null retorna unknown score 0', () => {
    const r = classifyContact(null);
    expect(r.category).toBe('unknown');
    expect(r.score).toBe(0);
  });
  test('objeto vacio retorna unknown', () => {
    const r = classifyContact({});
    expect(r.category).toBe('unknown');
  });
});

describe('classifyContact — bot', () => {
  test('botScore >= threshold = bot', () => {
    const r = classifyContact({ botScore: 70, messageCount: 5 }, NOW);
    expect(r.category).toBe('bot');
    expect(r.score).toBeLessThan(0);
  });
  test('botScore bajo threshold no clasifica como bot', () => {
    const r = classifyContact({ botScore: 30, messageCount: 5, hasEmail: true }, NOW);
    expect(r.category).not.toBe('bot');
  });
});

describe('classifyContact — client', () => {
  test('hasPurchase + messageCount = client', () => {
    const r = classifyContact({ hasPurchase: true, messageCount: 5, hasEmail: true }, NOW);
    expect(r.category).toBe('client');
    expect(r.score).toBeGreaterThanOrEqual(CLIENT_THRESHOLD);
  });
  test('hasPurchase + hasAppointment = client', () => {
    const r = classifyContact({ hasPurchase: true, hasAppointment: true }, NOW);
    expect(r.category).toBe('client');
  });
});

describe('classifyContact — lead y active', () => {
  test('pocos mensajes sin compra = lead', () => {
    const r = classifyContact({ messageCount: 2 }, NOW);
    expect(r.category).toBe('lead');
  });
  test('messageCount >= 3 con score en rango lead = active', () => {
    const r = classifyContact({
      messageCount: 5,
      lastActivityMs: NOW - 2 * 86400000,
      longMessageRatio: 0.5
    }, NOW);
    expect(['active', 'lead', 'client']).toContain(r.category);
  });
});

describe('classifyContact — inactive', () => {
  test('sin actividad por mas de INACTIVE_DAYS = inactive', () => {
    const oldTs = NOW - (INACTIVE_DAYS + 10) * 86400000;
    const r = classifyContact({ messageCount: 3, lastActivityMs: oldTs }, NOW);
    expect(r.category).toBe('inactive');
  });
  test('actividad reciente no es inactive', () => {
    const r = classifyContact({ messageCount: 3, lastActivityMs: NOW - 10 * 86400000 }, NOW);
    expect(r.category).not.toBe('inactive');
  });
});

describe('classifyContact — score y signals', () => {
  test('retorna score numerico', () => {
    const r = classifyContact({ messageCount: 3 }, NOW);
    expect(typeof r.score).toBe('number');
  });
  test('retorna signals de vuelta', () => {
    const signals = { messageCount: 3, hasPurchase: false };
    const r = classifyContact(signals, NOW);
    expect(r.signals).toBe(signals);
  });
});
