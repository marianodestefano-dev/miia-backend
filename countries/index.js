'use strict';

/**
 * COUNTRIES — Loader de configuración por país
 *
 * Uso:
 *   const { getCountryConfig, getCountryByPhone, getAllCountries } = require('./countries');
 *
 *   const mx = getCountryConfig('MX');
 *   // mx.rules.iva.rate → 0.16
 *   // mx.modules.factura.available → true
 *
 *   const co = getCountryByPhone('573001234567');
 *   // co.code → 'CO'
 */

const fs   = require('fs');
const path = require('path');

// ── Cargar todos los JSONs al inicio (son estáticos, no cambian en runtime) ──
const COUNTRIES = {};
const PHONE_MAP = []; // { prefix, code, length } ordenado por longitud descendente

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

for (const file of files) {
  try {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const config = JSON.parse(raw);
    if (config.code) {
      COUNTRIES[config.code] = config;
      // Registrar prefijos telefónicos
      if (Array.isArray(config.phonePrefix)) {
        for (const prefix of config.phonePrefix) {
          PHONE_MAP.push({ prefix, code: config.code, length: prefix.length });
        }
      }
    }
  } catch (e) {
    console.error(`[COUNTRIES] ❌ Error cargando ${file}: ${e.message}`);
  }
}

// Ordenar por longitud de prefijo descendente (más específico primero)
// Ej: "1809" (DO) debe matchear antes que "1" (US)
PHONE_MAP.sort((a, b) => b.length - a.length);

const FALLBACK = COUNTRIES['INTL'] || null;

console.log(`[COUNTRIES] ✅ ${Object.keys(COUNTRIES).length} países cargados: ${Object.keys(COUNTRIES).join(', ')}`);

/**
 * Obtiene la configuración de un país por código.
 * Retorna INTL como fallback si no se encuentra.
 *
 * @param {string} code - Código de país (CO, CL, MX, ES, AR, DO, PE, etc.)
 * @returns {object} Configuración del país
 */
function getCountryConfig(code) {
  if (!code) return FALLBACK;
  const normalized = code.toUpperCase().trim();
  return COUNTRIES[normalized] || FALLBACK;
}

/**
 * Detecta el país por número de teléfono (prefijo).
 * Maneja casos especiales como Rep. Dominicana (+1809/1829/1849) vs EEUU (+1).
 *
 * @param {string} phone - Número de teléfono (puede incluir +, @s.whatsapp.net, etc.)
 * @returns {object} Configuración del país
 */
function getCountryByPhone(phone) {
  if (!phone) return FALLBACK;

  // Limpiar: quitar +, @s.whatsapp.net, :XX sufijos de Baileys
  const clean = String(phone)
    .replace(/^\+/, '')
    .split('@')[0]
    .split(':')[0]
    .replace(/[\s\-]/g, '');

  // Buscar el prefijo más largo que matchee
  for (const entry of PHONE_MAP) {
    if (clean.startsWith(entry.prefix)) {
      return COUNTRIES[entry.code] || FALLBACK;
    }
  }

  return FALLBACK;
}

/**
 * Retorna todos los países disponibles.
 * @returns {object} Mapa { code: config }
 */
function getAllCountries() {
  return { ...COUNTRIES };
}

/**
 * Retorna la lista de países que tienen un módulo específico disponible.
 * @param {string} moduleId - ID del módulo (wa, firma, factura, receta)
 * @returns {string[]} Códigos de países
 */
function getCountriesWithModule(moduleId) {
  return Object.keys(COUNTRIES).filter(code => {
    const mod = COUNTRIES[code].modules && COUNTRIES[code].modules[moduleId];
    return mod && mod.available;
  });
}

module.exports = {
  getCountryConfig,
  getCountryByPhone,
  getAllCountries,
  getCountriesWithModule,
  COUNTRIES
};
