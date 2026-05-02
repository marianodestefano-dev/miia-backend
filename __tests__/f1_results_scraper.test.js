'use strict';

/**
 * Tests para results_scraper.js — scraping formula1.com.
 * Mock axios + cheerio real (parsea HTML provisto).
 * Cobertura objetivo per-module >=95.65%.
 */

jest.mock('axios');
const axios = require('axios');

const scraper = require('../sports/f1_dashboard/results_scraper');

// Acelera todos los setTimeout (throttle 5000ms + retry backoff 2000/4000ms)
// AbortSignal.timeout queda con su propio timer interno, no afecta porque axios esta mockeado.
const origSetTimeout = global.setTimeout;
beforeAll(() => {
  global.setTimeout = function (cb, _ms) {
    return origSetTimeout(cb, 0);
  };
});
afterAll(() => {
  global.setTimeout = origSetTimeout;
});

beforeEach(() => {
  jest.clearAllMocks();
  scraper._resetThrottle();
  // Silenciar logs ruidosos de retry/error
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (console.warn.mockRestore) console.warn.mockRestore();
  if (console.error.mockRestore) console.error.mockRestore();
});

// ---------- _withScrapeRetry ----------
describe('_withScrapeRetry — F1.15 retry backoff exponencial', () => {
  test('exito en primer intento — no retry', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const r = await scraper._withScrapeRetry(fn);
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('exito en segundo intento — un retry', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValue('ok');
    const r = await scraper._withScrapeRetry(fn);
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('exito en tercer intento — dos retries', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockResolvedValue('ok');
    const r = await scraper._withScrapeRetry(fn);
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('falla 3 veces — throw lastErr', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('persistent'));
    await expect(scraper._withScrapeRetry(fn)).rejects.toThrow('persistent');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// ---------- _throttledGet ----------
describe('_throttledGet — rate limit + axios config', () => {
  test('llama axios.get con URL + headers + timeout', async () => {
    axios.get.mockResolvedValue({ data: '<html></html>' });
    await scraper._throttledGet('https://example.com/test');
    expect(axios.get).toHaveBeenCalledWith(
      'https://example.com/test',
      expect.objectContaining({
        timeout: 15000,
        headers: expect.objectContaining({
          'User-Agent': expect.stringContaining('MiiaF1'),
        }),
      })
    );
  });

  test('retorna resp.data', async () => {
    axios.get.mockResolvedValue({ data: '<div>HTML</div>' });
    const r = await scraper._throttledGet('https://example.com');
    expect(r).toBe('<div>HTML</div>');
  });

  test('throttle: segunda llamada espera (setTimeout invocado)', async () => {
    axios.get.mockResolvedValue({ data: '' });
    const spy = jest.spyOn(global, 'setTimeout');
    await scraper._throttledGet('https://example.com/a');
    await scraper._throttledGet('https://example.com/b');
    // segunda llamada debe haber invocado setTimeout para esperar
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('_resetThrottle resetea contador', async () => {
    axios.get.mockResolvedValue({ data: '' });
    await scraper._throttledGet('https://example.com/x');
    scraper._resetThrottle();
    // Tras reset, el wait deberia ser <=0 → no espera
    const before = Date.now();
    await scraper._throttledGet('https://example.com/y');
    const elapsed = Date.now() - before;
    expect(elapsed).toBeLessThan(500);
  });

  test('axios error propaga', async () => {
    axios.get.mockRejectedValue(new Error('network down'));
    await expect(scraper._throttledGet('https://example.com')).rejects.toThrow('network down');
  });
});

// ---------- getCalendar ----------
describe('getCalendar(season)', () => {
  test('parsea event-list-item con todos los campos', async () => {
    const html = `
      <div class="event-list">
        <div class="event-list-item">
          <span class="event-title">Australian GP</span>
          <span class="event-date">Mar 16</span>
          <span class="event-circuit">Albert Park</span>
          <span class="event-country">Australia</span>
        </div>
        <div class="event-list-item">
          <span class="event-title">Bahrain GP</span>
          <span class="event-date">Mar 30</span>
          <span class="event-circuit">Sakhir</span>
          <span class="event-country">Bahrain</span>
        </div>
      </div>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getCalendar(2025);
    expect(r.length).toBe(2);
    expect(r[0].name).toBe('Australian GP');
    expect(r[0].round).toBe(1);
    expect(r[0].circuit).toBe('Albert Park');
    expect(r[0].country).toBe('Australia');
    expect(r[0].date).toBe('Mar 16');
    expect(r[0].status).toBe('scheduled');
    expect(r[1].round).toBe(2);
  });

  test('parsea resultsarchive-row alternativo', async () => {
    const html = `
      <table>
        <tr class="resultsarchive-row">
          <td class="col-title">Monaco GP</td>
          <td class="col-date">May 25</td>
          <td class="col-circuit">Monte Carlo</td>
          <td class="col-country">Monaco</td>
        </tr>
      </table>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getCalendar(2025);
    expect(r.length).toBe(1);
    expect(r[0].name).toBe('Monaco GP');
  });

  test('html vacio retorna []', async () => {
    axios.get.mockResolvedValue({ data: '<html><body></body></html>' });
    const r = await scraper.getCalendar(2025);
    expect(r).toEqual([]);
  });

  test('error de red retorna [] (catch)', async () => {
    axios.get.mockRejectedValue(new Error('ENOTFOUND'));
    const r = await scraper.getCalendar(2025);
    expect(r).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  test('row sin name se ignora', async () => {
    const html = `
      <div class="event-list">
        <div class="event-list-item">
          <span class="event-title"></span>
          <span class="event-date">Mar 16</span>
        </div>
        <div class="event-list-item">
          <span class="event-title">Real GP</span>
        </div>
      </div>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getCalendar(2025);
    expect(r.length).toBe(1);
    expect(r[0].name).toBe('Real GP');
  });

  test('retry: falla 1 vez luego exito', async () => {
    axios.get
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValue({ data: '<div class="event-list"><div class="event-list-item"><span class="event-title">GP X</span></div></div>' });
    const r = await scraper.getCalendar(2025);
    expect(r.length).toBe(1);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
});

// ---------- getGPResults ----------
describe('getGPResults(gpId, season)', () => {
  test('parsea positions + detecta fastest_lap por clase fastest en row', async () => {
    const html = `
      <table class="resultsarchive-table">
        <tbody>
          <tr>
            <td></td><td>1</td><td>33</td><td>Max Verstappen</td><td>Red Bull</td><td>1:30:00</td><td>26</td>
          </tr>
          <tr class="fastest">
            <td></td><td>2</td><td>4</td><td>Lando Norris</td><td>McLaren</td><td>+1.5s</td><td>19</td>
          </tr>
        </tbody>
      </table>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getGPResults('monaco', 2025);
    expect(r.positions.length).toBe(2);
    expect(r.positions[0].position).toBe(1);
    expect(r.positions[0].driver_name).toBe('Max Verstappen');
    expect(r.positions[0].team).toBe('Red Bull');
    expect(r.positions[0].points).toBe(26);
    expect(r.fastest_lap).toBe('Lando Norris');
    expect(r.dnfs).toEqual([]);
  });

  test('detecta fastest por celda con clase fastest', async () => {
    const html = `
      <table class="resultsarchive-table">
        <tbody>
          <tr>
            <td></td><td>1</td><td>33</td><td>Max V</td><td>Red Bull</td><td class="fastest">1:30:00</td><td>26</td>
          </tr>
        </tbody>
      </table>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getGPResults('test', 2025);
    expect(r.fastest_lap).toBe('Max V');
  });

  test('row con position NaN se ignora', async () => {
    const html = `
      <table class="resultsarchive-table">
        <tbody>
          <tr><td></td><td>DNF</td><td>33</td><td>Driver X</td><td>Team</td><td></td><td>0</td></tr>
          <tr><td></td><td>1</td><td>16</td><td>Driver Y</td><td>Ferrari</td><td>1:30</td><td>25</td></tr>
        </tbody>
      </table>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getGPResults('x', 2025);
    expect(r.positions.length).toBe(1);
    expect(r.positions[0].driver_name).toBe('Driver Y');
  });

  test('error de red retorna struct vacia', async () => {
    axios.get.mockRejectedValue(new Error('500'));
    const r = await scraper.getGPResults('x', 2025);
    expect(r).toEqual({ positions: [], fastest_lap: null, dnfs: [] });
  });

  test('selector alternativo f1-table funciona', async () => {
    const html = `
      <table class="f1-table">
        <tbody>
          <tr><td></td><td>1</td><td>1</td><td>Driver A</td><td>Team A</td><td>1:30</td><td>25</td></tr>
        </tbody>
      </table>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getGPResults('y', 2025);
    expect(r.positions.length).toBe(1);
  });

  test('fallback driverName cells[2] cuando cells[3] vacio', async () => {
    // cells[3] vacio → driverName usa cells[2]; cells[4] vacio → team usa cells[3] (tambien vacio)
    const html = `
      <table class="resultsarchive-table">
        <tbody>
          <tr>
            <td></td><td>1</td><td>Driver Two</td><td></td><td></td><td>1:30</td><td>25</td>
          </tr>
        </tbody>
      </table>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getGPResults('z', 2025);
    expect(r.positions.length).toBe(1);
    expect(r.positions[0].driver_name).toBe('Driver Two');
  });
});

// ---------- getDriverStandings ----------
describe('getDriverStandings(season)', () => {
  test('parsea standings basicos', async () => {
    const html = `
      <table class="resultsarchive-table">
        <tbody>
          <tr><td>1</td><td>Max Verstappen</td><td>Red Bull</td><td>510</td></tr>
          <tr><td>2</td><td>Lando Norris</td><td>McLaren</td><td>374</td></tr>
          <tr><td>3</td><td>Charles Leclerc</td><td>Ferrari</td><td>356</td></tr>
        </tbody>
      </table>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getDriverStandings(2025);
    expect(r.length).toBe(3);
    expect(r[0].position).toBe(1);
    expect(r[0].driver_name).toBe('Max Verstappen');
    expect(r[0].team).toBe('Red Bull');
    expect(r[0].points).toBe(510);
  });

  test('row sin name se ignora', async () => {
    const html = `
      <table class="resultsarchive-table">
        <tbody>
          <tr><td>1</td><td></td><td></td><td>0</td></tr>
          <tr><td>2</td><td>Real Driver</td><td>Real Team</td><td>100</td></tr>
        </tbody>
      </table>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getDriverStandings(2025);
    expect(r.length).toBe(1);
    expect(r[0].driver_name).toBe('Real Driver');
  });

  test('position NaN cae a fallback i+1', async () => {
    const html = `
      <table class="resultsarchive-table">
        <tbody>
          <tr><td>X</td><td>Driver A</td><td>Team A</td><td>50</td></tr>
        </tbody>
      </table>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getDriverStandings(2025);
    expect(r.length).toBe(1);
    expect(r[0].position).toBe(1);
  });

  test('error retorna []', async () => {
    axios.get.mockRejectedValue(new Error('boom'));
    const r = await scraper.getDriverStandings(2025);
    expect(r).toEqual([]);
  });

  test('selector alternativo f1-table', async () => {
    const html = `
      <table class="f1-table">
        <tbody>
          <tr><td>1</td><td>Driver Z</td><td>Team Z</td><td>200</td></tr>
        </tbody>
      </table>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getDriverStandings(2025);
    expect(r.length).toBe(1);
  });
});

// ---------- getConstructorStandings ----------
describe('getConstructorStandings(season)', () => {
  test('parsea constructors', async () => {
    const html = `
      <table class="resultsarchive-table">
        <tbody>
          <tr><td>1</td><td>Red Bull</td><td>860</td></tr>
          <tr><td>2</td><td>McLaren</td><td>730</td></tr>
        </tbody>
      </table>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getConstructorStandings(2025);
    expect(r.length).toBe(2);
    expect(r[0].position).toBe(1);
    expect(r[0].team).toBe('Red Bull');
    expect(r[0].points).toBe(860);
  });

  test('row sin team se ignora', async () => {
    const html = `
      <table class="resultsarchive-table">
        <tbody>
          <tr><td>1</td><td></td><td>0</td></tr>
          <tr><td>2</td><td>Real Team</td><td>100</td></tr>
        </tbody>
      </table>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getConstructorStandings(2025);
    expect(r.length).toBe(1);
    expect(r[0].team).toBe('Real Team');
  });

  test('position NaN cae a fallback i+1', async () => {
    const html = `
      <table class="resultsarchive-table">
        <tbody>
          <tr><td>?</td><td>Team A</td><td>50</td></tr>
        </tbody>
      </table>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getConstructorStandings(2025);
    expect(r[0].position).toBe(1);
  });

  test('error retorna []', async () => {
    axios.get.mockRejectedValue(new Error('boom'));
    const r = await scraper.getConstructorStandings(2025);
    expect(r).toEqual([]);
  });

  test('selector alternativo f1-table', async () => {
    const html = `
      <table class="f1-table">
        <tbody>
          <tr><td>1</td><td>Team X</td><td>500</td></tr>
        </tbody>
      </table>
    `;
    axios.get.mockResolvedValue({ data: html });
    const r = await scraper.getConstructorStandings(2025);
    expect(r.length).toBe(1);
  });
});
