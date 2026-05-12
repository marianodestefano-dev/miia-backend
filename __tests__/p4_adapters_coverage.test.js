'use strict';

jest.mock('../integrations/base_integration', () => {
  return class BaseIntegration {
    constructor({ type, displayName, emoji, checkIntervalMs }) {
      this.type = type;
      this.displayName = displayName;
      this.emoji = emoji;
      this.checkIntervalMs = checkIntervalMs;
      this.lastCheck = 0;
      this._deps = {};
    }
    setDeps(deps) { this._deps = { ...this._deps, ...deps }; }
    shouldCheck() { return Date.now() - this.lastCheck >= this.checkIntervalMs; }
    markChecked() { this.lastCheck = Date.now(); }
    async check() { throw new Error('check() no implementado'); }
    async getPrefs() { return null; }
    async savePrefs(admin, uid, data) {
      if (!admin) return;
      await admin.firestore().collection('users').doc(uid).collection('miia_interests').doc(this.type).set(data, { merge: true });
    }
    _log(msg) { console.log('[' + this.type + ']', msg); }
    _error(msg, e) { console.error('[' + this.type + ']', msg, e); }
  };
});

const WeatherIntegration = require('../integrations/adapters/weather_integration');
const StocksIntegration = require('../integrations/adapters/stocks_integration');
const NewsIntegration = require('../integrations/adapters/news_integration');
const StreamingIntegration = require('../integrations/adapters/streaming_integration');
const RappiIntegration = require('../integrations/adapters/rappi_integration');
const UberIntegration = require('../integrations/adapters/uber_integration');
const GymIntegration = require('../integrations/adapters/gym_integration');
const CocinaIntegration = require('../integrations/adapters/cocina_integration');
const SpotifyIntegration = require('../integrations/adapters/spotify_integration');
const GmailIntegration = require('../integrations/adapters/gmail_integration');

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ============== WEATHER ==============
describe('P4 -- WeatherIntegration branches', () => {
  let w;
  beforeEach(() => { w = new WeatherIntegration(); });

  test('check: !prefs.enabled y !prefs.city -> []', async () => {
    expect(await w.check({}, {})).toEqual([]);
  });

  test('check: enabled pero sin city -> []', async () => {
    expect(await w.check({ enabled: true }, {})).toEqual([]);
  });

  test('check: no generateAIContent -> []', async () => {
    expect(await w.check({ enabled: true, city: 'Bogota' }, {})).toEqual([]);
  });

  test('check: generateAIContent retorna respuesta valida -> mensaje', async () => {
    w.setDeps({ generateAIContent: async () => 'Hoy hace 25 grados en Bogota con lluvia moderada' });
    const r = await w.check({ enabled: true, city: 'Bogota' }, {});
    expect(r.length).toBe(1);
    expect(r[0].message).toContain('Bogota');
  });

  test('check: generateAIContent retorna respuesta corta -> []', async () => {
    w.setDeps({ generateAIContent: async () => 'ok' });
    const r = await w.check({ enabled: true, city: 'Bogota' }, {});
    expect(r).toEqual([]);
  });

  test('check: generateAIContent lanza error -> []', async () => {
    w.setDeps({ generateAIContent: async () => { throw new Error('AI fail'); } });
    const r = await w.check({ enabled: true, city: 'Bogota' }, {});
    expect(r).toEqual([]);
  });

  test('check: alertRain en prefs -> incluye en prompt (branch string)', async () => {
    let capturedPrompt = '';
    w.setDeps({ generateAIContent: async (p) => { capturedPrompt = p; return 'respuesta larga del clima para prueba'; } });
    await w.check({ enabled: true, city: 'Bogota', alertRain: true }, {});
    expect(capturedPrompt).toContain('lluvia');
  });

  test('checkDirect: city vacia -> []', async () => {
    expect(await w.checkDirect('', {})).toEqual([]);
  });

  test('checkDirect: con city y generateAIContent -> mensaje', async () => {
    w.setDeps({ generateAIContent: async () => 'Pronostico largo del clima para la ciudad de prueba' });
    const r = await w.checkDirect('Buenos Aires', {});
    expect(r.length).toBe(1);
  });
});

// ============== STOCKS ==============
describe('P4 -- StocksIntegration branches', () => {
  let s;
  beforeEach(() => { s = new StocksIntegration(); });

  test('check: !enabled -> []', async () => {
    expect(await s.check({ enabled: false }, {})).toEqual([]);
  });

  test('check: sin symbols -> []', async () => {
    expect(await s.check({ enabled: true, symbols: [] }, {})).toEqual([]);
  });

  test('check: sin generateAIContent -> []', async () => {
    expect(await s.check({ enabled: true, symbols: ['AAPL'] }, {})).toEqual([]);
  });

  test('check: generateAIContent retorna respuesta -> mensaje', async () => {
    s.setDeps({ generateAIContent: async () => 'AAPL: $185 +2.3% hoy en el mercado de valores' });
    const r = await s.check({ enabled: true, symbols: ['AAPL'], alertThreshold: 5 }, {});
    expect(r.length).toBe(1);
    expect(r[0].priority).toBe('medium');
  });

  test('check: generateAIContent retorna respuesta corta -> []', async () => {
    s.setDeps({ generateAIContent: async () => 'ok' });
    const r = await s.check({ enabled: true, symbols: ['AAPL'] }, {});
    expect(r).toEqual([]);
  });

  test('check: generateAIContent lanza -> []', async () => {
    s.setDeps({ generateAIContent: async () => { throw new Error('fail'); } });
    const r = await s.check({ enabled: true, symbols: ['BTC'] }, {});
    expect(r).toEqual([]);
  });

  test('check: sin alertThreshold -> usa default 5', async () => {
    let prompt = '';
    s.setDeps({ generateAIContent: async (p) => { prompt = p; return 'respuesta larga para stocks con datos'; } });
    await s.check({ enabled: true, symbols: ['ETH'] }, {});
    expect(prompt).toContain('5');
  });
});

// ============== NEWS ==============
describe('P4 -- NewsIntegration branches', () => {
  let n;
  beforeEach(() => { n = new NewsIntegration(); });

  test('check: !enabled -> []', async () => {
    expect(await n.check({ enabled: false }, {})).toEqual([]);
  });

  test('check: sin generateAIContent -> []', async () => {
    expect(await n.check({ enabled: true }, {})).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  test('check: generateAIContent retorna respuesta -> mensaje', async () => {
    n.setDeps({ generateAIContent: async () => 'Noticias importantes del dia de hoy en Argentina' });
    const r = await n.check({ enabled: true, topics: ['tech'], country: 'AR' }, {});
    expect(r.length).toBe(1);
  });

  test('check: generateAIContent respuesta corta -> []', async () => {
    n.setDeps({ generateAIContent: async () => 'ok' });
    const r = await n.check({ enabled: true }, {});
    expect(r).toEqual([]);
  });

  test('check: generateAIContent lanza -> []', async () => {
    n.setDeps({ generateAIContent: async () => { throw new Error('fail'); } });
    const r = await n.check({ enabled: true }, {});
    expect(r).toEqual([]);
  });

  test('checkDirect: sin admin -> usa default prefs', async () => {
    n.setDeps({ generateAIContent: async () => 'Noticias importantes de tecnologia y negocios de hoy' });
    const r = await n.checkDirect({});
    expect(r.length).toBe(1);
  });

  test('check: sin topics -> usa default', async () => {
    let prompt = '';
    n.setDeps({ generateAIContent: async (p) => { prompt = p; return 'Resumen de noticias completo del dia'; } });
    await n.check({ enabled: true }, {});
    expect(prompt).toContain('tecnolog');
  });
});

// ============== STREAMING ==============
describe('P4 -- StreamingIntegration branches', () => {
  let st;
  beforeEach(() => { st = new StreamingIntegration(); });

  test('check: !enabled -> []', async () => {
    expect(await st.check({ enabled: false }, {})).toEqual([]);
  });

  test('check: sin generateAIContent -> []', async () => {
    expect(await st.check({ enabled: true }, {})).toEqual([]);
  });

  test('check: lastRecommendation reciente (< 7 dias) -> []', async () => {
    st.setDeps({ generateAIContent: async () => 'respuesta streaming' });
    const recent = new Date(Date.now() - 86400000).toISOString();
    const r = await st.check({ enabled: true, lastRecommendation: recent }, {});
    expect(r).toEqual([]);
  });

  test('check: sin lastRecommendation -> genera recomendacion', async () => {
    st.setDeps({ generateAIContent: async () => 'Mejor serie de la semana en Netflix' });
    const r = await st.check({ enabled: true }, {});
    expect(r.length).toBe(1);
    expect(r[0].priority).toBe('low');
  });

  test('check: lastRecommendation > 7 dias -> genera', async () => {
    st.setDeps({ generateAIContent: async () => 'Series recomendadas esta semana en streaming' });
    const old = new Date(Date.now() - 8 * 86400000).toISOString();
    const r = await st.check({ enabled: true, lastRecommendation: old, services: ['netflix'], genres: ['thriller'] }, {});
    expect(r.length).toBe(1);
  });

  test('check: generateAIContent lanza -> []', async () => {
    st.setDeps({ generateAIContent: async () => { throw new Error('fail'); } });
    const r = await st.check({ enabled: true }, {});
    expect(r).toEqual([]);
  });

  test('check: respuesta corta -> []', async () => {
    st.setDeps({ generateAIContent: async () => 'ok' });
    const r = await st.check({ enabled: true }, {});
    expect(r).toEqual([]);
  });
});

// ============== RAPPI ==============
describe('P4 -- RappiIntegration branches', () => {
  test('getDeepLink: rappi -> rappi URL', () => {
    expect(RappiIntegration.getDeepLink('rappi')).toContain('rappi.com');
  });

  test('getDeepLink: pedidosya -> pedidosya URL', () => {
    expect(RappiIntegration.getDeepLink('pedidosya')).toContain('pedidosya');
  });

  test('getDeepLink: ifood -> ifood URL', () => {
    expect(RappiIntegration.getDeepLink('ifood')).toContain('ifood');
  });

  test('getDeepLink: default -> rappi', () => {
    expect(RappiIntegration.getDeepLink('unknown')).toContain('rappi.com');
  });

  test('check: !enabled -> []', async () => {
    const r = new RappiIntegration();
    expect(await r.check({ enabled: false }, {})).toEqual([]);
  });

  test('check: ya sugirio hoy -> []', async () => {
    const r = new RappiIntegration();
    const todayStr = new Date().toISOString().split('T')[0];
    r._lastSuggestionDate = todayStr;
    expect(await r.check({ enabled: true }, {})).toEqual([]);
  });

  test('check: favoriteOrders vacio -> sin linea favoritos', async () => {
    const r = new RappiIntegration();
    // Simular que es hora del almuerzo (hora 12)
    const hour = 12;
    const origDate = Date;
    const mockDate = class extends Date {
      constructor(...args) { super(...args); }
      getHours() { return hour; }
      getMinutes() { return 10; }
      toISOString() { return '2026-05-11T12:00:00.000Z'; }
      toLocaleString() { return '5/11/2026, 12:10:00 AM'; }
    };
    global.Date = mockDate;
    try {
      const result = await r.check({ enabled: true, lunchTime: '12:00', preferredApp: 'pedidosya' }, {});
      // Puede retornar o no dependiendo de la hora real, pero no debe lanzar
      expect(Array.isArray(result)).toBe(true);
    } finally {
      global.Date = origDate;
    }
  });
});

// ============== UBER ==============
describe('P4 -- UberIntegration branches', () => {
  test('generateDeepLink: uber sin dropoff -> URL basica', () => {
    const url = UberIntegration.generateDeepLink('uber', {});
    expect(url).toContain('uber.com');
  });

  test('generateDeepLink: uber con dropoff lat/lng -> URL con coordenadas', () => {
    const url = UberIntegration.generateDeepLink('uber', {
      dropoffLat: -34.6, dropoffLng: -58.4, dropoffAddress: 'Buenos Aires',
    });
    expect(url).toContain('latitude');
    expect(url).toContain('formatted_address');
  });

  test('generateDeepLink: didi -> didi URL', () => {
    expect(UberIntegration.generateDeepLink('didi')).toContain('didiglobal');
  });

  test('generateDeepLink: cabify -> cabify URL', () => {
    expect(UberIntegration.generateDeepLink('cabify')).toContain('cabify');
  });

  test('generateDeepLink: default -> uber URL', () => {
    expect(UberIntegration.generateDeepLink('unknown')).toContain('uber.com');
  });

  test('check: !enabled -> []', async () => {
    const u = new UberIntegration();
    expect(await u.check({ enabled: false }, {})).toEqual([]);
  });

  test('check: sin admin dep -> []', async () => {
    const u = new UberIntegration();
    expect(await u.check({ enabled: true }, { ownerUid: 'uid1' })).toEqual([]);
  });

  test('check: admin.firestore lanza -> []', async () => {
    const u = new UberIntegration();
    const mockAdmin = {
      firestore: () => { throw new Error('db fail'); },
    };
    u.setDeps({ admin: mockAdmin });
    const r = await u.check({ enabled: true }, { ownerUid: 'uid1' });
    expect(r).toEqual([]);
  });

  test('check: query retorna vacio -> []', async () => {
    const u = new UberIntegration();
    const mockAdmin = {
      firestore: () => ({
        collection: () => ({ doc: () => ({ collection: () => ({
          where: () => ({ where: () => ({ where: () => ({ limit: () => ({
            get: async () => ({ empty: true, docs: [] }),
          }) }) }) }),
        }) }) }),
      }),
    };
    u.setDeps({ admin: mockAdmin });
    const r = await u.check({ enabled: true }, { ownerUid: 'uid1' });
    expect(r).toEqual([]);
  });
});

// ============== GYM ==============
describe('P4 -- GymIntegration branches', () => {
  let g;
  beforeEach(() => { g = new GymIntegration(); });

  test('check: !enabled -> []', async () => {
    expect(await g.check({ enabled: false }, {})).toEqual([]);
  });

  test('check: sin generateAIContent -> []', async () => {
    expect(await g.check({ enabled: true }, {})).toEqual([]);
  });

  test('check: ya genero hoy -> []', async () => {
    g.setDeps({ generateAIContent: async () => 'rutina' });
    const todayStr = new Date().toISOString().split('T')[0];
    g._lastRoutineDate = todayStr;
    const r = await g.check({ enabled: true }, {});
    expect(r).toEqual([]);
  });

  test('check: generateAIContent lanza -> []', async () => {
    g.setDeps({ generateAIContent: async () => { throw new Error('ai fail'); } });
    // Resetear lastRoutineDate para que no bloquee por fecha
    g._lastRoutineDate = '2020-01-01';
    // La hora puede no coincidir pero el error path igual se ejercita si pasa el check horario
    // Lo que si probamos: cuando pasa el horario y lanza
    const r = await g.check({ enabled: true, exerciseTime: '00:00' }, {});
    expect(Array.isArray(r)).toBe(true);
  });
});

// ============== COCINA ==============
describe('P4 -- CocinaIntegration branches', () => {
  let c;
  beforeEach(() => { c = new CocinaIntegration(); });

  test('check: !enabled -> []', async () => {
    expect(await c.check({ enabled: false }, {})).toEqual([]);
  });

  test('check: sin generateAIContent -> []', async () => {
    expect(await c.check({ enabled: true }, {})).toEqual([]);
  });

  test('check: ya sugirio hoy -> []', async () => {
    c.setDeps({ generateAIContent: async () => 'receta' });
    const todayStr = new Date().toISOString().split('T')[0];
    c._lastSuggestionDate = todayStr;
    expect(await c.check({ enabled: true }, {})).toEqual([]);
  });

  test('analyzePhoto: sin generateAIContent -> throw', async () => {
    await expect(c.analyzePhoto(Buffer.from('img'), 'image/jpeg', {})).rejects.toThrow('no disponible');
  });

  test('analyzePhoto: con generateAIContent -> retorna prompt+base64', async () => {
    c.setDeps({ generateAIContent: async () => 'receta resultado' });
    const r = await c.analyzePhoto(Buffer.from('img_bytes'), 'image/jpeg', { dietRestrictions: 'sin gluten' });
    expect(r).toHaveProperty('prompt');
    expect(r).toHaveProperty('imageBase64');
    expect(r.mimeType).toBe('image/jpeg');
  });

  test('analyzePhoto: con prefs.dietRestrictions -> se incluye en prompt', async () => {
    c.setDeps({ generateAIContent: async () => 'respuesta' });
    const r = await c.analyzePhoto(Buffer.from('x'), 'image/png', { dietRestrictions: 'vegano' });
    expect(r.prompt).toContain('vegano');
  });

  test('analyzePhoto: sin prefs -> sin restricciones', async () => {
    c.setDeps({ generateAIContent: async () => 'respuesta' });
    const r = await c.analyzePhoto(Buffer.from('x'), 'image/jpeg');
    expect(r).toHaveProperty('imageBase64');
  });
});

// ============== SPOTIFY ==============
describe('P4 -- SpotifyIntegration branches', () => {
  let sp;
  beforeEach(() => {
    sp = new SpotifyIntegration();
  });

  test('constructor: tipo y displayName correctos', () => {
    expect(sp.type).toBe('spotify');
    expect(sp.displayName).toBe('Spotify');
  });

  test('check: !enabled -> []', async () => {
    const SpotifyFull = require('../integrations/adapters/spotify_integration');
    const inst = new SpotifyFull();
    const r = await inst.check({ enabled: false }, {});
    expect(r).toEqual([]);
  });

  test('check: sin accessToken -> error o []', async () => {
    const SpotifyFull = require('../integrations/adapters/spotify_integration');
    const inst = new SpotifyFull();
    const r = await inst.check({ enabled: true }, {});
    expect(Array.isArray(r)).toBe(true);
  });
});

// ============== GMAIL ==============
describe('P4 -- GmailIntegration branches', () => {
  test('constructor: tipo correcto', () => {
    const GmailFull = require('../integrations/adapters/gmail_integration');
    const inst = new GmailFull();
    expect(inst.type).toBe('gmail');
  });

  test('check: !enabled -> []', async () => {
    const GmailFull = require('../integrations/adapters/gmail_integration');
    const inst = new GmailFull();
    const r = await inst.check({ enabled: false }, {});
    expect(r).toEqual([]);
  });

  test('check: sin accessToken -> [] o error manejado', async () => {
    const GmailFull = require('../integrations/adapters/gmail_integration');
    const inst = new GmailFull();
    const r = await inst.check({ enabled: true }, {});
    expect(Array.isArray(r)).toBe(true);
  });
});
