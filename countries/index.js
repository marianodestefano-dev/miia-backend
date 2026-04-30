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
  const cfg = COUNTRIES[normalized] || FALLBACK;
  if (!cfg) return null;

  // T75 (CLAUDE.md §6.27 area): resolver _fallback declarado en pricing/bolsas.
  // Si el JSON del pais marca pricing._fallback = 'INTL' y los precios estan
  // null (pendiente firma Mariano), devolver merge sintetico con precios INTL
  // para que el resto del sistema no reciba nulls. NO inventa precios — solo
  // cumple lo declarado en el JSON. Caso real BR.json post-T41.
  return _resolveFallbacks(cfg);
}

/**
 * Si pricing/bolsas declaran _fallback: 'XXX', y los precios actuales son null,
 * merge sintetico con XXX (default INTL). NO mutate el config original.
 * Pure function — retorna copia con merge aplicado solo donde haga falta.
 *
 * @param {object} cfg - country config crudo
 * @returns {object} config con fallback resuelto
 */
function _resolveFallbacks(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const pricing = cfg.pricing || {};
  const fallbackKey = pricing._fallback;
  // Solo aplicar fallback si declarado + no es self-reference
  if (!fallbackKey || fallbackKey === cfg.code) return cfg;
  const source = COUNTRIES[fallbackKey];
  if (!source) return cfg;

  // Detectar si los plans tienen al menos un null → activa merge
  const plansAreNull = pricing.plans && Object.values(pricing.plans).some(
    p => p && (p.base === null || p.adic === null)
  );
  if (!plansAreNull) return cfg;

  // Build merged copy (shallow but suficiente para precios)
  return {
    ...cfg,
    pricing: {
      ...pricing,
      _fallbackResolved: true,
      _fallbackSource: fallbackKey,
      plans: source.pricing && source.pricing.plans ? source.pricing.plans : pricing.plans,
      adicEscalonado: source.pricing && source.pricing.adicEscalonado != null
        ? source.pricing.adicEscalonado : pricing.adicEscalonado,
    },
    bolsas: {
      ...(cfg.bolsas || {}),
      wa: cfg.bolsas && cfg.bolsas.wa && cfg.bolsas.wa._fallback === fallbackKey && source.bolsas
        ? source.bolsas.wa : (cfg.bolsas && cfg.bolsas.wa) || {},
      firma: cfg.bolsas && cfg.bolsas.firma && cfg.bolsas.firma._fallback === fallbackKey && source.bolsas
        ? source.bolsas.firma : (cfg.bolsas && cfg.bolsas.firma) || {},
    },
  };
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
