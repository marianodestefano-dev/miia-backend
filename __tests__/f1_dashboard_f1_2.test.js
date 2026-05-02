'use strict';

jest.mock('axios');
jest.mock('cheerio');

const axios = require('axios');
const cheerio = require('cheerio');
const scraper = require('../sports/f1_dashboard/results_scraper');

// HTML mocks
const MOCK_STANDINGS_HTML = `
<table class="f1-table">
  <tbody>
    <tr><td>1</td><td>Lando Norris</td><td>McLaren</td><td>189</td></tr>
    <tr><td>2</td><td>Oscar Piastri</td><td>McLaren</td><td>165</td></tr>
    <tr><td>3</td><td>Max Verstappen</td><td>Red Bull</td><td>145</td></tr>
  </tbody>
</table>`;

const MOCK_CONSTRUCTORS_HTML = `
<table class="f1-table">
  <tbody>
    <tr><td>1</td><td>McLaren</td><td>354</td></tr>
    <tr><td>2</td><td>Red Bull Racing</td><td>145</td></tr>
  </tbody>
</table>`;

function setupCheerio(html) {
  const realCheerio = jest.requireActual('cheerio');
  cheerio.load.mockImplementation(realCheerio.load);
  axios.get.mockResolvedValueOnce({ data: html });
}

// Acelerar setTimeout: tras wire-in de _withScrapeRetry (F1.15), reintentos
// agregan 2000+4000ms de waits internos. Sin acelerar, tests con axios fallido
// exceden timeout 5s. AbortSignal.timeout no afecta porque axios esta mockeado.
const _origSetTimeout = global.setTimeout;
beforeAll(() => {
  global.setTimeout = function (cb, _ms) { return _origSetTimeout(cb, 0); };
});
afterAll(() => {
  global.setTimeout = _origSetTimeout;
});

describe('F1.2 — Scraper resultados post-carrera', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    scraper._resetThrottle();
  });

  // ─── getDriverStandings ───
  describe('getDriverStandings', () => {
    test('parsea standings correctamente', async () => {
      setupCheerio(MOCK_STANDINGS_HTML);
      const result = await scraper.getDriverStandings('2025');
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(3);
      expect(result[0].driver_name).toBe('Lando Norris');
      expect(result[0].points).toBe(189);
      expect(result[0].position).toBe(1);
    });

    test('retorna [] si axios falla', async () => {
      axios.get.mockRejectedValueOnce(new Error('Network error'));
      const result = await scraper.getDriverStandings('2025');
      expect(result).toEqual([]);
    });

    test('retorna [] si HTML vacio', async () => {
      setupCheerio('<html><body></body></html>');
      const result = await scraper.getDriverStandings('2025');
      expect(result).toEqual([]);
    });
  });

  // ─── getConstructorStandings ───
  describe('getConstructorStandings', () => {
    test('parsea constructores correctamente', async () => {
      setupCheerio(MOCK_CONSTRUCTORS_HTML);
      const result = await scraper.getConstructorStandings('2025');
      expect(result.length).toBe(2);
      expect(result[0].team).toBe('McLaren');
      expect(result[0].points).toBe(354);
    });

    test('retorna [] si axios falla', async () => {
      axios.get.mockRejectedValueOnce(new Error('timeout'));
      const result = await scraper.getConstructorStandings('2025');
      expect(result).toEqual([]);
    });
  });

  // ─── getGPResults ───
  describe('getGPResults', () => {
    test('retorna estructura correcta aunque no parsee nada', async () => {
      setupCheerio('<html><body></body></html>');
      const result = await scraper.getGPResults('monaco', '2025');
      expect(result).toHaveProperty('positions');
      expect(result).toHaveProperty('fastest_lap');
      expect(result).toHaveProperty('dnfs');
      expect(Array.isArray(result.positions)).toBe(true);
      expect(Array.isArray(result.dnfs)).toBe(true);
    });

    test('retorna estructura vacia si axios falla', async () => {
      axios.get.mockRejectedValueOnce(new Error('timeout'));
      const result = await scraper.getGPResults('monaco', '2025');
      expect(result.positions).toEqual([]);
      expect(result.fastest_lap).toBeNull();
    });
  });

  // ─── getCalendar ───
  describe('getCalendar', () => {
    test('retorna array aunque HTML no matchee selectores', async () => {
      setupCheerio('<html><body></body></html>');
      const result = await scraper.getCalendar('2025');
      expect(Array.isArray(result)).toBe(true);
    });

    test('retorna [] si axios falla', async () => {
      axios.get.mockRejectedValueOnce(new Error('Network'));
      const result = await scraper.getCalendar('2025');
      expect(result).toEqual([]);
    });
  });

  // ─── Rate limiting ───
  describe('Rate limiting', () => {
    test('_throttledGet llama axios.get con User-Agent correcto', async () => {
      axios.get.mockResolvedValueOnce({ data: '<html></html>' });
      await scraper._throttledGet('https://formula1.com/test');
      expect(axios.get).toHaveBeenCalledWith(
        'https://formula1.com/test',
        expect.objectContaining({
          headers: expect.objectContaining({ 'User-Agent': expect.stringContaining('MiiaF1') }),
          timeout: 15000,
        })
      );
    });

    test('_throttledGet retorna data del response', async () => {
      axios.get.mockResolvedValueOnce({ data: '<html>test</html>' });
      const result = await scraper._throttledGet('https://formula1.com/test');
      expect(result).toBe('<html>test</html>');
    });
  });
});
