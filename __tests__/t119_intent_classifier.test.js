'use strict';
const { classifyIntent, classifyBatch, INTENTS, CONFIDENCE } = require('../core/intent_classifier');

describe('INTENTS constante', () => {
  test('contiene los 7 intents esperados', () => {
    expect(INTENTS).toContain('booking');
    expect(INTENTS).toContain('price');
    expect(INTENTS).toContain('complaint');
    expect(INTENTS).toContain('info');
    expect(INTENTS).toContain('greeting');
    expect(INTENTS).toContain('farewell');
    expect(INTENTS).toContain('unknown');
    expect(INTENTS.length).toBe(7);
  });
});

describe('classifyIntent — validacion inputs', () => {
  test('null retorna unknown confidence 0', () => {
    const r = classifyIntent(null);
    expect(r.intent).toBe('unknown');
    expect(r.confidence).toBe(0);
    expect(r.signals).toEqual([]);
  });
  test('string vacio retorna unknown confidence 0', () => {
    const r = classifyIntent('');
    expect(r.intent).toBe('unknown');
    expect(r.confidence).toBe(0);
  });
  test('numero retorna unknown', () => {
    const r = classifyIntent(42);
    expect(r.intent).toBe('unknown');
  });
});

describe('classifyIntent — deteccion de intents', () => {
  test('detecta greeting', () => {
    const r = classifyIntent('Hola, buenos dias!');
    expect(r.intent).toBe('greeting');
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
    expect(r.signals.length).toBeGreaterThan(0);
  });
  test('detecta farewell', () => {
    const r = classifyIntent('Adios, hasta luego');
    expect(r.intent).toBe('farewell');
    expect(r.signals.length).toBeGreaterThan(0);
  });
  test('detecta booking', () => {
    const r = classifyIntent('quiero agendar una cita para manana');
    expect(r.intent).toBe('booking');
  });
  test('detecta price', () => {
    const r = classifyIntent('cuanto cuesta el servicio?');
    expect(r.intent).toBe('price');
  });
  test('detecta complaint', () => {
    const r = classifyIntent('tengo una queja, el servicio fue pesimo');
    expect(r.intent).toBe('complaint');
  });
  test('detecta info', () => {
    const r = classifyIntent('necesito informacion sobre sus horarios');
    expect(r.intent).toBe('info');
  });
  test('texto sin patron = unknown con LOW confidence', () => {
    const r = classifyIntent('asdfghjkl qwerty 1234');
    expect(r.intent).toBe('unknown');
    expect(r.confidence).toBe(CONFIDENCE.LOW);
  });
});

describe('classifyIntent — prioridad', () => {
  test('complaint > greeting cuando ambos presentes', () => {
    const r = classifyIntent('hola, tengo una queja grave');
    expect(r.intent).toBe('complaint');
  });
  test('booking > price cuando ambos presentes', () => {
    const r = classifyIntent('quiero reservar, cuanto cuesta?');
    expect(r.intent).toBe('booking');
  });
  test('un solo match = HIGH confidence', () => {
    const r = classifyIntent('quiero agendar un turno');
    expect(r.confidence).toBe(CONFIDENCE.HIGH);
  });
  test('multiples matches = MEDIUM confidence', () => {
    const r = classifyIntent('hola quiero reservar');
    expect(r.confidence).toBe(CONFIDENCE.MEDIUM);
  });
});

describe('classifyBatch', () => {
  test('array vacio = unknown dominant', () => {
    const r = classifyBatch([]);
    expect(r.dominant).toBe('unknown');
    expect(r.results).toEqual([]);
  });
  test('null retorna unknown', () => {
    const r = classifyBatch(null);
    expect(r.dominant).toBe('unknown');
  });
  test('calcula dominant correctamente', () => {
    const texts = ['hola', 'buenos dias', 'quiero agendar'];
    const r = classifyBatch(texts);
    expect(r.dominant).toBe('greeting');
    expect(r.results.length).toBe(3);
  });
  test('retorna results con intent por mensaje', () => {
    const r = classifyBatch(['hola', 'quiero reservar']);
    expect(r.results[0].intent).toBe('greeting');
    expect(r.results[1].intent).toBe('booking');
  });
});
