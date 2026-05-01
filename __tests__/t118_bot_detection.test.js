'use strict';
const { calculateBotScore, BOT_SCORE_THRESHOLD, MIN_HUMAN_RESPONSE_MS } = require('../core/bot_detection');

describe('constantes', () => {
  test('BOT_SCORE_THRESHOLD=60, MIN_HUMAN_RESPONSE_MS=2000', () => {
    expect(BOT_SCORE_THRESHOLD).toBe(60);
    expect(MIN_HUMAN_RESPONSE_MS).toBe(2000);
  });
});

describe('calculateBotScore', () => {
  test('array vacio = unknown', () => {
    const r = calculateBotScore([]);
    expect(r.verdict).toBe('unknown');
    expect(r.score).toBe(0);
  });
  test('solo mensajes fromMe = unknown', () => {
    const r = calculateBotScore([{ text: 'hola', fromMe: true }]);
    expect(r.verdict).toBe('unknown');
  });
  test('respuestas ultra-rapidas acumulan score', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      text: 'ok', fromMe: false, timestamp: 1000 + i * 100 // 100ms < 2000ms
    }));
    const r = calculateBotScore(msgs);
    expect(r.score).toBeGreaterThan(0);
    expect(r.signals.some(s => s.startsWith('ultra_fast'))).toBe(true);
  });
  test('mensajes identicos repetidos 3+ veces = bot signal', () => {
    const msgs = Array.from({ length: 4 }, () => ({ text: 'Hola necesito info', fromMe: false }));
    const r = calculateBotScore(msgs);
    expect(r.signals.some(s => s.startsWith('repeated'))).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(BOT_SCORE_THRESHOLD);
    expect(r.verdict).toBe('bot');
  });
  test('human normal no llega a threshold', () => {
    const msgs = [
      { text: 'Buenos dias, quisiera saber sobre sus servicios', fromMe: false, timestamp: 0 },
      { text: 'Cuanto cuesta la consulta mensual?', fromMe: false, timestamp: 60000 },
      { text: 'Ok perfecto, muchas gracias por la info', fromMe: false, timestamp: 120000 }
    ];
    const r = calculateBotScore(msgs);
    expect(r.verdict).not.toBe('bot');
  });
  test('retorna signals array', () => {
    const msgs = [{ text: 'x', fromMe: false }];
    const r = calculateBotScore(msgs);
    expect(Array.isArray(r.signals)).toBe(true);
  });
});
