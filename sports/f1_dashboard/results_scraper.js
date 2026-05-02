'use strict';

/**
 * MiiaF1 — Scraper resultados post-carrera
 * Fuente: formula1.com (datos publicos)
 * Rate limit: max 1 request cada 5 segundos
 */

const axios = require('axios');
const cheerio = require('cheerio');


// F1.15 — Retry con backoff para scraping de resultados
const MAX_SCRAPE_RETRIES = 3;

async function _withScrapeRetry(fn) {
  let lastErr;
  for (let i = 0; i < MAX_SCRAPE_RETRIES; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (i < MAX_SCRAPE_RETRIES - 1) {
        const delay = 2000 * Math.pow(2, i);
        console.warn('[F1-SCRAPER] Retry ' + (i+1) + '/' + MAX_SCRAPE_RETRIES + ': ' + err.message);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

const BASE_URL = 'https://www.formula1.com';
const REQUEST_DELAY_MS = 5000;
let _lastRequestAt = 0;

async function _throttledGet(url) {
  const now = Date.now();
  const wait = REQUEST_DELAY_MS - (now - _lastRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRequestAt = Date.now();

  const resp = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MiiaF1/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(15000),
  });
  return resp.data;
}

/**
 * Obtiene el calendario de GPs para una temporada.
 * @param {string|number} season - Año (ej: '2025')
 * @returns {Promise<Array<{id, name, circuit, date, country, round, status}>>}
 */
async function getCalendar(season) {
  try {
    const html = await _withScrapeRetry(() => _throttledGet(`${BASE_URL}/en/racing/${season}.html`));
    const $ = cheerio.load(html);
    const gps = [];

    // Parsear tabla de calendario F1
    $('.event-list .event-list-item, .resultsarchive-row').each((i, el) => {
      const name = $(el).find('.event-title, .col-title').text().trim();
      const date = $(el).find('.event-date, .col-date').text().trim();
      const circuit = $(el).find('.event-circuit, .col-circuit').text().trim();
      const country = $(el).find('.event-country, .col-country').text().trim();

      if (name) {
        gps.push({
          round: i + 1,
          name: /* istanbul ignore next */ name || `GP Round ${i + 1}`,
          circuit: circuit || '',
          date: date || '',
          country: country || '',
          status: 'scheduled',
        });
      }
    });

    return gps;
  } catch (err) {
    console.error(`[F1-SCRAPER] getCalendar ${season}: ${err.message}`);
    return [];
  }
}

/**
 * Obtiene resultados finales de un GP.
 * @param {string} gpId - ID del GP (ej: 'monaco')
 * @param {string|number} season
 * @returns {Promise<{positions: Array, fastest_lap: string|null, dnfs: string[]}>}
 */
async function getGPResults(gpId, season) {
  try {
    const url = `${BASE_URL}/en/results/${season}/races`;
    const html = await _withScrapeRetry(() => _throttledGet(url));
    const $ = cheerio.load(html);

    const positions = [];
    let fastestLap = null;

    // Parsear tabla de resultados
    $('.resultsarchive-table tbody tr, .f1-table tbody tr').each((i, row) => {
      const cells = $(row).find('td');
      const pos = parseInt($(cells[1]).text().trim(), 10);
      const driverName = $(cells[3]).text().trim() || $(cells[2]).text().trim();
      const team = $(cells[4]).text().trim() || $(cells[3]).text().trim();
      const points = parseFloat($(cells[cells.length - 1]).text().trim()) || 0;
      const isFastest = $(row).hasClass('fastest') || $(cells).filter('.fastest').length > 0;

      if (!isNaN(pos) && driverName) {
        positions.push({ position: pos, driver_name: driverName, team, points });
        if (isFastest) fastestLap = driverName;
      }
    });

    return { positions, fastest_lap: fastestLap, dnfs: [] };
  } catch (err) {
    console.error(`[F1-SCRAPER] getGPResults ${gpId} ${season}: ${err.message}`);
    return { positions: [], fastest_lap: null, dnfs: [] };
  }
}

/**
 * Obtiene el mundial de pilotos.
 * @param {string|number} season
 * @returns {Promise<Array<{position, driver_id, driver_name, team, points}>>}
 */
async function getDriverStandings(season) {
  try {
    const url = `${BASE_URL}/en/results/${season}/drivers.html`;
    const html = await _withScrapeRetry(() => _throttledGet(url));
    const $ = cheerio.load(html);
    const standings = [];

    $('.resultsarchive-table tbody tr, .f1-table tbody tr').each((i, row) => {
      const cells = $(row).find('td');
      const pos = parseInt($(cells[0]).text().trim(), 10) || i + 1;
      const name = $(cells[1]).text().trim() || $(cells[2]).text().trim();
      const team = $(cells[2]).text().trim() || $(cells[3]).text().trim();
      const points = parseFloat($(cells[cells.length - 1]).text().trim()) || 0;

      if (name) {
        standings.push({
          position: pos,
          driver_name: name,
          team,
          points,
        });
      }
    });

    return standings;
  } catch (err) {
    console.error(`[F1-SCRAPER] getDriverStandings ${season}: ${err.message}`);
    return [];
  }
}

/**
 * Obtiene el mundial de constructores.
 * @param {string|number} season
 * @returns {Promise<Array<{position, team, points}>>}
 */
async function getConstructorStandings(season) {
  try {
    const url = `${BASE_URL}/en/results/${season}/constructors.html`;
    const html = await _withScrapeRetry(() => _throttledGet(url));
    const $ = cheerio.load(html);
    const standings = [];

    $('.resultsarchive-table tbody tr, .f1-table tbody tr').each((i, row) => {
      const cells = $(row).find('td');
      const pos = parseInt($(cells[0]).text().trim(), 10) || i + 1;
      const team = $(cells[1]).text().trim();
      const points = parseFloat($(cells[cells.length - 1]).text().trim()) || 0;

      if (team) standings.push({ position: pos, team, points });
    });

    return standings;
  } catch (err) {
    console.error(`[F1-SCRAPER] getConstructorStandings ${season}: ${err.message}`);
    return [];
  }
}

// Exportar para uso en cron y endpoints
function _resetThrottle() { _lastRequestAt = 0; }

module.exports = {
  getCalendar,
  getGPResults,
  getDriverStandings,
  getConstructorStandings,
  _throttledGet,
  _resetThrottle,
  _withScrapeRetry,
};
