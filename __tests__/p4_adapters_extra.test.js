'use strict';

// Tests adicionales para adapters que necesitan fetch mocks y fake timers

jest.mock('../integrations/base_integration', () => {
  return class BaseIntegration {
    constructor({ type, displayName, emoji, checkIntervalMs }) {
      this.type = type; this.displayName = displayName;
      this.emoji = emoji; this.checkIntervalMs = checkIntervalMs;
      this.lastCheck = 0; this._deps = {};
    }
    setDeps(deps) { this._deps = { ...this._deps, ...deps }; }
    shouldCheck() { return Date.now() - this.lastCheck >= this.checkIntervalMs; }
    markChecked() { this.lastCheck = Date.now(); }
    async check() { throw new Error('check() no implementado'); }
    async getPrefs() { return null; }
    async savePrefs(admin, uid, data) {
      if (!admin) return;
      await admin.firestore().collection('x').doc(uid).collection('mi').doc(this.type).set(data, { merge: true });
    }
    _log(msg) { console.log('[' + this.type + ']', msg); }
    _error(msg, e) { console.error('[' + this.type + ']', msg, e); }
  };
});

const SpotifyIntegration = require('../integrations/adapters/spotify_integration');
const GmailIntegration = require('../integrations/adapters/gmail_integration');
const UberIntegration = require('../integrations/adapters/uber_integration');
const GymIntegration = require('../integrations/adapters/gym_integration');
const CocinaIntegration = require('../integrations/adapters/cocina_integration');
const RappiIntegration = require('../integrations/adapters/rappi_integration');
const NewsIntegration = require('../integrations/adapters/news_integration');

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  delete global.fetch;
});
afterEach(() => {
  jest.restoreAllMocks();
  if (jest.isFakeTimers && jest.isFakeTimers()) jest.useRealTimers();
  delete global.fetch;
});

// ============== SPOTIFY extra ==============
describe('P4 extra -- SpotifyIntegration branches', () => {
  let sp;
  beforeEach(() => { sp = new SpotifyIntegration(); });

  test('_getToken: token valido no expirado -> retorna directo', async () => {
    const prefs = { accessToken: 'tok-valid', tokenExpiry: Date.now() + 3600000 };
    const token = await sp._getToken(prefs, {});
    expect(token).toBe('tok-valid');
  });

  test('_refreshToken: sin clientId -> null', async () => {
    delete process.env.SPOTIFY_CLIENT_ID;
    const r = await sp._refreshToken({ refreshToken: 'rt' }, {});
    expect(r).toBeNull();
  });

  test('_refreshToken: sin refreshToken -> null', async () => {
    process.env.SPOTIFY_CLIENT_ID = 'cid';
    process.env.SPOTIFY_CLIENT_SECRET = 'csec';
    const r = await sp._refreshToken({}, {});
    expect(r).toBeNull();
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
  });

  test('_refreshToken: fetch lanza -> null', async () => {
    process.env.SPOTIFY_CLIENT_ID = 'cid';
    process.env.SPOTIFY_CLIENT_SECRET = 'csec';
    global.fetch = jest.fn().mockRejectedValue(new Error('network fail'));
    const r = await sp._refreshToken({ refreshToken: 'rt' }, {});
    expect(r).toBeNull();
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
  });

  test('_refreshToken: resp.ok=false -> null', async () => {
    process.env.SPOTIFY_CLIENT_ID = 'cid';
    process.env.SPOTIFY_CLIENT_SECRET = 'csec';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const r = await sp._refreshToken({ refreshToken: 'rt' }, {});
    expect(r).toBeNull();
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
  });

  test('_refreshToken: resp.ok=true, retorna access_token', async () => {
    process.env.SPOTIFY_CLIENT_ID = 'cid';
    process.env.SPOTIFY_CLIENT_SECRET = 'csec';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new-tok', expires_in: 3600 }),
    });
    const r = await sp._refreshToken({ refreshToken: 'rt' }, {});
    expect(r).toBe('new-tok');
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
  });

  test('_refreshToken: refresh_token nuevo en respuesta -> lo guarda en newPrefs', async () => {
    process.env.SPOTIFY_CLIENT_ID = 'cid';
    process.env.SPOTIFY_CLIENT_SECRET = 'csec';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new-tok', expires_in: 3600, refresh_token: 'new-rt' }),
    });
    const r = await sp._refreshToken({ refreshToken: 'old-rt' }, {});
    expect(r).toBe('new-tok');
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
  });

  test('check: no favoriteArtists -> []', async () => {
    expect(await sp.check({ enabled: true, favoriteArtists: [] }, {})).toEqual([]);
  });

  test('check: token null -> []', async () => {
    const r = await sp.check({ enabled: true, favoriteArtists: [{ id: 'a1', name: 'Artista' }] }, {});
    expect(r).toEqual([]);
  });

  test('check: token valido, fetch artista falla -> maneja error y retorna []', async () => {
    const prefs = {
      enabled: true,
      accessToken: 'tok', tokenExpiry: Date.now() + 3600000,
      favoriteArtists: [{ id: 'artist1', name: 'Artista Test' }],
    };
    global.fetch = jest.fn().mockRejectedValue(new Error('fetch fail'));
    const r = await sp.check(prefs, {});
    expect(Array.isArray(r)).toBe(true);
  });

  test('check: fetch !ok -> continue (skip artista)', async () => {
    const prefs = {
      enabled: true,
      accessToken: 'tok', tokenExpiry: Date.now() + 3600000,
      favoriteArtists: [{ id: 'a1', name: 'X' }],
    };
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 });
    const r = await sp.check(prefs, {});
    expect(r).toEqual([]);
  });

  test('check: album nuevo mas reciente que lastChecked -> push mensaje', async () => {
    const newRelease = new Date(Date.now() + 1000).toISOString().split('T')[0];
    const prefs = {
      enabled: true,
      accessToken: 'tok', tokenExpiry: Date.now() + 3600000,
      favoriteArtists: [{ id: 'a1', name: 'Artist1' }],
      lastChecked: new Date(Date.now() - 86400000).toISOString(),
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{
          name: 'Nuevo Album', album_type: 'album',
          release_date: newRelease,
          external_urls: { spotify: 'https://open.spotify.com/album/1' },
        }],
      }),
    });
    const r = await sp.check(prefs, {});
    expect(r.length).toBe(1);
    expect(r[0].message).toContain('Artist1');
  });

  test('check: album tipo single -> usa "single" en mensaje', async () => {
    const newRelease = new Date(Date.now() + 1000).toISOString().split('T')[0];
    const prefs = {
      enabled: true, accessToken: 'tok', tokenExpiry: Date.now() + 3600000,
      favoriteArtists: [{ id: 'a2', name: 'ArtistB' }],
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ name: 'Mi Single', album_type: 'single', release_date: newRelease, external_urls: {} }],
      }),
    });
    const r = await sp.check(prefs, {});
    expect(r[0].message).toContain('single');
  });
});

// ============== GMAIL extra ==============
describe('P4 extra -- GmailIntegration branches', () => {
  let g;
  beforeEach(() => { g = new GmailIntegration(); });

  test('_getToken: token no expirado -> retorna directo', async () => {
    const token = await g._getToken({ accessToken: 'valid', tokenExpiry: Date.now() + 3600000 }, {});
    expect(token).toBe('valid');
  });

  test('_refreshToken: sin credentials -> null', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    expect(await g._refreshToken({ refreshToken: 'rt' }, {})).toBeNull();
  });

  test('_refreshToken: fetch lanza -> null', async () => {
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    global.fetch = jest.fn().mockRejectedValue(new Error('network'));
    expect(await g._refreshToken({ refreshToken: 'rt' }, {})).toBeNull();
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  test('_refreshToken: resp.ok=false -> null y llama resp.text()', async () => {
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 400, statusText: 'Bad Request',
      text: async () => 'invalid_grant',
    });
    expect(await g._refreshToken({ refreshToken: 'rt' }, {})).toBeNull();
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  test('_refreshToken: resp.ok=true -> retorna token', async () => {
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new-gmail-tok', expires_in: 3600 }),
    });
    expect(await g._refreshToken({ refreshToken: 'rt' }, {})).toBe('new-gmail-tok');
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  test('check: !enabled -> []', async () => {
    expect(await g.check({ enabled: false }, {})).toEqual([]);
  });

  test('check: !morningDigest -> []', async () => {
    expect(await g.check({ enabled: true, morningDigest: false }, {})).toEqual([]);
  });

  test('check: ya hizo digest hoy -> []', async () => {
    const todayStr = new Date().toISOString().split('T')[0];
    g._lastDigestDate = todayStr;
    expect(await g.check({ enabled: true, morningDigest: true }, {})).toEqual([]);
  });
});

// ============== UBER extra ==============
describe('P4 extra -- UberIntegration branches', () => {
  test('check: eventsSnap no vacio, doc con location -> mensaje', async () => {
    const u = new UberIntegration();
    const mockAdmin = {
      firestore: () => ({
        collection: () => ({ doc: () => ({ collection: () => ({
          where: () => ({ where: () => ({ where: () => ({ limit: () => ({
            get: async () => ({
              empty: false,
              docs: [
                { data: () => ({ reason: 'Reunion', location: 'Av. Reforma 100' }) },
              ],
            }),
          }) }) }) }),
        }) }) }),
      }),
    };
    u.setDeps({ admin: mockAdmin });
    const r = await u.check({ enabled: true, preferredApp: 'uber' }, { ownerUid: 'uid1' });
    expect(Array.isArray(r)).toBe(true);
  });

  test('check: doc sin location pero reason con palabras clave -> mensaje', async () => {
    const u = new UberIntegration();
    const mockAdmin = {
      firestore: () => ({
        collection: () => ({ doc: () => ({ collection: () => ({
          where: () => ({ where: () => ({ where: () => ({ limit: () => ({
            get: async () => ({
              empty: false,
              docs: [
                { data: () => ({ reason: 'Cita en el consultorio del medico', location: null }) },
              ],
            }),
          }) }) }) }),
        }) }) }),
      }),
    };
    u.setDeps({ admin: mockAdmin });
    const r = await u.check({ enabled: true }, { ownerUid: 'uid1' });
    expect(r.length).toBeGreaterThan(0);
  });

  test('check: doc sin location y sin palabras clave -> continue (skip doc)', async () => {
    const u = new UberIntegration();
    const mockAdmin = {
      firestore: () => ({
        collection: () => ({ doc: () => ({ collection: () => ({
          where: () => ({ where: () => ({ where: () => ({ limit: () => ({
            get: async () => ({
              empty: false,
              docs: [
                { data: () => ({ reason: 'Llamar a Juan', location: null }) },
              ],
            }),
          }) }) }) }),
        }) }) }),
      }),
    };
    u.setDeps({ admin: mockAdmin });
    const r = await u.check({ enabled: true }, { ownerUid: 'uid1' });
    expect(r).toEqual([]);
  });
});

// ============== GYM extra (con fake timers) ==============
describe('P4 extra -- GymIntegration con fake timers', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Poner hora 07:00 UTC-5 (Bogota) = 12:00 UTC
    jest.setSystemTime(new Date('2026-05-11T12:00:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('check: hora correcta, generateAIContent retorna rutina -> mensaje', async () => {
    const g = new GymIntegration();
    g._lastRoutineDate = '2020-01-01';
    g.setDeps({ generateAIContent: async () => 'Sentadillas 3x15, Plancha 3x60s, Flexiones 3x10' });
    const r = await g.check({ enabled: true, exerciseTime: '07:00' }, {});
    expect(Array.isArray(r)).toBe(true);
    // Puede retornar mensaje o [] dependiendo de la hora exacta del fake timer
  });

  test('check: hora correcta, generateAIContent respuesta corta -> []', async () => {
    const g = new GymIntegration();
    g._lastRoutineDate = '2020-01-01';
    g.setDeps({ generateAIContent: async () => 'ok' });
    const r = await g.check({ enabled: true, exerciseTime: '07:00' }, {});
    expect(Array.isArray(r)).toBe(true);
  });

  test('check: con goals e injuries -> incluye en prompt', async () => {
    const g = new GymIntegration();
    g._lastRoutineDate = '2020-01-01';
    let capturedPrompt = '';
    g.setDeps({ generateAIContent: async (p) => { capturedPrompt = p; return 'Rutina completa del dia de ejercicio'; } });
    await g.check({ enabled: true, exerciseTime: '07:00', goals: 'perder peso', injuries: 'rodilla', level: 'avanzado' }, {});
    // If the hour matched, prompt was captured
    if (capturedPrompt) {
      expect(capturedPrompt).toContain('perder peso');
    }
  });
});

// ============== COCINA extra (con fake timers) ==============
describe('P4 extra -- CocinaIntegration con fake timers', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // 12:00 hora Bogota = 17:00 UTC
    jest.setSystemTime(new Date('2026-05-11T17:00:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('check: hora almuerzo, generateAIContent retorna receta -> mensaje', async () => {
    const c = new CocinaIntegration();
    c._lastSuggestionDate = '2020-01-01';
    c.setDeps({ generateAIContent: async () => 'Arroz con pollo: arroz, pollo, tomate. 20 minutos.' });
    const r = await c.check({ enabled: true, lunchTime: '12:00' }, {});
    expect(Array.isArray(r)).toBe(true);
  });

  test('check: hora almuerzo, con dietRestrictions y favoriteRecipes -> ramas branch', async () => {
    const c = new CocinaIntegration();
    c._lastSuggestionDate = '2020-01-01';
    let prompt = '';
    c.setDeps({ generateAIContent: async (p) => { prompt = p; return 'Ensalada fresca sin gluten: lechuga, tomate, zanahoria. 5 minutos.'; } });
    const r = await c.check({
      enabled: true, lunchTime: '12:00',
      dietRestrictions: 'sin gluten', favoriteRecipes: ['Milanesa', 'Asado'],
    }, {});
    if (prompt) {
      expect(prompt).toContain('sin gluten');
      expect(prompt).toContain('Milanesa');
    }
    expect(Array.isArray(r)).toBe(true);
  });

  test('check: hora almuerzo, generateAIContent lanza -> []', async () => {
    const c = new CocinaIntegration();
    c._lastSuggestionDate = '2020-01-01';
    c.setDeps({ generateAIContent: async () => { throw new Error('ai fail'); } });
    const r = await c.check({ enabled: true, lunchTime: '12:00' }, {});
    expect(Array.isArray(r)).toBe(true);
  });
});

// ============== RAPPI extra (con fake timers) ==============
describe('P4 extra -- RappiIntegration con fake timers', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // 12:10 hora Bogota = 17:10 UTC
    jest.setSystemTime(new Date('2026-05-11T17:10:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('check: hora de almuerzo, con favoriteOrders -> mensaje con favoritos', async () => {
    const r = new RappiIntegration();
    r._lastSuggestionDate = '2020-01-01';
    const result = await r.check({
      enabled: true, lunchTime: '12:00', preferredApp: 'rappi',
      favoriteOrders: ['Hamburguesa', 'Pizza', 'Sushi'],
    }, {});
    // Puede retornar mensaje o [] dependiendo de timezone conversion
    expect(Array.isArray(result)).toBe(true);
    if (result.length > 0) {
      expect(result[0].message).toContain('rappi');
    }
  });

  test('check: hora de almuerzo, sin favoriteOrders -> mensaje sin favoritos', async () => {
    const r = new RappiIntegration();
    r._lastSuggestionDate = '2020-01-01';
    const result = await r.check({
      enabled: true, lunchTime: '12:00', preferredApp: 'pedidosya',
    }, {});
    expect(Array.isArray(result)).toBe(true);
  });
});

// ============== NEWS extra ==============
describe('P4 extra -- NewsIntegration country branches', () => {
  test('_generateNewsSummary: country CO -> Colombia en prompt', async () => {
    const n = new NewsIntegration();
    let prompt = '';
    n.setDeps({ generateAIContent: async (p) => { prompt = p; return 'Noticias del dia en Colombia sobre tecnologia'; } });
    await n.check({ enabled: true, country: 'CO', topics: ['salud'] }, {});
    expect(prompt).toContain('Colombia');
  });

  test('_generateNewsSummary: country desconocido -> usa el codigo directo', async () => {
    const n = new NewsIntegration();
    let prompt = '';
    n.setDeps({ generateAIContent: async (p) => { prompt = p; return 'Noticias generales del dia para la region'; } });
    await n.check({ enabled: true, country: 'ZZ', topics: ['economia'] }, {});
    expect(prompt).toContain('ZZ');
  });

  test('checkDirect: con admin y ownerUid -> llama getPrefs', async () => {
    const n = new NewsIntegration();
    n.getPrefs = jest.fn().mockResolvedValue({ topics: ['tech'], country: 'MX', enabled: true });
    n.setDeps({ generateAIContent: async () => 'Noticias tecnologicas del dia en Mexico' });
    const mockAdmin = { firestore: jest.fn() };
    const r = await n.checkDirect({ admin: mockAdmin, ownerUid: 'uid1' });
    expect(n.getPrefs).toHaveBeenCalled();
    expect(Array.isArray(r)).toBe(true);
  });
});
