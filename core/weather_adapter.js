'use strict';

/**
 * R18-C — weather_adapter.js (Piso 4 P4.5 - IDEA #007)
 * Adapter de clima multi-capa para data_fetcher:
 *   Capa 1: APIs oficiales por pais (IDEAM/SMN/CONAGUA/DMC)
 *   Capa 2: OpenWeatherMap fallback
 *   Capa 3: Gemini google_search (último recurso)
 */

const OWM_URL = 'https://api.openweathermap.org/data/2.5/weather';
const CACHE_TTL_WEATHER = 30 * 60 * 1000; // 30 min (clima cambia menos que noticias)
const DEFAULT_CIUDAD = 'Bogota';
const DEFAULT_PAIS = 'colombia';

// APIs oficiales por pais
const OFFICIAL_APIS = Object.freeze({
  colombia: {
    name: 'IDEAM',
    url: function (ciudad) {
      return 'https://api.ideam.gov.co/clima/actual?ciudad=' + encodeURIComponent(ciudad);
    },
  },
  argentina: {
    name: 'SMN',
    url: function (ciudad) {
      return 'https://ws.smn.gob.ar/map_items/weather?ciudad=' + encodeURIComponent(ciudad);
    },
  },
  mexico: {
    name: 'CONAGUA',
    url: function (ciudad) {
      return 'https://smn.conagua.gob.mx/webservices/?method=CiudadesEdo&synop=' + encodeURIComponent(ciudad);
    },
  },
  chile: {
    name: 'DMC',
    url: function (ciudad) {
      return 'https://climatologia.meteochile.gob.cl/application/index/climatologia?codigo=' + encodeURIComponent(ciudad);
    },
  },
});

let _fetch = /* istanbul ignore next */ function () { return require('node-fetch')(...arguments); };
let _geminiSearch = /* istanbul ignore next */ async function (q) { return null; };
function __setFetchForTests(fn) { _fetch = fn; }
function __setGeminiForTests(fn) { _geminiSearch = fn; }

function _parseOWMResponse(json) {
  if (!json || !json.main) return null;
  return {
    ciudad: json.name || '',
    pais: (json.sys && json.sys.country) || '',
    temp_c: json.main.temp !== undefined ? Math.round(json.main.temp) : null,
    feels_like_c: json.main.feels_like !== undefined ? Math.round(json.main.feels_like) : null,
    descripcion: (json.weather && json.weather[0] && json.weather[0].description) || '',
    humedad_pct: json.main.humidity !== undefined ? json.main.humidity : null,
    viento_kmh: json.wind ? Math.round((json.wind.speed || 0) * 3.6) : null,
    source: 'openweathermap',
  };
}

function _parseOfficialResponse(pais, json) {
  if (!json) return null;
  // Parseo básico: cada API tiene formato diferente, normalizamos lo que podemos
  const temp = json.temperatura || json.temp || json.temperature || null;
  const desc = json.descripcion || json.description || json.condicion || json.condition || '';
  const ciudad = json.ciudad || json.city || json.nombre || '';
  if (temp === null && !desc) return null;
  return {
    ciudad,
    pais,
    temp_c: temp !== null ? Math.round(Number(temp)) : null,
    feels_like_c: null,
    descripcion: String(desc),
    humedad_pct: json.humedad || json.humidity || null,
    viento_kmh: json.viento || json.wind_speed || null,
    source: 'oficial_' + pais,
  };
}

/**
 * Capa 1: API oficial del pais.
 * @param {{ ciudad, pais }} params
 * @param {AbortSignal} signal
 * @returns {Promise<object|null>}
 */
async function officialWeatherAdapter(params, signal) {
  const p = params || {};
  const pais = (p.pais || DEFAULT_PAIS).toLowerCase();
  const ciudad = p.ciudad || DEFAULT_CIUDAD;
  const api = OFFICIAL_APIS[pais];
  if (!api) return null;
  try {
    const res = await _fetch(api.url(ciudad), { signal });
    if (!res.ok) return null;
    const json = await res.json();
    return _parseOfficialResponse(pais, json);
  } catch (_) {
    return null;
  }
}

/**
 * Capa 2: OpenWeatherMap fallback.
 * @param {{ ciudad, pais, apiKey }} params
 * @param {AbortSignal} signal
 * @returns {Promise<object|null>}
 */
async function owmAdapter(params, signal) {
  const p = params || {};
  const ciudad = p.ciudad || DEFAULT_CIUDAD;
  const apiKey = p.apiKey || process.env.OPENWEATHER_API_KEY || null;
  if (!apiKey) return null;
  try {
    const url = OWM_URL + '?q=' + encodeURIComponent(ciudad) + '&appid=' + apiKey + '&units=metric&lang=es';
    const res = await _fetch(url, { signal });
    if (!res.ok) return null;
    const json = await res.json();
    return _parseOWMResponse(json);
  } catch (_) {
    return null;
  }
}

/**
 * Capa 3: Gemini google_search como último recurso.
 * @param {{ ciudad }} params
 * @returns {Promise<object|null>}
 */
async function geminiWeatherAdapter(params) {
  const p = params || {};
  const ciudad = p.ciudad || DEFAULT_CIUDAD;
  try {
    const query = 'clima actual en ' + ciudad + ' temperatura hoy';
    const raw = await _geminiSearch(query);
    if (!raw) return null;
    return {
      ciudad,
      pais: null,
      temp_c: null,
      feels_like_c: null,
      descripcion: String(raw),
      humedad_pct: null,
      viento_kmh: null,
      source: 'gemini',
    };
  } catch (_) {
    return null;
  }
}

/**
 * Adapter principal (adapterFn): oficial → OWM → Gemini en cascada.
 * @param {{ ciudad, pais, apiKey }} params
 * @param {AbortSignal} signal
 * @returns {Promise<object|null>}
 */
async function weatherAdapter(params, signal) {
  const oficial = await officialWeatherAdapter(params, signal);
  if (oficial) return oficial;
  const owm = await owmAdapter(params, signal);
  if (owm) return owm;
  return geminiWeatherAdapter(params);
}

module.exports = {
  weatherAdapter,
  officialWeatherAdapter,
  owmAdapter,
  geminiWeatherAdapter,
  OFFICIAL_APIS,
  CACHE_TTL_WEATHER,
  DEFAULT_CIUDAD,
  DEFAULT_PAIS,
  __setFetchForTests,
  __setGeminiForTests,
};
