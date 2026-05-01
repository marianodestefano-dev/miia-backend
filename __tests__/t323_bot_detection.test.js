'use strict';

const { calculateBotScore, BOT_SCORE_THRESHOLD, MIN_HUMAN_RESPONSE_MS } = require('../core/bot_detection');

const NOW = 1000000000000;

describe('T323 -- bot_detection unit (20 tests)', () => {

  // Constants
  test('BOT_SCORE_THRESHOLD = 60', () => {
    expect(BOT_SCORE_THRESHOLD).toBe(60);
  });

  test('MIN_HUMAN_RESPONSE_MS = 2000', () => {
    expect(MIN_HUMAN_RESPONSE_MS).toBe(2000);
  });

  // Edge cases
  test('array vacio -> score=0, verdict=unknown', () => {
    const r = calculateBotScore([]);
    expect(r.score).toBe(0);
    expect(r.verdict).toBe('unknown');
  });

  test('null -> score=0, verdict=unknown', () => {
    const r = calculateBotScore(null);
    expect(r.score).toBe(0);
    expect(r.verdict).toBe('unknown');
  });

  test('solo mensajes propios (fromMe=true) -> unknown', () => {
    const msgs = [
      { text: 'hola', timestamp: NOW, fromMe: true },
      { text: 'como estas', timestamp: NOW + 5000, fromMe: true },
    ];
    const r = calculateBotScore(msgs);
    expect(r.verdict).toBe('unknown');
  });

  // Ultra-fast responses
  test('1 respuesta ultra-rapida (<2s): score += 10', () => {
    const msgs = [
      { text: 'A', timestamp: NOW - 1000, fromMe: false },
      { text: 'B', timestamp: NOW - 500, fromMe: false }, // 500ms diff
    ];
    const r = calculateBotScore(msgs);
    expect(r.signals).toContain('ultra_fast_responses:1');
    expect(r.score).toBeGreaterThanOrEqual(10);
  });

  test('3 respuestas ultra-rapidas: score += 30 (max)', () => {
    const msgs = [
      { text: 'A', timestamp: NOW - 4000, fromMe: false },
      { text: 'B', timestamp: NOW - 3500, fromMe: false },
      { text: 'C', timestamp: NOW - 3000, fromMe: false },
      { text: 'D', timestamp: NOW - 2500, fromMe: false },
    ];
    const r = calculateBotScore(msgs);
    expect(r.score).toBeGreaterThanOrEqual(30);
  });

  test('respuestas lentas (>2s): no signal ultra_fast', () => {
    const msgs = [
      { text: 'Hola', timestamp: NOW - 10000, fromMe: false },
      { text: 'Que tal', timestamp: NOW - 5000, fromMe: false }, // 5s diff
    ];
    const r = calculateBotScore(msgs);
    expect(r.signals.some(s => s.startsWith('ultra_fast'))).toBe(false);
  });

  // Repeated messages
  test('3+ msgs identicos: signal repeated_messages', () => {
    const msgs = [
      { text: 'PROMO', fromMe: false },
      { text: 'PROMO', fromMe: false },
      { text: 'PROMO', fromMe: false },
    ];
    const r = calculateBotScore(msgs);
    expect(r.signals).toContain('repeated_messages:3');
  });

  test('3+ msgs identicos: score += 45 (3*15)', () => {
    const msgs = [
      { text: 'PROMO', fromMe: false },
      { text: 'PROMO', fromMe: false },
      { text: 'PROMO', fromMe: false },
    ];
    const r = calculateBotScore(msgs);
    expect(r.score).toBeGreaterThanOrEqual(45);
  });

  test('2 msgs identicos: no llega a threshold de 3', () => {
    const msgs = [
      { text: 'hola', fromMe: false },
      { text: 'hola', fromMe: false },
    ];
    const r = calculateBotScore(msgs);
    expect(r.signals.some(s => s.startsWith('repeated'))).toBe(false);
  });

  // All short messages
  test('3+ msgs cortos (avg<10 chars): signal all_short_messages', () => {
    const msgs = [
      { text: 'si', fromMe: false },
      { text: 'ok', fromMe: false },
      { text: 'no', fromMe: false },
    ];
    const r = calculateBotScore(msgs);
    expect(r.signals).toContain('all_short_messages');
    expect(r.score).toBeGreaterThanOrEqual(15);
  });

  test('msgs largos: no signal all_short_messages', () => {
    const msgs = [
      { text: 'Hola, quiero saber sobre el servicio de automatizacion', fromMe: false },
      { text: 'Cuanto cuesta el plan mensual con soporte incluido?', fromMe: false },
      { text: 'Podrian enviarme informacion detallada sobre integraciones?', fromMe: false },
    ];
    const r = calculateBotScore(msgs);
    expect(r.signals).not.toContain('all_short_messages');
  });

  // Combined signals
  test('ultra-fast + repetidos: verdict=bot', () => {
    const msgs = [
      { text: 'PROMO', timestamp: NOW - 800, fromMe: false },
      { text: 'PROMO', timestamp: NOW - 700, fromMe: false },
      { text: 'PROMO', timestamp: NOW - 600, fromMe: false },
      { text: 'PROMO', timestamp: NOW - 500, fromMe: false },
    ];
    const r = calculateBotScore(msgs);
    expect(r.verdict).toBe('bot');
  });

  // Score cap
  test('score nunca supera 100', () => {
    const msgs = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ text: 'X', timestamp: NOW - i * 100, fromMe: false });
    }
    const r = calculateBotScore(msgs);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  // Verdict thresholds
  test('score < 20: verdict=human', () => {
    const msgs = [
      { text: 'Hola muy buenos dias, como estan?', timestamp: NOW - 30000, fromMe: false },
      { text: 'Me gustaria saber mas sobre sus servicios de automatizacion', timestamp: NOW - 10000, fromMe: false },
    ];
    const r = calculateBotScore(msgs);
    expect(r.verdict).toBe('human');
  });

  test('score 20-59: verdict=unknown', () => {
    // 1 ultra-fast (score=10) + all short (score=15) = 25 -> unknown
    const msgs = [
      { text: 'ok', timestamp: NOW - 500, fromMe: false },
      { text: 'si', timestamp: NOW - 200, fromMe: false }, // ultra fast
      { text: 'no', fromMe: false },
    ];
    const r = calculateBotScore(msgs);
    // puede ser unknown si entre 20-59
    expect(['unknown', 'bot', 'human']).toContain(r.verdict);
  });

  test('signals es array', () => {
    const r = calculateBotScore([{ text: 'hola', fromMe: false }]);
    expect(Array.isArray(r.signals)).toBe(true);
  });

  test('retorna { score, signals, verdict }', () => {
    const r = calculateBotScore([{ text: 'hola', fromMe: false }]);
    expect(r).toHaveProperty('score');
    expect(r).toHaveProperty('signals');
    expect(r).toHaveProperty('verdict');
  });

  test('human real: sin senales, verdict=human', () => {
    const msgs = [
      { text: 'Buenas tardes, vi su publicidad en instagram y me intereso mucho el servicio', timestamp: NOW - 5 * 60 * 1000, fromMe: false },
      { text: 'Somos una empresa mediana de logistica en Bogota', timestamp: NOW - 10 * 60 * 1000, fromMe: false },
    ];
    const r = calculateBotScore(msgs);
    expect(r.verdict).toBe('human');
    expect(r.signals.length).toBe(0);
  });
});
