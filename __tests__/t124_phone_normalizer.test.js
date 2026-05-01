'use strict';
const { normalizePhone, phonesMatch, normalizeArgentina, normalizeColombia, stripFormatting } = require('../core/phone_normalizer');

describe('stripFormatting', () => {
  test('remueve espacios, guiones, parentesis', () => {
    expect(stripFormatting('+54 11 5555-1234')).toBe('541155551234');
  });
  test('null retorna vacio', () => { expect(stripFormatting(null)).toBe(''); });
  test('numero limpio permanece igual', () => { expect(stripFormatting('541155551234')).toBe('541155551234'); });
});

describe('normalizeArgentina', () => {
  test('549XXXXXXXXXXX permanece igual', () => {
    expect(normalizeArgentina('5491155551234')).toBe('5491155551234');
  });
  test('54 sin 9 agrega 9', () => {
    expect(normalizeArgentina('541155551234')).toBe('5491155551234');
  });
  test('10 digitos agrega 549', () => {
    expect(normalizeArgentina('1155551234')).toBe('5491155551234');
  });
  test('11 digitos empezando con 9 agrega 54', () => {
    expect(normalizeArgentina('91155551234')).toBe('5491155551234');
  });
});

describe('normalizeColombia', () => {
  test('57XXXXXXXXXX permanece igual', () => {
    expect(normalizeColombia('573001234567')).toBe('573001234567');
  });
  test('10 digitos empezando con 3 agrega 57', () => {
    expect(normalizeColombia('3001234567')).toBe('573001234567');
  });
});

describe('normalizePhone — Argentina', () => {
  test('numero con +549 prefix', () => {
    const r = normalizePhone('+5491155551234');
    expect(r.country).toBe('AR');
    expect(r.normalized).toBe('5491155551234');
  });
  test('numero con +54 sin 9', () => {
    const r = normalizePhone('+541155551234');
    expect(r.country).toBe('AR');
    expect(r.normalized).toBe('5491155551234');
  });
  test('numero con espacios y guiones', () => {
    const r = normalizePhone('+54 9 11 5555-1234');
    expect(r.country).toBe('AR');
    expect(r.normalized).not.toBeNull();
  });
});

describe('normalizePhone — Colombia', () => {
  test('numero colombiano +573001234567', () => {
    const r = normalizePhone('+573001234567');
    expect(r.country).toBe('CO');
    expect(r.normalized).toBe('573001234567');
  });
  test('10 digitos con defaultCountry CO', () => {
    const r = normalizePhone('3001234567', 'CO');
    expect(r.country).toBe('CO');
    expect(r.normalized).toBe('573001234567');
  });
});

describe('normalizePhone — otros casos', () => {
  test('null retorna normalized=null', () => {
    const r = normalizePhone(null);
    expect(r.normalized).toBeNull();
    expect(r.country).toBeNull();
  });
  test('numero muy corto retorna null', () => {
    const r = normalizePhone('123');
    expect(r.normalized).toBeNull();
  });
  test('numero US +12125551234', () => {
    const r = normalizePhone('+12125551234');
    expect(r.country).toBe('US');
  });
  test('conserva original siempre', () => {
    const r = normalizePhone('+54 11 5555-1234');
    expect(r.original).toBe('+54 11 5555-1234');
  });
});

describe('phonesMatch', () => {
  test('mismos digitos = match', () => {
    expect(phonesMatch('5491155551234', '5491155551234')).toBe(true);
  });
  test('con y sin codigo pais = match por sufijo', () => {
    expect(phonesMatch('5491155551234', '1155551234')).toBe(true);
  });
  test('numeros diferentes = no match', () => {
    expect(phonesMatch('5491155551234', '5491155559999')).toBe(false);
  });
  test('null = false', () => {
    expect(phonesMatch(null, '5491155551234')).toBe(false);
  });
});
