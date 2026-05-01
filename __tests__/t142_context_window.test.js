'use strict';
const { buildContextWindow, normalizeMessage, estimateTokens, estimateMessageTokens, DEFAULT_MAX_MESSAGES, DEFAULT_MAX_TOKENS } = require('../core/context_window');

describe('estimateTokens', () => {
  test('null retorna 0', () => { expect(estimateTokens(null)).toBe(0); });
  test('string vacio retorna 0', () => { expect(estimateTokens('')).toBe(0); });
  test('40 chars ~ 10 tokens', () => {
    expect(estimateTokens('x'.repeat(40))).toBe(10);
  });
  test('100 chars = 25 tokens', () => {
    expect(estimateTokens('x'.repeat(100))).toBe(25);
  });
});

describe('estimateMessageTokens', () => {
  test('null retorna 0', () => { expect(estimateMessageTokens(null)).toBe(0); });
  test('incluye overhead de 4 tokens', () => {
    const msg = { role: 'user', content: 'x'.repeat(40) }; // 10 + 4 = 14
    expect(estimateMessageTokens(msg)).toBe(14);
  });
});

describe('buildContextWindow — inputs invalidos', () => {
  test('null retorna window vacio', () => {
    const r = buildContextWindow(null);
    expect(r.window).toEqual([]);
    expect(r.truncated).toBe(false);
  });
  test('array vacio retorna window vacio', () => {
    const r = buildContextWindow([]);
    expect(r.window).toEqual([]);
    expect(r.droppedCount).toBe(0);
  });
});

describe('buildContextWindow — sin limite superado', () => {
  test('pocos mensajes = sin truncado', () => {
    const msgs = [
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'como te ayudo?' },
    ];
    const r = buildContextWindow(msgs);
    expect(r.window.length).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.droppedCount).toBe(0);
  });
  test('retorna estimatedTokens > 0', () => {
    const msgs = [{ role: 'user', content: 'mensaje de prueba largo' }];
    const r = buildContextWindow(msgs);
    expect(r.estimatedTokens).toBeGreaterThan(0);
  });
});

describe('buildContextWindow — maxMessages', () => {
  test('limita al maxMessages mas reciente', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `mensaje ${i}`,
    }));
    const r = buildContextWindow(msgs, { maxMessages: 10 });
    expect(r.window.length).toBeLessThanOrEqual(10);
    expect(r.truncated).toBe(true);
    // Los mensajes mas recientes deben estar incluidos
    expect(r.window[r.window.length - 1].content).toBe('mensaje 29');
  });
});

describe('buildContextWindow — maxTokens', () => {
  test('limita por tokens', () => {
    const msgs = Array.from({ length: 20 }, () => ({
      role: 'user',
      content: 'x'.repeat(400), // 100 tokens cada uno + 4 = 104
    }));
    // Con maxTokens=200, solo 1 mensaje entra (104 <= 200)
    const r = buildContextWindow(msgs, { maxMessages: 20, maxTokens: 200 });
    expect(r.window.length).toBeLessThanOrEqual(2);
    expect(r.truncated).toBe(true);
  });
  test('systemPrompt descuenta del budget', () => {
    const msgs = [{ role: 'user', content: 'x'.repeat(40) }]; // 10+4=14 tokens
    const systemPrompt = 'x'.repeat(3600); // ~900 tokens
    const r = buildContextWindow(msgs, { maxTokens: 1000, systemPrompt });
    // 1000 - 900 = 100 budget. Mensaje de 14 tokens entra.
    expect(r.window.length).toBe(1);
  });
  test('mantiene orden cronologico', () => {
    const msgs = [
      { role: 'user', content: 'primero' },
      { role: 'assistant', content: 'segundo' },
      { role: 'user', content: 'tercero' },
    ];
    const r = buildContextWindow(msgs);
    expect(r.window[0].content).toBe('primero');
    expect(r.window[2].content).toBe('tercero');
  });
});

describe('normalizeMessage', () => {
  test('null retorna null', () => { expect(normalizeMessage(null)).toBeNull(); });
  test('mensaje con role/content = sin cambios', () => {
    const r = normalizeMessage({ role: 'user', content: 'hola' });
    expect(r).toEqual({ role: 'user', content: 'hola' });
  });
  test('fromMe=true -> role=assistant', () => {
    const r = normalizeMessage({ fromMe: true, text: 'respuesta' });
    expect(r.role).toBe('assistant');
    expect(r.content).toBe('respuesta');
  });
  test('fromMe=false -> role=user', () => {
    const r = normalizeMessage({ fromMe: false, text: 'pregunta' });
    expect(r.role).toBe('user');
  });
  test('texto en .text si no hay .content', () => {
    const r = normalizeMessage({ role: 'user', text: 'usando text' });
    expect(r.content).toBe('usando text');
  });
});
