'use strict';
const { detectLanguage, detectDominantLanguage, tokenize, SUPPORTED_LANGS } = require('../core/language_detector');

describe('SUPPORTED_LANGS', () => {
  test('incluye es, en, pt', () => {
    expect(SUPPORTED_LANGS).toContain('es');
    expect(SUPPORTED_LANGS).toContain('en');
    expect(SUPPORTED_LANGS).toContain('pt');
  });
});

describe('tokenize', () => {
  test('convierte a minusculas y remueve puntuacion', () => {
    const t = tokenize('Hola! Como estas?');
    expect(t).toContain('hola');
    expect(t).toContain('como');
    expect(t).toContain('estas');
  });
  test('remueve tokens de menos de 2 chars', () => {
    const t = tokenize('a el yo');
    expect(t).not.toContain('a');
  });
  test('remueve acentos para normalizacion', () => {
    const t = tokenize('información también');
    expect(t.some(w => w.includes('informacion') || w.includes('informaci'))).toBe(true);
  });
});

describe('detectLanguage', () => {
  test('null retorna lang=null confidence=0', () => {
    const r = detectLanguage(null);
    expect(r.lang).toBeNull();
    expect(r.confidence).toBe(0);
  });
  test('string vacio retorna null', () => {
    expect(detectLanguage('').lang).toBeNull();
  });
  test('texto muy corto retorna null', () => {
    expect(detectLanguage('hi').lang).toBeNull();
  });
  test('detecta espanol', () => {
    const r = detectLanguage('hola como estas quiero informacion sobre el servicio gracias');
    expect(r.lang).toBe('es');
    expect(r.confidence).toBeGreaterThan(0);
  });
  test('detecta ingles', () => {
    const r = detectLanguage('hello how are you i want information about the service thanks');
    expect(r.lang).toBe('en');
    expect(r.confidence).toBeGreaterThan(0);
  });
  test('detecta portugues', () => {
    const r = detectLanguage('ola bom dia quero informacao sobre o servico obrigado voce');
    expect(r.lang).toBe('pt');
    expect(r.confidence).toBeGreaterThan(0);
  });
  test('retorna scores para los 3 idiomas', () => {
    const r = detectLanguage('hello world how are you today');
    expect(r.scores).toHaveProperty('es');
    expect(r.scores).toHaveProperty('en');
    expect(r.scores).toHaveProperty('pt');
  });
  test('texto sin tokens conocidos retorna lang=null', () => {
    const r = detectLanguage('xyzzy qwerty zxcvbnm asdfghjkl');
    expect(r.lang).toBeNull();
  });
});

describe('detectDominantLanguage', () => {
  test('array vacio retorna null', () => {
    const r = detectDominantLanguage([]);
    expect(r.lang).toBeNull();
  });
  test('null retorna null', () => {
    expect(detectDominantLanguage(null).lang).toBeNull();
  });
  test('mayoria espanol = es', () => {
    const texts = [
      'hola como estas quiero informacion',
      'necesito ayuda con el servicio favor',
      'hello how are you',
    ];
    const r = detectDominantLanguage(texts);
    expect(r.lang).toBe('es');
    expect(r.confidence).toBeGreaterThan(0);
  });
  test('confidence <= 1', () => {
    const r = detectDominantLanguage(['hola como estas', 'hello world thanks you']);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });
});
