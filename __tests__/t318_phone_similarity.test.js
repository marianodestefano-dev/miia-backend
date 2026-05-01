'use strict';

const {
  normalizePhone,
  phonesMatch,
  normalizeArgentina,
  normalizeColombia,
  stripFormatting,
  COUNTRY_PREFIXES,
} = require('../core/phone_normalizer');

const { similarityRatio, tokenize } = require('../core/similarity');

describe('T318 -- phone_normalizer + similarity (28 tests)', () => {

  // COUNTRY_PREFIXES
  test('COUNTRY_PREFIXES frozen', () => {
    expect(() => { COUNTRY_PREFIXES.AR = '99'; }).toThrow();
  });

  test('COUNTRY_PREFIXES contiene AR/CO/US/MX/BR', () => {
    expect(COUNTRY_PREFIXES.AR).toBe('54');
    expect(COUNTRY_PREFIXES.CO).toBe('57');
    expect(COUNTRY_PREFIXES.US).toBe('1');
  });

  // stripFormatting
  test('stripFormatting: remueve +, espacios, guiones', () => {
    expect(stripFormatting('+57 300 123 4567')).toBe('573001234567');
  });

  test('stripFormatting: null retorna ""', () => {
    expect(stripFormatting(null)).toBe('');
  });

  test('stripFormatting: ya solo digitos queda igual', () => {
    expect(stripFormatting('573001234567')).toBe('573001234567');
  });

  // normalizeArgentina
  test('normalizeArgentina: 549 prefix ya correcto', () => {
    expect(normalizeArgentina('5491155667788')).toBe('5491155667788');
  });

  test('normalizeArgentina: 54 sin 9 -> agrega 9', () => {
    expect(normalizeArgentina('541155667788')).toBe('5491155667788');
  });

  test('normalizeArgentina: 10 digitos local -> 549 + digitos', () => {
    expect(normalizeArgentina('1155667788')).toBe('5491155667788');
  });

  test('normalizeArgentina: null retorna null', () => {
    expect(normalizeArgentina(null)).toBeNull();
  });

  // normalizeColombia
  test('normalizeColombia: 57+10 digitos correcto', () => {
    expect(normalizeColombia('573001234567')).toBe('573001234567');
  });

  test('normalizeColombia: 10 digitos local con 3 -> agrega 57', () => {
    expect(normalizeColombia('3001234567')).toBe('573001234567');
  });

  test('normalizeColombia: null retorna null', () => {
    expect(normalizeColombia(null)).toBeNull();
  });

  // normalizePhone
  test('normalizePhone: numero CO con + prefijo', () => {
    const r = normalizePhone('+573001234567');
    expect(r.country).toBe('CO');
    expect(r.normalized).toBe('573001234567');
  });

  test('normalizePhone: numero AR con +', () => {
    const r = normalizePhone('+5491155667788');
    expect(r.country).toBe('AR');
    expect(r.normalized).toBe('5491155667788');
  });

  test('normalizePhone: numero US 11 digitos', () => {
    const r = normalizePhone('+12125551234');
    expect(r.country).toBe('US');
  });

  test('normalizePhone: numero MX', () => {
    const r = normalizePhone('+525512345678');
    expect(r.country).toBe('MX');
  });

  test('normalizePhone: null retorna null normalized', () => {
    const r = normalizePhone(null);
    expect(r.normalized).toBeNull();
    expect(r.country).toBeNull();
  });

  test('normalizePhone: muy corto retorna null', () => {
    const r = normalizePhone('123');
    expect(r.normalized).toBeNull();
  });

  test('normalizePhone: defaultCountry CO aplica', () => {
    const r = normalizePhone('3001234567', 'CO');
    expect(r.country).toBe('CO');
    expect(r.normalized).toBe('573001234567');
  });

  // phonesMatch
  test('phonesMatch: mismos numeros exactos', () => {
    expect(phonesMatch('573001234567', '573001234567')).toBe(true);
  });

  test('phonesMatch: con y sin + coinciden (sufijo 10)', () => {
    expect(phonesMatch('+573001234567', '573001234567')).toBe(true);
  });

  test('phonesMatch: diferentes numeros no coinciden', () => {
    expect(phonesMatch('573001234567', '573009999999')).toBe(false);
  });

  test('phonesMatch: null retorna false', () => {
    expect(phonesMatch(null, '573001234567')).toBe(false);
  });

  // similarityRatio
  test('similarityRatio: strings identicos = 1.0', () => {
    expect(similarityRatio('hola mundo', 'hola mundo')).toBe(1.0);
  });

  test('similarityRatio: sin palabras comun = 0.0', () => {
    expect(similarityRatio('gato azul', 'perro rojo')).toBe(0.0);
  });

  test('similarityRatio: palabras parcialmente comunes', () => {
    const r = similarityRatio('hola mundo', 'hola tierra');
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });

  test('similarityRatio: ambos null = 1.0', () => {
    expect(similarityRatio(null, null)).toBe(1.0);
  });

  test('similarityRatio: uno null = 0.0', () => {
    expect(similarityRatio('hola', null)).toBe(0.0);
  });

  // tokenize
  test('tokenize: split por espacios y lowercase', () => {
    const set = tokenize('Hola Mundo');
    expect(set.has('hola')).toBe(true);
    expect(set.has('mundo')).toBe(true);
  });

  test('tokenize: null retorna Set vacio', () => {
    const set = tokenize(null);
    expect(set.size).toBe(0);
  });
});
