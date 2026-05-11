'use strict';

/**
 * VI-BACKEND-COVERAGE: financial_verify.js — 100% branches
 * Mock fetch via jest.mock('node-fetch') + jest.resetModules() para cache isolation.
 */

function freshModule() {
  jest.resetModules();
  return require('../core/financial_verify');
}

// ── fetchOfficialTRM ──────────────────────────────────────────────────────────

describe('fetchOfficialTRM — cache hit', () => {
  test('segunda llamada usa cache sin llamar fetch', async () => {
    jest.resetModules();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ valor: '4200.50', vigenciadesde: '2026-05-11T00:00:00.000', vigenciahasta: '2026-05-11T23:59:59.000' }],
    });
    jest.doMock('node-fetch', () => fetchMock, { virtual: false });
    const { fetchOfficialTRM } = require('../core/financial_verify');

    const r1 = await fetchOfficialTRM();
    const r2 = await fetchOfficialTRM(); // debe usar cache
    expect(r1).not.toBeNull();
    expect(r2).toBe(r1); // mismo objeto del cache
    expect(fetchMock).toHaveBeenCalledTimes(1); // solo una llamada real
    jest.dontMock('node-fetch');
  });
});

describe('fetchOfficialTRM — respuesta http no ok', () => {
  test('res.ok=false → retorna null', async () => {
    jest.resetModules();
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    jest.doMock('node-fetch', () => fetchMock, { virtual: false });
    const { fetchOfficialTRM } = require('../core/financial_verify');
    const r = await fetchOfficialTRM();
    expect(r).toBeNull();
    jest.dontMock('node-fetch');
  });
});

describe('fetchOfficialTRM — datos vacíos', () => {
  test('data[0].valor undefined → retorna null', async () => {
    jest.resetModules();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    jest.doMock('node-fetch', () => fetchMock, { virtual: false });
    const { fetchOfficialTRM } = require('../core/financial_verify');
    const r = await fetchOfficialTRM();
    expect(r).toBeNull();
    jest.dontMock('node-fetch');
  });
});

describe('fetchOfficialTRM — respuesta OK sin vigenciahasta', () => {
  test('vigenciahasta undefined → usa today como fallback', async () => {
    jest.resetModules();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ valor: '4100.00', vigenciadesde: '2026-05-11T00:00:00.000' }], // sin vigenciahasta
    });
    jest.doMock('node-fetch', () => fetchMock, { virtual: false });
    const { fetchOfficialTRM } = require('../core/financial_verify');
    const r = await fetchOfficialTRM();
    expect(r).not.toBeNull();
    expect(r.valor).toBe(4100.0);
    const today = new Date().toISOString().split('T')[0];
    expect(r.vigenciaHasta).toBe(today); // branch: vigenciahasta?.split('T')[0] || today
    jest.dontMock('node-fetch');
  });
});

describe('fetchOfficialTRM — respuesta OK con vigenciahasta', () => {
  test('vigenciahasta definido → usa su valor', async () => {
    jest.resetModules();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ valor: '4050.00', vigenciadesde: '2026-05-10T00:00:00.000', vigenciahasta: '2026-05-10T23:59:59.000' }],
    });
    jest.doMock('node-fetch', () => fetchMock, { virtual: false });
    const { fetchOfficialTRM } = require('../core/financial_verify');
    const r = await fetchOfficialTRM();
    expect(r.vigenciaHasta).toBe('2026-05-10');
    jest.dontMock('node-fetch');
  });
});

describe('fetchOfficialTRM — AbortError (timeout)', () => {
  test('fetch AbortError → retorna null', async () => {
    jest.resetModules();
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const fetchMock = jest.fn().mockRejectedValue(abortErr);
    jest.doMock('node-fetch', () => fetchMock, { virtual: false });
    const { fetchOfficialTRM } = require('../core/financial_verify');
    const r = await fetchOfficialTRM();
    expect(r).toBeNull();
    jest.dontMock('node-fetch');
  });
});

describe('fetchOfficialTRM — error genérico', () => {
  test('fetch error no-Abort → retorna null', async () => {
    jest.resetModules();
    const fetchMock = jest.fn().mockRejectedValue(new Error('network failure'));
    jest.doMock('node-fetch', () => fetchMock, { virtual: false });
    const { fetchOfficialTRM } = require('../core/financial_verify');
    const r = await fetchOfficialTRM();
    expect(r).toBeNull();
    jest.dontMock('node-fetch');
  });
});
