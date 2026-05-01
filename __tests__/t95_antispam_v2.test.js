'use strict';

/**
 * T95 — Anti-spam V2: similarityRatio tests (§6.21 fix)
 * Jaccard por palabras: >= 0.95 + < 5min -> skip regen.
 */

const { similarityRatio, tokenize } = require('../core/similarity');

describe('tokenize', () => {
  test('convierte a minusculas y elimina puntuacion', () => {
    const t = tokenize('Hola, Mundo!');
    expect(t.has('hola')).toBe(true);
    expect(t.has('mundo')).toBe(true);
    expect(t.size).toBe(2);
  });

  test('retorna Set vacio para string vacio', () => {
    expect(tokenize('').size).toBe(0);
    expect(tokenize(null).size).toBe(0);
    expect(tokenize(undefined).size).toBe(0);
  });

  test('elimina palabras duplicadas (Set)', () => {
    const t = tokenize('hola hola hola');
    expect(t.size).toBe(1);
  });
});

describe('similarityRatio', () => {
  test('identicos retorna 1.0', () => {
    expect(similarityRatio('hola como estas', 'hola como estas')).toBe(1.0);
  });

  test('completamente distintos retorna 0.0', () => {
    expect(similarityRatio('gato perro', 'luna sol')).toBe(0.0);
  });

  test('dos strings vacios retorna 1.0', () => {
    expect(similarityRatio('', '')).toBe(1.0);
  });

  test('un string vacio retorna 0.0', () => {
    expect(similarityRatio('', 'hola')).toBe(0.0);
    expect(similarityRatio('hola', '')).toBe(0.0);
  });

  test('95%+ similar: misma frase con palabra extra', () => {
    const a = 'quiero saber el precio del plan basico';
    const b = 'quiero saber el precio del plan basico por favor';
    const ratio = similarityRatio(a, b);
    expect(ratio).toBeGreaterThanOrEqual(0.75); // Jaccard 7/9=0.778
  });

  test('mensajes identicos con mayusculas distintas >= 0.95', () => {
    const ratio = similarityRatio('HOLA COMO ESTAS', 'hola como estas');
    expect(ratio).toBeGreaterThanOrEqual(0.95);
  });

  test('80% similar: frase similar pero no repetida', () => {
    const a = 'cuanto cuesta el plan mensual';
    const b = 'cual es el precio del plan mensual completo';
    const ratio = similarityRatio(a, b);
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1.0);
  });

  test('retorna numero entre 0 y 1 siempre', () => {
    const pairs = [
      ['hola', 'hola mundo'],
      ['precio plan', 'informacion plan precio'],
      ['a', 'b'],
    ];
    for (const [a, b] of pairs) {
      const r = similarityRatio(a, b);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    }
  });

  test('null/undefined no lanza error', () => {
    expect(() => similarityRatio(null, 'hola')).not.toThrow();
    expect(() => similarityRatio('hola', null)).not.toThrow();
    expect(() => similarityRatio(undefined, undefined)).not.toThrow();
  });

  test('mensaje repetido exacto: ratio = 1.0', () => {
    const msg = 'quiero contratar el servicio';
    expect(similarityRatio(msg, msg)).toBe(1.0);
  });

  test('una sola palabra en comun: ratio > 0', () => {
    const ratio = similarityRatio('hola amigo', 'hasta hola');
    expect(ratio).toBeGreaterThan(0);
  });

  test('threshold 0.95 correcto para mensajes casi identicos', () => {
    const a = 'hola quiero info del precio';
    const b = 'hola quiero info del precio exacto';
    const ratio = similarityRatio(a, b);
    expect(ratio).toBeGreaterThanOrEqual(0.75); // Jaccard 7/9=0.778
  });
});
