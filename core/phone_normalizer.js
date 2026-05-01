'use strict';

/**
 * MIIA — Phone Normalizer (T124)
 * Normaliza numeros de telefono para lookup consistente.
 * Cubre Argentina (54), Colombia (57), y formato generico E.164.
 */

const COUNTRY_PREFIXES = Object.freeze({
  AR: '54',
  CO: '57',
  US: '1',
  MX: '52',
  BR: '55',
});

/**
 * Remueve todos los caracteres no numericos excepto '+' al inicio.
 */
function stripFormatting(phone) {
  if (!phone || typeof phone !== 'string') return '';
  return phone.replace(/[^\d+]/g, '').replace(/^\+/, '');
}

/**
 * Normaliza un numero argentino al formato 549XXXXXXXXXX (11 digitos sin codigo pais duplicado).
 * Convierte 541155XXXXXX -> 5491155XXXXXX (agrega el 9 para celular).
 * @param {string} digits - solo digitos, sin +
 * @returns {string|null}
 */
function normalizeArgentina(digits) {
  if (!digits) return null;
  // Ya tiene 549 al inicio (54 + 9 + area)
  if (digits.startsWith('549') && digits.length >= 12) return digits;
  // Tiene 54 + area sin 9
  if (digits.startsWith('54') && !digits.startsWith('549')) {
    const local = digits.slice(2);
    return '549' + local;
  }
  // Numero local (sin codigo pais)
  if (digits.startsWith('9') && digits.length === 11) return '54' + digits;
  if (digits.length === 10) return '549' + digits; // area + numero
  return null;
}

/**
 * Normaliza un numero colombiano a 57XXXXXXXXXX (12 digitos).
 */
function normalizeColombia(digits) {
  if (!digits) return null;
  if (digits.startsWith('57') && digits.length === 12) return digits;
  if (digits.startsWith('57') && digits.length > 12) return digits.slice(0, 12);
  if (digits.length === 10 && digits.startsWith('3')) return '57' + digits;
  if (digits.length === 10) return '57' + digits;
  return null;
}

/**
 * Normaliza un numero a formato E.164 (sin +).
 * @param {string} phone
 * @param {string} [defaultCountry] - 'AR'|'CO'|'US' etc (default: detect from prefix)
 * @returns {{ normalized: string|null, country: string|null, original: string }}
 */
function normalizePhone(phone, defaultCountry = null) {
  const original = phone;
  if (!phone || typeof phone !== 'string') {
    return { normalized: null, country: null, original };
  }

  const digits = stripFormatting(phone);
  if (digits.length < 7) {
    return { normalized: null, country: null, original };
  }

  // Detectar pais por prefijo
  if (digits.startsWith('549') || digits.startsWith('54')) {
    const normalized = normalizeArgentina(digits);
    return { normalized, country: 'AR', original };
  }
  if (digits.startsWith('57')) {
    const normalized = normalizeColombia(digits);
    return { normalized, country: 'CO', original };
  }
  if (digits.startsWith('1') && digits.length === 11) {
    return { normalized: digits, country: 'US', original };
  }
  if (digits.startsWith('52')) {
    return { normalized: digits, country: 'MX', original };
  }
  if (digits.startsWith('55')) {
    return { normalized: digits, country: 'BR', original };
  }

  // Fallback: aplicar pais por defecto
  if (defaultCountry === 'AR') {
    const normalized = normalizeArgentina(digits);
    return { normalized, country: 'AR', original };
  }
  if (defaultCountry === 'CO') {
    const normalized = normalizeColombia(digits);
    return { normalized, country: 'CO', original };
  }

  return { normalized: digits, country: null, original };
}

/**
 * Compara dos numeros de telefono normalizados (fuzzy: compara sufijo de 10 digitos).
 */
function phonesMatch(a, b) {
  if (!a || !b) return false;
  const da = stripFormatting(a);
  const db = stripFormatting(b);
  if (da === db) return true;
  // Comparar sufijo ultimos 10 digitos
  const sa = da.slice(-10);
  const sb = db.slice(-10);
  return sa.length === 10 && sa === sb;
}

module.exports = {
  normalizePhone,
  phonesMatch,
  normalizeArgentina,
  normalizeColombia,
  stripFormatting,
  COUNTRY_PREFIXES,
};
