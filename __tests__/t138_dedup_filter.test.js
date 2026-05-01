'use strict';
const { DedupFilter, hashMessage, DEFAULT_WINDOW_MS } = require('../core/dedup_filter');

const NOW = Date.now();

describe('constantes', () => {
  test('DEFAULT_WINDOW_MS = 10 min', () => {
    expect(DEFAULT_WINDOW_MS).toBe(10 * 60 * 1000);
  });
});

describe('hashMessage', () => {
  test('genera hash de 12 chars', () => {
    const h = hashMessage('+1234', 'hola');
    expect(h.length).toBe(12);
    expect(h).toMatch(/^[a-f0-9]+$/);
  });
  test('mismo input = mismo hash', () => {
    expect(hashMessage('+1234', 'hola')).toBe(hashMessage('+1234', 'hola'));
  });
  test('diferente phone = diferente hash', () => {
    expect(hashMessage('+1234', 'hola')).not.toBe(hashMessage('+5678', 'hola'));
  });
  test('diferente text = diferente hash', () => {
    expect(hashMessage('+1234', 'hola')).not.toBe(hashMessage('+1234', 'chau'));
  });
});

describe('DedupFilter — check validacion', () => {
  let df;
  beforeEach(() => { df = new DedupFilter({ windowMs: 60000 }); });

  test('lanza si phone falta', () => {
    expect(() => df.check(null, 'msg')).toThrow('phone requerido');
  });
  test('lanza si text es null', () => {
    expect(() => df.check('+1234', null)).toThrow('text requerido');
  });
});

describe('DedupFilter — deduplicacion', () => {
  let df;
  beforeEach(() => { df = new DedupFilter({ windowMs: 60000 }); });

  test('primer mensaje no es duplicado', () => {
    const r = df.check('+1234', 'hola', NOW);
    expect(r.isDuplicate).toBe(false);
    expect(typeof r.hash).toBe('string');
  });
  test('mismo mensaje = duplicado', () => {
    df.check('+1234', 'hola', NOW);
    const r = df.check('+1234', 'hola', NOW + 1000);
    expect(r.isDuplicate).toBe(true);
  });
  test('diferente texto = no duplicado', () => {
    df.check('+1234', 'hola', NOW);
    const r = df.check('+1234', 'chau', NOW + 1000);
    expect(r.isDuplicate).toBe(false);
  });
  test('diferente phone = no duplicado', () => {
    df.check('+1234', 'hola', NOW);
    const r = df.check('+5678', 'hola', NOW + 1000);
    expect(r.isDuplicate).toBe(false);
  });
  test('mensaje fuera de ventana no es duplicado', () => {
    df.check('+1234', 'hola', NOW);
    const r = df.check('+1234', 'hola', NOW + 70000); // despues de 70s, ventana 60s
    expect(r.isDuplicate).toBe(false);
  });
  test('size aumenta con nuevos mensajes', () => {
    df.check('+1234', 'msg1', NOW);
    df.check('+1234', 'msg2', NOW);
    expect(df.size).toBe(2);
  });
});

describe('DedupFilter — registerSent e isSentByMiia', () => {
  let df;
  beforeEach(() => { df = new DedupFilter({ windowMs: 60000 }); });

  test('registerSent lanza si msgId falta', () => {
    expect(() => df.registerSent(null)).toThrow('msgId requerido');
  });
  test('isSentByMiia true para msg registrado', () => {
    df.registerSent('msg123', NOW);
    expect(df.isSentByMiia('msg123', NOW)).toBe(true);
  });
  test('isSentByMiia false para msg no registrado', () => {
    expect(df.isSentByMiia('msgDesconocido', NOW)).toBe(false);
  });
  test('isSentByMiia false despues de ventana', () => {
    df.registerSent('msg123', NOW);
    expect(df.isSentByMiia('msg123', NOW + 70000)).toBe(false);
  });
});

describe('DedupFilter — clear', () => {
  test('clear vacia el filtro', () => {
    const df = new DedupFilter({ windowMs: 60000 });
    df.check('+1234', 'msg', NOW);
    df.clear();
    expect(df.size).toBe(0);
    expect(df.check('+1234', 'msg', NOW).isDuplicate).toBe(false);
  });
});
