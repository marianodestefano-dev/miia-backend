'use strict';

const { summarizeConversation, buildContextSummary } = require('../core/conversation_summarizer');
const { classifyIntent, classifyBatch, INTENTS, CONFIDENCE } = require('../core/intent_classifier');

const NOW = 1000000000000;
const MIN = 60 * 1000;

describe('T324 -- conversation_summarizer + intent_classifier (28 tests)', () => {

  // INTENTS / CONFIDENCE
  test('INTENTS frozen y contiene todos los tipos', () => {
    expect(() => { INTENTS.push('extra'); }).toThrow();
    ['booking', 'price', 'complaint', 'info', 'greeting', 'farewell', 'unknown'].forEach(i => {
      expect(INTENTS).toContain(i);
    });
  });

  test('CONFIDENCE: HIGH=0.9, MEDIUM=0.7, LOW=0.5', () => {
    expect(CONFIDENCE.HIGH).toBe(0.9);
    expect(CONFIDENCE.MEDIUM).toBe(0.7);
    expect(CONFIDENCE.LOW).toBe(0.5);
  });

  // classifyIntent — edge cases
  test('null -> unknown, confidence=0', () => {
    const r = classifyIntent(null);
    expect(r.intent).toBe('unknown');
    expect(r.confidence).toBe(0);
  });

  test('"" -> unknown, confidence=0', () => {
    const r = classifyIntent('');
    expect(r.intent).toBe('unknown');
    expect(r.confidence).toBe(0);
  });

  test('sin patron conocido -> unknown, confidence=LOW', () => {
    const r = classifyIntent('blah xyzzy qqqq');
    expect(r.intent).toBe('unknown');
    expect(r.confidence).toBe(CONFIDENCE.LOW);
  });

  // classifyIntent — patterns
  test('greeting: "hola"', () => {
    const r = classifyIntent('hola como estas?');
    expect(r.intent).toBe('greeting');
    expect(r.confidence).toBe(CONFIDENCE.HIGH);
    expect(r.signals.length).toBeGreaterThan(0);
  });

  test('farewell: "adios"', () => {
    const r = classifyIntent('adios, hasta luego');
    expect(r.intent).toBe('farewell');
  });

  test('booking: "agendar una cita"', () => {
    const r = classifyIntent('quiero agendar una cita para manana');
    expect(r.intent).toBe('booking');
    expect(r.confidence).toBe(CONFIDENCE.HIGH);
  });

  test('booking: "turno"', () => {
    const r = classifyIntent('necesito un turno para esta semana');
    expect(r.intent).toBe('booking');
  });

  test('price: "cuanto cuesta"', () => {
    const r = classifyIntent('cuanto cuesta el plan mensual?');
    expect(r.intent).toBe('price');
  });

  test('price: "precio"', () => {
    const r = classifyIntent('Cual es el precio de sus servicios?');
    expect(r.intent).toBe('price');
  });

  test('complaint: "queja"', () => {
    const r = classifyIntent('tengo una queja sobre el servicio');
    expect(r.intent).toBe('complaint');
  });

  test('complaint: prioridad sobre booking si ambos presentes', () => {
    const r = classifyIntent('queja por el turno que no funcionó');
    expect(r.intent).toBe('complaint');
    expect(r.confidence).toBe(CONFIDENCE.MEDIUM);
  });

  test('info: "informacion"', () => {
    const r = classifyIntent('necesito informacion sobre sus servicios');
    expect(r.intent).toBe('info');
  });

  test('signals retorna el texto que matcheo', () => {
    const r = classifyIntent('Buenos dias, como estan?');
    expect(r.signals.length).toBeGreaterThan(0);
    expect(typeof r.signals[0]).toBe('string');
  });

  // classifyBatch
  test('classifyBatch: array vacio -> dominant=unknown', () => {
    const r = classifyBatch([]);
    expect(r.dominant).toBe('unknown');
    expect(r.results).toEqual([]);
  });

  test('classifyBatch: 3 greetings -> dominant=greeting', () => {
    const r = classifyBatch(['hola', 'buenas', 'hey como vas']);
    expect(r.dominant).toBe('greeting');
    expect(r.results.length).toBe(3);
  });

  test('classifyBatch: mayoria price -> dominant=price', () => {
    const r = classifyBatch([
      'cuanto cuesta?', 'cual es el precio?', 'que tarifa tienen?', 'hola'
    ]);
    expect(r.dominant).toBe('price');
  });

  // summarizeConversation
  test('null -> messageCount=0', () => {
    const r = summarizeConversation(null);
    expect(r.messageCount).toBe(0);
  });

  test('array vacio -> messageCount=0', () => {
    const r = summarizeConversation([]);
    expect(r.messageCount).toBe(0);
    expect(r.preview).toEqual([]);
  });

  test('conteo fromMe y fromContact', () => {
    const msgs = [
      { text: 'A', fromMe: true },
      { text: 'B', fromMe: false },
      { text: 'C', fromMe: false },
    ];
    const r = summarizeConversation(msgs);
    expect(r.messageCount).toBe(3);
    expect(r.fromMe).toBe(1);
    expect(r.fromContact).toBe(2);
  });

  test('oldest y newest timestamps', () => {
    const msgs = [
      { timestamp: NOW - 3 * MIN },
      { timestamp: NOW - 1 * MIN },
      { timestamp: NOW - 2 * MIN },
    ];
    const r = summarizeConversation(msgs);
    expect(r.oldestTimestamp).toBe(NOW - 3 * MIN);
    expect(r.newestTimestamp).toBe(NOW - 1 * MIN);
  });

  test('avgMessageLength calculado', () => {
    const msgs = [
      { text: 'abcde' },    // 5
      { text: 'abcde12345' }, // 10
    ];
    const r = summarizeConversation(msgs);
    expect(r.avgMessageLength).toBe(8); // (5+10)/2 = 7.5 -> 8
  });

  test('preview: ultimos N mensajes (default 5)', () => {
    const msgs = Array.from({ length: 8 }, (_, i) => ({ text: `msg${i}`, fromMe: false }));
    const r = summarizeConversation(msgs);
    expect(r.preview.length).toBe(5);
    expect(r.preview[0].text).toBe('msg3');
  });

  test('preview: texto truncado a 100 chars', () => {
    const msgs = [{ text: 'a'.repeat(150), fromMe: false }];
    const r = summarizeConversation(msgs);
    expect(r.preview[0].text.length).toBe(100);
  });

  // buildContextSummary
  test('buildContextSummary: null -> total=0', () => {
    const r = buildContextSummary(null);
    expect(r.total).toBe(0);
    expect(r.summaries).toEqual({});
  });

  test('buildContextSummary: resume multiples phones', () => {
    const convs = {
      '+571111': [{ text: 'hola', fromMe: false }],
      '+572222': [{ text: 'precio', fromMe: false }, { text: 'ok', fromMe: true }],
    };
    const r = buildContextSummary(convs);
    expect(r.total).toBe(2);
    expect(r.summaries['+571111'].messageCount).toBe(1);
    expect(r.summaries['+572222'].messageCount).toBe(2);
  });
});
