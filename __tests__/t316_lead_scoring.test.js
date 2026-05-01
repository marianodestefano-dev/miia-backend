'use strict';

const {
  calculateLeadScore,
  classifyLeadScore,
  SCORE_WEIGHTS,
  MAX_SCORE,
} = require('../core/lead_scoring');

const NOW = 1000000000000;
const DAY = 24 * 60 * 60 * 1000;

describe('T316 -- lead_scoring (22 tests)', () => {

  // Constants
  test('SCORE_WEIGHTS es frozen', () => {
    expect(() => { SCORE_WEIGHTS.messageCount = 99; }).toThrow();
  });

  test('MAX_SCORE es 100', () => {
    expect(MAX_SCORE).toBe(100);
  });

  // calculateLeadScore - edge cases
  test('null retorna score=0', () => {
    expect(calculateLeadScore(null).score).toBe(0);
  });

  test('leadData sin messages retorna score=0 base', () => {
    const r = calculateLeadScore({});
    expect(r.score).toBe(0);
    expect(r.breakdown).toBeDefined();
  });

  test('mensajes vacios: messageCount=0', () => {
    const r = calculateLeadScore({ messages: [] });
    expect(r.breakdown.messageCount).toBe(0);
  });

  // messageCount scoring
  test('1 mensaje: messageCount=2', () => {
    const r = calculateLeadScore({ messages: [{}] });
    expect(r.breakdown.messageCount).toBe(2);
  });

  test('5 mensajes: messageCount=10', () => {
    const msgs = Array(5).fill({});
    const r = calculateLeadScore({ messages: msgs });
    expect(r.breakdown.messageCount).toBe(10);
  });

  test('15 mensajes: messageCount=30 (cap)', () => {
    const msgs = Array(15).fill({});
    const r = calculateLeadScore({ messages: msgs });
    expect(r.breakdown.messageCount).toBe(30);
  });

  test('20 mensajes: messageCount sigue en 30 (cap)', () => {
    const msgs = Array(20).fill({});
    const r = calculateLeadScore({ messages: msgs });
    expect(r.breakdown.messageCount).toBe(30);
  });

  // hasEmail / hasName
  test('con email: +15', () => {
    const r = calculateLeadScore({ messages: [], enrichment: { email: 'a@b.com' } });
    expect(r.breakdown.hasEmail).toBe(15);
  });

  test('sin email: +0', () => {
    const r = calculateLeadScore({ messages: [], enrichment: {} });
    expect(r.breakdown.hasEmail).toBe(0);
  });

  test('con nombre: +10', () => {
    const r = calculateLeadScore({ messages: [], enrichment: { name: 'Ana' } });
    expect(r.breakdown.hasName).toBe(10);
  });

  test('sin nombre: +0', () => {
    const r = calculateLeadScore({ messages: [] });
    expect(r.breakdown.hasName).toBe(0);
  });

  // recentActivity
  test('mensaje reciente (3 dias): recentActivity=20', () => {
    const msgs = [{ timestamp: NOW - 3 * DAY }];
    const r = calculateLeadScore({ messages: msgs }, NOW);
    expect(r.breakdown.recentActivity).toBe(20);
  });

  test('mensaje viejo (8 dias): recentActivity=0', () => {
    const msgs = [{ timestamp: NOW - 8 * DAY }];
    const r = calculateLeadScore({ messages: msgs }, NOW);
    expect(r.breakdown.recentActivity).toBe(0);
  });

  // longMessages
  test('mensaje largo (>50 chars): longMessages=5', () => {
    const msgs = [{ text: 'a'.repeat(51) }];
    const r = calculateLeadScore({ messages: msgs });
    expect(r.breakdown.longMessages).toBe(5);
  });

  test('mensaje corto (<=50 chars): longMessages=0', () => {
    const msgs = [{ text: 'corto' }];
    const r = calculateLeadScore({ messages: msgs });
    expect(r.breakdown.longMessages).toBe(0);
  });

  // hasAppointment
  test('hasAppointment=true: +20', () => {
    const r = calculateLeadScore({ messages: [], hasAppointment: true });
    expect(r.breakdown.hasAppointment).toBe(20);
  });

  test('hasAppointment=false: +0', () => {
    const r = calculateLeadScore({ messages: [], hasAppointment: false });
    expect(r.breakdown.hasAppointment).toBe(0);
  });

  // Score cap
  test('score no supera 100', () => {
    const msgs = Array(20).fill({ timestamp: NOW - 1 * DAY, text: 'a'.repeat(60) });
    const r = calculateLeadScore({
      messages: msgs,
      enrichment: { email: 'x@x.com', name: 'Ana' },
      hasAppointment: true,
    }, NOW);
    expect(r.score).toBe(100);
  });

  // classifyLeadScore
  test('score 70: hot', () => { expect(classifyLeadScore(70)).toBe('hot'); });
  test('score 40: warm', () => { expect(classifyLeadScore(40)).toBe('warm'); });
  test('score 10: cold', () => { expect(classifyLeadScore(10)).toBe('cold'); });
  test('score 5: unqualified', () => { expect(classifyLeadScore(5)).toBe('unqualified'); });
});
