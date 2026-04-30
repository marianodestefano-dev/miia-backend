'use strict';

/**
 * T75 — countries fallback resolution (BR.json post-T41 con _fallback: INTL)
 *
 * Bug: countries/index.js NO respetaba el _fallback declarado en JSON.
 * BR.json marca _fallback: 'INTL' + plans null pendiente firma Mariano.
 * getCountryConfig('BR') antes devolvia plans null directo.
 * Ahora: resuelve fallback, devuelve INTL pricing para BR sin inventar valores.
 */

const { getCountryConfig, COUNTRIES } = require('../countries');

describe('T75 §A — BR fallback resolution', () => {
  test('getCountryConfig("BR") devuelve plans NO null (fallback INTL)', () => {
    const br = getCountryConfig('BR');
    expect(br).toBeDefined();
    expect(br.code).toBe('BR');
    expect(br.pricing).toBeDefined();
    expect(br.pricing.plans).toBeDefined();
    expect(br.pricing.plans.esencial.base).not.toBeNull();
    expect(br.pricing.plans.pro.base).not.toBeNull();
    expect(br.pricing.plans.titanium.base).not.toBeNull();
  });

  test('BR plans coinciden con INTL plans (fallback aplicado)', () => {
    const br = getCountryConfig('BR');
    const intl = COUNTRIES.INTL;
    expect(br.pricing.plans.esencial.base).toBe(intl.pricing.plans.esencial.base);
    expect(br.pricing.plans.pro.base).toBe(intl.pricing.plans.pro.base);
    expect(br.pricing.plans.titanium.base).toBe(intl.pricing.plans.titanium.base);
  });

  test('BR pricing._fallbackResolved=true marca explicit', () => {
    const br = getCountryConfig('BR');
    expect(br.pricing._fallbackResolved).toBe(true);
    expect(br.pricing._fallbackSource).toBe('INTL');
  });

  test('BR currency code BRL (no copia INTL USD — moneda especifica BR)', () => {
    const br = getCountryConfig('BR');
    expect(br.currency.code).toBe('BRL');
    expect(br.currency.symbol).toBe('R$');
  });

  test('BR dialect / lang / pais_tag preservados (no fallback)', () => {
    const br = getCountryConfig('BR');
    expect(br.lang).toBe('pt');
    expect(br.dialect_code).toBe('pt_br');
    expect(br.pais_tag).toBe('BRASIL');
  });

  test('BR bolsas WA/firma resueltos via fallback INTL', () => {
    const br = getCountryConfig('BR');
    const intl = COUNTRIES.INTL;
    if (intl.bolsas && intl.bolsas.wa) {
      expect(br.bolsas.wa.prices).toEqual(intl.bolsas.wa.prices);
    }
  });
});

describe('T75 §B — paises sin _fallback se mantienen intactos', () => {
  test('CO devuelve plans propios (no fallback)', () => {
    const co = getCountryConfig('CO');
    expect(co.pricing.plans.esencial.base).toBe(125000);
    expect(co.pricing._fallbackResolved).toBeUndefined();
  });

  test('AR devuelve plans propios (no fallback)', () => {
    const ar = getCountryConfig('AR');
    expect(ar.pricing.plans.esencial.base).toBe(45);
    expect(ar.pricing._fallbackResolved).toBeUndefined();
  });

  test('MX devuelve plans propios MXN', () => {
    const mx = getCountryConfig('MX');
    expect(mx.currency.code).toBe('MXN');
    expect(mx.pricing._fallbackResolved).toBeUndefined();
  });
});

describe('T75 §C — getCountryConfig fallback INTL para code desconocido', () => {
  test('code null → INTL fallback', () => {
    const r = getCountryConfig(null);
    expect(r).toBeDefined();
    expect(r.code).toBe('INTL');
  });

  test('code "ZZ" desconocido → INTL fallback', () => {
    const r = getCountryConfig('ZZ');
    expect(r.code).toBe('INTL');
  });

  test('code lowercase normalizado', () => {
    const r = getCountryConfig('br');
    expect(r.code).toBe('BR');
    expect(r.pricing._fallbackResolved).toBe(true);
  });
});

describe('T75 §D — anti-regresion: NO mutate config original', () => {
  test('getCountryConfig("BR") no muta COUNTRIES.BR', () => {
    const before = JSON.stringify(COUNTRIES.BR.pricing.plans);
    getCountryConfig('BR');
    getCountryConfig('BR');
    const after = JSON.stringify(COUNTRIES.BR.pricing.plans);
    expect(after).toBe(before);
    // Plans original siguen null (la fuente JSON no cambia)
    expect(COUNTRIES.BR.pricing.plans.esencial.base).toBeNull();
  });
});
