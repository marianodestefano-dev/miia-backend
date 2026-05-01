'use strict';

/**
 * MIIA â€” Catalog Filter (T152)
 * Filtros por precio, categoria y disponibilidad desde lenguaje natural.
 */

const PRICE_PATTERNS = [
  { re: /(?:menos de|bajo|hasta|max(?:imo)?)\s*\$?\s*(\d+(?:[.,]\d+)?)/i, type: 'max' },
  { re: /(?:mas de|desde|minimo|sobre|mayor a)\s*\$?\s*(\d+(?:[.,]\d+)?)/i, type: 'min' },
  { re: /entre\s*\$?\s*(\d+(?:[.,]\d+)?)\s*y\s*\$?\s*(\d+(?:[.,]\d+)?)/i, type: 'range' },
  { re: /\$?\s*(\d+(?:[.,]\d+)?)\s*(?:a|hasta|-)\s*\$?\s*(\d+(?:[.,]\d+)?)/i, type: 'range' },
];

const AVAILABILITY_KEYWORDS = Object.freeze({
  available: ['disponible','disponibles','stock','en stock','hay','tienes','tienen'],
  unavailable: ['agotado','agotados','sin stock','no hay','no tienen'],
});

/**
 * Parsea filtros de lenguaje natural desde una query.
 * @param {string} query
 * @returns {{ priceMin, priceMax, categories, availability }}
 */
function parseFilters(query) {
  if (!query || typeof query !== 'string') throw new Error('query requerido');

  const q = query.toLowerCase();
  const result = {
    priceMin: null,
    priceMax: null,
    categories: [],
    availability: null,
  };

  // Price parsing
  for (const pattern of PRICE_PATTERNS) {
    const m = q.match(pattern.re);
    if (m) {
      const val1 = parseFloat(m[1].replace(',', '.'));
      if (pattern.type === 'max') {
        result.priceMax = val1;
      } else if (pattern.type === 'min') {
        result.priceMin = val1;
      } else if (pattern.type === 'range') {
        const val2 = parseFloat(m[2].replace(',', '.'));
        result.priceMin = Math.min(val1, val2);
        result.priceMax = Math.max(val1, val2);
      }
      break;
    }
  }

  // Availability parsing
  for (const word of AVAILABILITY_KEYWORDS.available) {
    if (q.includes(word)) { result.availability = 'available'; break; }
  }
  if (!result.availability) {
    for (const word of AVAILABILITY_KEYWORDS.unavailable) {
      if (q.includes(word)) { result.availability = 'unavailable'; break; }
    }
  }

  return result;
}

/**
 * Aplica filtros a un array de productos.
 * @param {Array<object>} products
 * @param {object} filters - { priceMin, priceMax, categories, availability }
 * @returns {Array<object>}
 */
function applyFilters(products, filters) {
  if (!Array.isArray(products)) throw new Error('products debe ser array');
  if (!filters || typeof filters !== 'object') throw new Error('filters requerido');

  return products.filter(p => {
    // Price filter
    if (filters.priceMin !== null && filters.priceMin !== undefined) {
      if (typeof p.price !== 'number' || p.price < filters.priceMin) return false;
    }
    if (filters.priceMax !== null && filters.priceMax !== undefined) {
      if (typeof p.price !== 'number' || p.price > filters.priceMax) return false;
    }

    // Category filter
    if (filters.categories && filters.categories.length > 0) {
      const pc = (p.category || '').toLowerCase();
      const match = filters.categories.some(c => pc.includes(c.toLowerCase()));
      if (!match) return false;
    }

    // Availability filter
    if (filters.availability === 'available') {
      if (p.stock === 0 || p.available === false) return false;
    }
    if (filters.availability === 'unavailable') {
      if (p.stock !== 0 && p.available !== false) return false;
    }

    return true;
  });
}

/**
 * Parsea y aplica filtros desde una query de lenguaje natural.
 * @param {Array<object>} products
 * @param {string} query
 * @returns {{ filtered: Array<object>, filters: object }}
 */
function filterByNaturalLanguage(products, query) {
  const filters = parseFilters(query);
  const filtered = applyFilters(products, filters);
  return { filtered, filters };
}

module.exports = {
  parseFilters, applyFilters, filterByNaturalLanguage,
  PRICE_PATTERNS, AVAILABILITY_KEYWORDS,
};
