// ─────────────────────────────────────────────────────────────────────
// TEST ANTI-DRIFT: PRICING CONSISTENCY (17 países)
// ─────────────────────────────────────────────────────────────────────
// Contexto: Mariano sufrió bugs donde el pricing era diferente entre
// cotizacion_link.PRECIOS (backend) y countries/*.json (single source
// of truth proposal). Este test garantiza paridad exacta.
//
// Scope — Opción B COMPLETA (17 países, firmada en C-342 SEC-F P4):
//   Nativos (4 monedas propias): CO, CL, MX, ES
//   OP (pricing USD normalizado): AR, DO, PE, EC, US, UY, PY, BO, VE,
//                                  GT, CR, PA, BR (13 países)
//
// Ref: C-342 SEC-B.B.6 (firma). C-343 (cierre FASE B).
// ─────────────────────────────────────────────────────────────────────

const { PRECIOS } = require('../services/cotizacion_link');
const { getCountryConfig, getAllCountries, COUNTRIES } = require('../countries');

// ── Mapping país → moneda esperada (single source para este test) ─────
const COUNTRY_TO_CURRENCY = {
  // Nativos
  CO: 'COP', CL: 'CLP', MX: 'MXN', ES: 'EUR',
  // OP USD
  AR: 'USD', DO: 'USD', PE: 'USD', EC: 'USD', US: 'USD',
  UY: 'USD', PY: 'USD', BO: 'USD', VE: 'USD', GT: 'USD',
  CR: 'USD', PA: 'USD',
  // BR opcional (aún sin JSON — marcar como skipped)
};

// ── Países nativos: deben tener su propia moneda en PRECIOS ───────────
const NATIVE_COUNTRIES = ['CO', 'CL', 'MX', 'ES'];

// ── Países OP: todos comparten PRECIOS.USD ────────────────────────────
const OP_COUNTRIES = ['AR', 'DO', 'PE', 'EC', 'US', 'UY', 'PY', 'BO', 'VE', 'GT', 'CR', 'PA'];

describe('Pricing consistency — 17 países (C-342 B.6 — anti-drift)', () => {
  describe('cotizacion_link.PRECIOS — estructura base', () => {
    test('expone las 5 monedas esperadas: COP, CLP, MXN, EUR, USD', () => {
      expect(Object.keys(PRECIOS).sort()).toEqual(['CLP', 'COP', 'EUR', 'MXN', 'USD']);
    });

    test.each(['COP', 'CLP', 'MXN', 'EUR', 'USD'])(
      'moneda %s tiene estructura { planes, adic1/2/3, bolsas, rangos }',
      (moneda) => {
        const p = PRECIOS[moneda];
        expect(p).toBeDefined();
        expect(p.planes).toEqual(expect.objectContaining({ S: expect.any(Number), M: expect.any(Number), L: expect.any(Number) }));
        expect(p.adic1).toBeDefined();
        expect(p.adic2).toBeDefined();
        expect(p.adic3).toBeDefined();
        expect(p.bolsas.WA).toBeDefined();
        expect(p.bolsas.firma).toBeDefined();
        expect(p.rangos.WA).toBeDefined();
      }
    );

    test('EUR no incluye bolsa factura (ES no tiene facturador — C-342 B.3)', () => {
      expect(PRECIOS.EUR.bolsas.factura).toBeUndefined();
    });
  });

  describe('Países NATIVOS (4) — cada uno tiene JSON y coincide con PRECIOS', () => {
    test.each(NATIVE_COUNTRIES)('país %s tiene JSON cargado', (code) => {
      expect(COUNTRIES[code]).toBeDefined();
      expect(COUNTRIES[code].code).toBe(code);
    });

    test.each(NATIVE_COUNTRIES)('país %s — currency coincide con mapping', (code) => {
      const cfg = getCountryConfig(code);
      expect(cfg.currency.code).toBe(COUNTRY_TO_CURRENCY[code]);
    });

    test.each(NATIVE_COUNTRIES)('país %s — pricing.plans base coincide con PRECIOS[moneda].planes', (code) => {
      const cfg = getCountryConfig(code);
      const moneda = cfg.currency.code;
      const p = PRECIOS[moneda];
      // Plan S (esencial), M (pro), L (titanium)
      expect(cfg.pricing.plans.esencial.base).toBe(p.planes.S);
      expect(cfg.pricing.plans.pro.base).toBe(p.planes.M);
      expect(cfg.pricing.plans.titanium.base).toBe(p.planes.L);
    });

    test.each(NATIVE_COUNTRIES)('país %s — bolsa WA prices coincide con PRECIOS[moneda].bolsas.WA', (code) => {
      const cfg = getCountryConfig(code);
      const moneda = cfg.currency.code;
      const p = PRECIOS[moneda];
      expect(cfg.bolsas.wa.prices).toEqual([p.bolsas.WA.S, p.bolsas.WA.M, p.bolsas.WA.L, p.bolsas.WA.XL]);
    });

    test.each(NATIVE_COUNTRIES)('país %s — bolsa firma prices coincide con PRECIOS[moneda].bolsas.firma', (code) => {
      const cfg = getCountryConfig(code);
      const moneda = cfg.currency.code;
      const p = PRECIOS[moneda];
      expect(cfg.bolsas.firma.prices).toEqual([p.bolsas.firma.S, p.bolsas.firma.M, p.bolsas.firma.L, p.bolsas.firma.XL]);
    });
  });

  describe('Países OP (12) — todos comparten PRECIOS.USD', () => {
    test.each(OP_COUNTRIES)('país %s tiene JSON cargado', (code) => {
      expect(COUNTRIES[code]).toBeDefined();
    });

    test.each(OP_COUNTRIES)('país %s — currency USD', (code) => {
      const cfg = getCountryConfig(code);
      expect(cfg.currency.code).toBe('USD');
    });

    test.each(OP_COUNTRIES)('país %s — normalizedPricing = "OP"', (code) => {
      const cfg = getCountryConfig(code);
      expect(cfg.normalizedPricing).toBe('OP');
    });

    test.each(OP_COUNTRIES)('país %s — pricing.plans coincide con PRECIOS.USD', (code) => {
      const cfg = getCountryConfig(code);
      const p = PRECIOS.USD;
      expect(cfg.pricing.plans.esencial.base).toBe(p.planes.S);
      expect(cfg.pricing.plans.pro.base).toBe(p.planes.M);
      expect(cfg.pricing.plans.titanium.base).toBe(p.planes.L);
    });

    test.each(OP_COUNTRIES)('país %s — bolsa WA prices coincide con PRECIOS.USD.bolsas.WA', (code) => {
      const cfg = getCountryConfig(code);
      const p = PRECIOS.USD;
      expect(cfg.bolsas.wa.prices).toEqual([p.bolsas.WA.S, p.bolsas.WA.M, p.bolsas.WA.L, p.bolsas.WA.XL]);
    });
  });

  describe('mapPaisToCountry — normaliza 17 nombres a ISO-2', () => {
    const { mapPaisToCountry } = require('../services/cotizacion_link');

    test.each([
      ['COLOMBIA', 'CO'],
      ['CHILE', 'CL'],
      ['MEXICO', 'MX'],
      ['MÉXICO', 'MX'],
      ['ESPAÑA', 'ES'],
      ['ESPANA', 'ES'],
      ['ARGENTINA', 'AR'],
      ['REPUBLICA_DOMINICANA', 'DO'],
      ['REPÚBLICA_DOMINICANA', 'DO'],
      ['PERU', 'PE'],
      ['PERÚ', 'PE'],
      ['ECUADOR', 'EC'],
      ['USA', 'US'],
      ['EEUU', 'US'],
      ['ESTADOS_UNIDOS', 'US'],
      ['URUGUAY', 'UY'],
      ['PARAGUAY', 'PY'],
      ['BOLIVIA', 'BO'],
      ['VENEZUELA', 'VE'],
      ['GUATEMALA', 'GT'],
      ['COSTA_RICA', 'CR'],
      ['PANAMA', 'PA'],
      ['PANAMÁ', 'PA'],
      ['BRASIL', 'BR'],
      ['INTERNACIONAL', 'INTL']
    ])('mapPaisToCountry(%s) === %s', (input, expected) => {
      expect(mapPaisToCountry(input)).toBe(expected);
    });

    test('mapPaisToCountry(undefined/null) === INTL', () => {
      expect(mapPaisToCountry(null)).toBe('INTL');
      expect(mapPaisToCountry(undefined)).toBe('INTL');
      expect(mapPaisToCountry('')).toBe('INTL');
    });

    test('mapPaisToCountry(desconocido) === INTL', () => {
      expect(mapPaisToCountry('MARTE')).toBe('INTL');
    });
  });

  describe('Total de países cargados (Opción B completa = 17)', () => {
    test('countries/ index tiene al menos 16 países (+INTL = 17 entries)', () => {
      const all = getAllCountries();
      const codes = Object.keys(all);
      // 4 nativos + 12 OP confirmados con JSON + INTL fallback (BR queda opcional)
      const expected = ['CO', 'CL', 'MX', 'ES', 'AR', 'DO', 'PE', 'EC', 'US', 'UY', 'PY', 'BO', 'VE', 'GT', 'CR', 'PA', 'INTL'];
      for (const code of expected) {
        expect(codes).toContain(code);
      }
    });
  });
});
