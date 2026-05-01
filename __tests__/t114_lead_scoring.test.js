'use strict';
const { calculateLeadScore, classifyLeadScore, SCORE_WEIGHTS, MAX_SCORE } = require('../core/lead_scoring');

const NOW = 1000000000000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('calculateLeadScore', () => {
  test('lead vacio = score 0', () => {
    const r = calculateLeadScore({}, NOW);
    expect(r.score).toBe(0);
  });
  test('null/undefined = score 0', () => {
    expect(calculateLeadScore(null).score).toBe(0);
    expect(calculateLeadScore(undefined).score).toBe(0);
  });
  test('mensajes suman 2pts c/u hasta max 30', () => {
    const msgs = Array.from({length: 20}, (_, i) => ({ text: 'x', timestamp: NOW }));
    const r = calculateLeadScore({ messages: msgs }, NOW);
    expect(r.breakdown.messageCount).toBe(30); // cap 30
  });
  test('email +15', () => {
    const r = calculateLeadScore({ enrichment: { email: 'a@b.com' } }, NOW);
    expect(r.breakdown.hasEmail).toBe(15);
  });
  test('name +10', () => {
    const r = calculateLeadScore({ enrichment: { name: 'Juan' } }, NOW);
    expect(r.breakdown.hasName).toBe(10);
  });
  test('actividad reciente (7d) +20', () => {
    const msgs = [{ text: 'hola', timestamp: NOW - 3 * DAY_MS }];
    const r = calculateLeadScore({ messages: msgs }, NOW);
    expect(r.breakdown.recentActivity).toBe(20);
  });
  test('actividad vieja no suma recentActivity', () => {
    const msgs = [{ text: 'hola', timestamp: NOW - 10 * DAY_MS }];
    const r = calculateLeadScore({ messages: msgs }, NOW);
    expect(r.breakdown.recentActivity).toBe(0);
  });
  test('mensaje largo (+50 chars) +5', () => {
    const msgs = [{ text: 'a'.repeat(51), timestamp: NOW }];
    const r = calculateLeadScore({ messages: msgs }, NOW);
    expect(r.breakdown.longMessages).toBe(5);
  });
  test('hasAppointment +20', () => {
    const r = calculateLeadScore({ hasAppointment: true }, NOW);
    expect(r.breakdown.hasAppointment).toBe(20);
  });
  test('score maximo no excede MAX_SCORE', () => {
    const msgs = Array.from({length: 100}, () => ({ text: 'x'.repeat(60), timestamp: NOW }));
    const r = calculateLeadScore({ messages: msgs, enrichment: { email: 'a@b.com', name: 'A' }, hasAppointment: true }, NOW);
    expect(r.score).toBe(MAX_SCORE);
  });
});

describe('classifyLeadScore', () => {
  test('score >= 70 = hot', () => { expect(classifyLeadScore(70)).toBe('hot'); });
  test('score 40-69 = warm', () => { expect(classifyLeadScore(40)).toBe('warm'); expect(classifyLeadScore(69)).toBe('warm'); });
  test('score 10-39 = cold', () => { expect(classifyLeadScore(10)).toBe('cold'); });
  test('score < 10 = unqualified', () => { expect(classifyLeadScore(5)).toBe('unqualified'); });
});
