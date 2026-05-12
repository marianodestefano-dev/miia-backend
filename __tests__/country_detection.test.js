'use strict';

/**
 * COUNTRY DETECTION TESTS — C-347 SEC-A (Wi → Vi).
 *
 * Valida C-342 B.2 (DO antes de US en detección de prefijos) y B.8 (política
 * "no atendemos US" en follow-up 3d). Covers:
 *   1. Resolución de prefijos +1809/+1829/+1849 → DO (no US).
 *   2. Resolución de prefijo +1XXX (no DO) → US.
 *   3. Early-return en processLeadFollowUps cuando country === 'US'.
 *
 * Duplicamos la lógica de server.js:getCountryFromPhone porque esa función
 * NO está exportada (zona crítica — no se toca sin ceremonia). El test vive
 * para bloquear regresión si alguien altera el orden de los checks o pierde
 * el test específico de 1809/1829/1849.
 */

const { getCountryByPhone } = require('../countries');

// Réplica exacta de server.js:11683-11702 (getCountryFromPhone).
// Si esta función cambia en server.js, actualizar aquí para mantener paridad.
function getCountryFromPhone(phone) {
  const num = String(phone).replace(/[^0-9]/g, '');
  if (num.startsWith('57')) return 'CO';
  if (num.startsWith('54')) return 'AR';
  if (num.startsWith('52')) return 'MX';
  if (num.startsWith('56')) return 'CL';
  if (num.startsWith('51')) return 'PE';
  if (num.startsWith('593')) return 'EC';
  if (num.startsWith('595')) return 'PY';
  if (num.startsWith('598')) return 'UY';
  if (num.startsWith('591')) return 'BO';
  if (num.startsWith('502')) return 'GT';
  if (num.startsWith('506')) return 'CR';
  if (num.startsWith('507')) return 'PA';
  if (num.startsWith('58'))  return 'VE';
  if (/^1(809|829|849)/.test(num)) return 'DO';
  if (num.startsWith('1')) return 'US';
  if (num.startsWith('34')) return 'ES';
  return 'CO';
}

describe('C-342 B.2 — DO antes de US en detección de prefijos', () => {
  test('+18095551234 → DO (no US)', () => {
    expect(getCountryFromPhone('+18095551234')).toBe('DO');
  });

  test('+18295551234 → DO (no US)', () => {
    expect(getCountryFromPhone('+18295551234')).toBe('DO');
  });

  test('+18495551234 → DO (no US)', () => {
    expect(getCountryFromPhone('+18495551234')).toBe('DO');
  });

  test('+12025551234 → US (Washington DC)', () => {
    expect(getCountryFromPhone('+12025551234')).toBe('US');
  });

  test('paridad con countries/index.js getCountryByPhone para DO', () => {
    expect(getCountryByPhone('+18095551234').code).toBe('DO');
    expect(getCountryByPhone('+18295551234').code).toBe('DO');
    expect(getCountryByPhone('+18495551234').code).toBe('DO');
  });

  test('paridad con countries/index.js getCountryByPhone para US', () => {
    expect(getCountryByPhone('+12025551234').code).toBe('US');
  });
});

describe('C-342 B.8 — Política no-US en follow-up 3d (early-return)', () => {
  // Réplica del check en server.js:11954 — si country === 'US', skip.
  function wouldSkipFollowUp(phone) {
    const country = getCountryFromPhone(phone);
    return country === 'US';
  }

  test('phone US (+12025551234) → skip follow-up', () => {
    expect(wouldSkipFollowUp('+12025551234')).toBe(true);
  });

  test('phone DO (+18095551234) → no skip (DO sí atendemos)', () => {
    expect(wouldSkipFollowUp('+18095551234')).toBe(false);
  });

  test('phone CO (+573001234567) → no skip', () => {
    expect(wouldSkipFollowUp('+573001234567')).toBe(false);
  });

  test('phone AR (+5491164431700) → no skip', () => {
    expect(wouldSkipFollowUp('+5491164431700')).toBe(false);
  });
});


// vi_coverage branches countries/index
describe('vi_coverage countries/index', () => {
  const { getCountryConfig, getCountryByPhone, getCountriesWithModule, COUNTRIES } = require('../countries');

  afterEach(() => {
    delete COUNTRIES['VI_NOSOURCE'];
    delete COUNTRIES['VI_NOTNULL'];
    delete COUNTRIES['VI_WADIFF'];
    delete COUNTRIES['VI_SRC_NOPLANS'];
    delete COUNTRIES['VI_USES_SRC'];
  });

  // BID 26: getCountryByPhone(null) -> if (!phone) return FALLBACK
  test('getCountryByPhone(null) => FALLBACK (truthy for !phone branch)', () => {
    const result = getCountryByPhone(null);
    // FALLBACK is COUNTRIES[INTL] which exists
    expect(result).toBeDefined();
  });

  test('getCountryByPhone(undefined) => FALLBACK', () => {
    const result = getCountryByPhone(undefined);
    expect(result).toBeDefined();
  });

  // BID 29+30: getCountriesWithModule
  test('getCountriesWithModule(wa) => array with at least one code', () => {
    const result = getCountriesWithModule('wa');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  test('getCountriesWithModule(nonexistent_xyz) => empty array', () => {
    const result = getCountriesWithModule('nonexistent_xyz');
    expect(result).toEqual([]);
  });

  // BID 11: _fallback points to nonexistent source -> if (!source) return cfg
  test('getCountryConfig _fallback to nonexistent source => returns original cfg', () => {
    COUNTRIES['VI_NOSOURCE'] = {
      code: 'VI_NOSOURCE',
      pricing: { _fallback: 'DOES_NOT_EXIST_XYZ', plans: { basic: { base: null, adic: null } } },
      bolsas: {}
    };
    const result = getCountryConfig('VI_NOSOURCE');
    expect(result.code).toBe('VI_NOSOURCE');
    expect(result.pricing._fallbackResolved).toBeUndefined();
  });

  // BID 14: _fallback set but plansAreNull=false -> if (!plansAreNull) return cfg
  test('getCountryConfig _fallback but plans not null => original cfg returned', () => {
    COUNTRIES['VI_NOTNULL'] = {
      code: 'VI_NOTNULL',
      pricing: { _fallback: 'INTL', plans: { basic: { base: 100, adic: 10 } } },
      bolsas: {}
    };
    const result = getCountryConfig('VI_NOTNULL');
    expect(result.pricing._fallbackResolved).toBeUndefined();
    expect(result.pricing.plans.basic.base).toBe(100);
  });

  // BIDs 20, 22: wa ternary false branch (wa._fallback !== fallbackKey)
  test('getCountryConfig _fallback INTL but bolsas.wa._fallback different => wa ternary false', () => {
    COUNTRIES['VI_WADIFF'] = {
      code: 'VI_WADIFF',
      pricing: { _fallback: 'INTL', plans: { basic: { base: null, adic: null } } },
      bolsas: {
        wa: { _fallback: 'AR', ranges: [], prices: [] },
        firma: { _fallback: 'AR', ranges: [], prices: [] }
      }
    };
    const result = getCountryConfig('VI_WADIFF');
    expect(result.pricing._fallbackResolved).toBe(true);
    // wa and firma should use fallback branch (cfg.bolsas.wa) since _fallback !== 'INTL'
    expect(result.bolsas.wa).toBeDefined();
  });

  // BIDs 15, 17: source has no plans -> false branch of plans ternary
  test('getCountryConfig fallback source with no plans => uses original pricing.plans', () => {
    COUNTRIES['VI_SRC_NOPLANS'] = {
      code: 'VI_SRC_NOPLANS',
      pricing: { adicEscalonado: false }  // no plans key
    };
    COUNTRIES['VI_USES_SRC'] = {
      code: 'VI_USES_SRC',
      pricing: { _fallback: 'VI_SRC_NOPLANS', plans: { basic: { base: null, adic: null } } },
      bolsas: {}
    };
    const result = getCountryConfig('VI_USES_SRC');
    expect(result.pricing._fallbackResolved).toBe(true);
    // source has no plans -> ternary false -> use pricing.plans
    expect(result.pricing.plans.basic.base).toBeNull();
  });
});
