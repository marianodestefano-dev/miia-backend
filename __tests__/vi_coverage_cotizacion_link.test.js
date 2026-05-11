'use strict';
const { generarLinkCotizacion, mapPaisToCountry, getBolsaTier } = require('../services/cotizacion_link');

const ORIG_FETCH = global.fetch;
const ORIG_TOKEN = process.env.MIIA_INTERNAL_TOKEN;

afterEach(() => {
  global.fetch = ORIG_FETCH;
  if (ORIG_TOKEN !== undefined) process.env.MIIA_INTERNAL_TOKEN = ORIG_TOKEN;
  else delete process.env.MIIA_INTERNAL_TOKEN;
  delete process.env.RAILWAY_INTERNAL_URL;
});

describe('getBolsaTier', () => {
  test('key falsy => -1', () => { expect(getBolsaTier(null)).toBe(-1); expect(getBolsaTier('')).toBe(-1); });
  test('key en mapa => index', () => { expect(getBolsaTier('S')).toBe(0); expect(getBolsaTier('M')).toBe(1); expect(getBolsaTier('XL')).toBe(3); });
  test('key truthy NO mapa => -1', () => { expect(getBolsaTier('XXL')).toBe(-1); });
});

describe('mapPaisToCountry', () => {
  test('!pais => INTL', () => { expect(mapPaisToCountry(null)).toBe('INTL'); expect(mapPaisToCountry('')).toBe('INTL'); });
  test('pais en mapa => codigo', () => { expect(mapPaisToCountry('Colombia')).toBe('CO'); expect(mapPaisToCountry('ESPANA')).toBe('ES'); });
  test('pais NO mapa => INTL', () => { expect(mapPaisToCountry('Australia')).toBe('INTL'); });
});

const LEAD = { nombre: 'Juan', phone: '+549' };
const P = { plan: 'pro', usuariosPagos: 3, modalidad: 'mensual', pais: 'Colombia', moneda: 'COP', incluirWA: true, bolsaWA: 'M', incluirFirma: false, bolsaFirma: null, incluirFactura: false, bolsaFactura: null, citasMes: 50, descuentoCustom: null, usuariosBonus: 0, lockUsers: false, lockPlan: null };

function mockFetch(url) { global.fetch = jest.fn().mockResolvedValue({ json: jest.fn().mockResolvedValue({ url: url || 'https://x.com/p' }) }); }

describe('generarLinkCotizacion', () => {
  test('!internalToken => null', async () => { delete process.env.MIIA_INTERNAL_TOKEN; const spy = jest.spyOn(console, 'warn').mockImplementation(() => {}); expect(await generarLinkCotizacion('uid1', LEAD, P)).toBeNull(); spy.mockRestore(); });
  test('sanitizeName null => null', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); expect(await generarLinkCotizacion('uid1', { nombre: null, phone: '+549' }, P)).toBe('https://x.com/p'); });
  test('sanitizeName numero => null', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', { nombre: '+54911', phone: '+549' }, P); expect(global.fetch).toHaveBeenCalled(); });
  test('sanitizeName nombre => trim', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', { nombre: '  Maria  ', phone: '+549' }, P); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.lead_name).toBe('Maria'); });
  test('sin plan => esencial', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, { ...P, plan: null }); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.params.plan).toBe('esencial'); });
  test('usuariosPagos chain1', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, { ...P, usuariosPagos: 5 }); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.params.users).toBe(5); });
  test('usuarios chain2', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, { ...P, usuariosPagos: undefined, usuarios: 4 }); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.params.users).toBe(4); });
  test('default 1 chain3', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, { ...P, usuariosPagos: undefined, usuarios: undefined }); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.params.users).toBe(1); });
  test('sin modalidad => mensual', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, { ...P, modalidad: null }); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.params.modalidad).toBe('mensual'); });
  test('lockPlan valido', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, { ...P, lockPlan: 'titanium' }); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.params.lockPlan).toBe('titanium'); });
  test('lockPlan invalido => null', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, { ...P, lockPlan: 'premium' }); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.params.lockPlan).toBeNull(); });
  test('lockPlan null => null', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, P); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.params.lockPlan).toBeNull(); });
  test('sin citasMes => 70', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, { ...P, citasMes: null }); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.params.citasMes).toBe(70); });
  test('descuentoCustom truthy', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, { ...P, descuentoCustom: 15 }); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.params.descuentoCustom).toBe(15); });
  test('descuentoCustom falsy => null', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, P); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.params.descuentoCustom).toBeNull(); });
  test('usuariosBonus truthy', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, { ...P, usuariosBonus: 2 }); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.params.usuariosBonus).toBe(2); });
  test('usuariosBonus falsy => 0', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, { ...P, usuariosBonus: null }); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.params.usuariosBonus).toBe(0); });
  test('lockUsers truthy', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, { ...P, lockUsers: true }); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.params.lockUsers).toBe(true); });
  test('data.url truthy => URL', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); global.fetch = jest.fn().mockResolvedValue({ json: jest.fn().mockResolvedValue({ url: 'https://miia.app/q' }) }); expect(await generarLinkCotizacion('uid1', LEAD, P)).toBe('https://miia.app/q'); logSpy.mockRestore(); });
  test('data.url falsy => null', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; global.fetch = jest.fn().mockResolvedValue({ json: jest.fn().mockResolvedValue({ error: 'bad' }) }); const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); expect(await generarLinkCotizacion('uid1', LEAD, P)).toBeNull(); warnSpy.mockRestore(); });
  test('fetch throws => null', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; global.fetch = jest.fn().mockRejectedValue(new Error('fail')); const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); expect(await generarLinkCotizacion('uid1', LEAD, P)).toBeNull(); errSpy.mockRestore(); });
  test('RAILWAY_INTERNAL_URL truthy', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; process.env.RAILWAY_INTERNAL_URL = 'http://rail:3'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, P); expect(global.fetch.mock.calls[0][0]).toContain('http://rail:3'); });
  test('sanitizeName numero 7+ chars => null (branch regex true)', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', { nombre: '+5491123456789', phone: '+549' }, P); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.lead_name).toBeNull(); });
  test('sin moneda => USD (branch moneda||USD)', async () => { process.env.MIIA_INTERNAL_TOKEN = 'tok'; mockFetch(); await generarLinkCotizacion('uid1', LEAD, { ...P, moneda: undefined }); const body = JSON.parse(global.fetch.mock.calls[0][1].body); expect(body.params.currency).toBe('USD'); });
});
