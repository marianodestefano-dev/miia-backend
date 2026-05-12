'use strict';
/**
 * R18-B — news_adapter.test.js
 * 100% branch coverage: rssAdapter + youtubeAdapter + newsAdapter + _parseRSSItems
 */

const {
  newsAdapter,
  rssAdapter,
  youtubeAdapter,
  RSS_FEEDS,
  YT_CHANNELS,
  MAX_ARTICLES,
  MAX_YT_RESULTS,
  CACHE_TTL_NEWS,
  DEFAULT_PAIS,
  __setFetchForTests,
} = require('../core/news_adapter');

// ── helpers ───────────────────────────────────────────────────────────────────
function makeRSSXml(items) {
  var itemsXml = items.map(function (it) {
    return '<item>'
      + '<title>' + (it.title || '') + '</title>'
      + '<link>' + (it.link || '') + '</link>'
      + (it.pubDate ? '<pubDate>' + it.pubDate + '</pubDate>' : '')
      + (it.description ? '<description>' + it.description + '</description>' : '')
      + '</item>';
  }).join('');
  return '<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title>' + itemsXml + '</channel></rss>';
}

function makeYTResponse(videos) {
  return {
    items: videos.map(function (v) {
      return {
        id: { videoId: v.videoId || 'vid123' },
        snippet: {
          title: v.title || 'Video',
          publishedAt: v.publishedAt || '2026-05-12T10:00:00Z',
          channelTitle: v.channelTitle || 'Canal',
        },
      };
    }),
  };
}

function mockFetch(responses) {
  var calls = [];
  __setFetchForTests(async function (url, opts) {
    calls.push(url);
    var key = Object.keys(responses).find(function (k) { return url.includes(k); });
    if (!key) return { ok: false, text: async function () { return ''; }, json: async function () { return {}; } };
    var resp = responses[key];
    if (resp === 'throw') throw new Error('FETCH-FAIL-' + key);
    return {
      ok: resp.ok !== false,
      text: async function () { return resp.text || ''; },
      json: async function () { return resp.json || {}; },
    };
  });
  return calls;
}

beforeEach(function () {
  // reset to a throw-all mock so no real HTTP calls
  __setFetchForTests(async function () { throw new Error('no-fetch-in-tests'); });
});

// ── _parseRSSItems (indirecta via rssAdapter) ─────────────────────────────────
describe('_parseRSSItems', function () {
  test('items array => parsea hasta MAX_ARTICLES', async function () {
    var items = Array.from({ length: 8 }, function (_, i) {
      return { title: 'T' + i, link: 'http://l' + i, pubDate: '2026-05-12', description: 'D' + i };
    });
    var xml = makeRSSXml(items);
    mockFetch({ 'eltiempo': { ok: true, text: xml } });
    var r = await rssAdapter({ pais: 'colombia' }, new AbortController().signal);
    expect(r).toHaveLength(MAX_ARTICLES);
    expect(r[0].source).toBe('rss');
  });

  test('item unico (no array) => wrappea en array', async function () {
    var xml = '<?xml version="1.0"?><rss version="2.0"><channel>'
      + '<item><title>Solo</title><link>http://solo</link></item>'
      + '</channel></rss>';
    mockFetch({ 'eltiempo': { ok: true, text: xml } });
    var r = await rssAdapter({ pais: 'colombia' }, new AbortController().signal);
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('Solo');
  });

  test('item sin pubDate => pubDate:null', async function () {
    var xml = makeRSSXml([{ title: 'A', link: 'http://a' }]);
    mockFetch({ 'eltiempo': { ok: true, text: xml } });
    var r = await rssAdapter({ pais: 'colombia' }, new AbortController().signal);
    expect(r[0].pubDate).toBeNull();
  });

  test('item sin description => description:""', async function () {
    var xml = makeRSSXml([{ title: 'B', link: 'http://b', pubDate: '2026-05-01' }]);
    mockFetch({ 'eltiempo': { ok: true, text: xml } });
    var r = await rssAdapter({ pais: 'colombia' }, new AbortController().signal);
    expect(r[0].description).toBe('');
  });

  test('item sin title ni link => usa strings vacios', async function () {
    var xml = makeRSSXml([{}]);
    mockFetch({ 'eltiempo': { ok: true, text: xml } });
    var r = await rssAdapter({ pais: 'colombia' }, new AbortController().signal);
    expect(r[0].title).toBe('');
    expect(r[0].link).toBe('');
  });

  test('sin items en canal => devuelve [] del array vacio, rssAdapter retorna null', async function () {
    var xml = '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title></channel></rss>';
    mockFetch({ 'eltiempo': { ok: true, text: xml } });
    var r = await rssAdapter({ pais: 'colombia' }, new AbortController().signal);
    expect(r).toBeNull(); // articles.length === 0 => continua al siguiente feed, ninguno -> null
  });
});

// ── rssAdapter ────────────────────────────────────────────────────────────────
describe('rssAdapter', function () {
  test('pais sin feeds (desconocido) => null', async function () {
    var r = await rssAdapter({ pais: 'zzzz' }, new AbortController().signal);
    expect(r).toBeNull();
  });

  test('pais sin params => usa colombia', async function () {
    var xml = makeRSSXml([{ title: 'T', link: 'http://t' }]);
    mockFetch({ 'eltiempo': { ok: true, text: xml } });
    var r = await rssAdapter(null, new AbortController().signal);
    expect(r).not.toBeNull();
  });

  test('primer feed ok => retorna articulos', async function () {
    var xml = makeRSSXml([{ title: 'N1', link: 'http://n1' }, { title: 'N2', link: 'http://n2' }]);
    mockFetch({ 'eltiempo': { ok: true, text: xml } });
    var r = await rssAdapter({ pais: 'colombia' }, new AbortController().signal);
    expect(r).toHaveLength(2);
  });

  test('primer feed HTTP !ok => prueba siguiente feed', async function () {
    var xml = makeRSSXml([{ title: 'Semana', link: 'http://s' }]);
    mockFetch({
      'eltiempo': { ok: false },
      'semana': { ok: true, text: xml },
    });
    var r = await rssAdapter({ pais: 'colombia' }, new AbortController().signal);
    expect(r).not.toBeNull();
    expect(r[0].title).toBe('Semana');
  });

  test('primer feed lanza error => prueba siguiente feed', async function () {
    var xml = makeRSSXml([{ title: 'Clarin', link: 'http://c' }]);
    mockFetch({
      'clarin': 'throw',
      'lanacion': { ok: true, text: xml },
    });
    var r = await rssAdapter({ pais: 'argentina' }, new AbortController().signal);
    expect(r).not.toBeNull();
  });

  test('todos los feeds fallan => null', async function () {
    mockFetch({ 'eltiempo': 'throw', 'semana': 'throw' });
    var r = await rssAdapter({ pais: 'colombia' }, new AbortController().signal);
    expect(r).toBeNull();
  });

  test('todos los feeds !ok => null', async function () {
    mockFetch({ 'eltiempo': { ok: false }, 'semana': { ok: false } });
    var r = await rssAdapter({ pais: 'colombia' }, new AbortController().signal);
    expect(r).toBeNull();
  });

  test('pais mexico => usa feeds mexico', async function () {
    var xml = makeRSSXml([{ title: 'MEX', link: 'http://mex' }]);
    mockFetch({ 'eluniversal': { ok: true, text: xml } });
    var r = await rssAdapter({ pais: 'mexico' }, new AbortController().signal);
    expect(r).not.toBeNull();
  });

  test('pais chile => usa feed chile (un solo feed)', async function () {
    var xml = makeRSSXml([{ title: 'LT', link: 'http://lt' }]);
    mockFetch({ 'latercera': { ok: true, text: xml } });
    var r = await rssAdapter({ pais: 'chile' }, new AbortController().signal);
    expect(r).not.toBeNull();
  });
});

// ── youtubeAdapter ────────────────────────────────────────────────────────────
describe('youtubeAdapter', function () {
  test('sin apiKey => null', async function () {
    var origEnv = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    var r = await youtubeAdapter({ pais: 'colombia' }, new AbortController().signal);
    expect(r).toBeNull();
    if (origEnv) process.env.YOUTUBE_API_KEY = origEnv;
  });

  test('pais sin channels (desconocido) => null', async function () {
    var r = await youtubeAdapter({ pais: 'zzzz', apiKey: 'KEY' }, new AbortController().signal);
    expect(r).toBeNull();
  });

  test('sin params => usa colombia', async function () {
    var ytResp = makeYTResponse([{ videoId: 'abc', title: 'Col News' }]);
    mockFetch({ 'youtube': { ok: true, json: ytResp } });
    var r = await youtubeAdapter({ apiKey: 'KEY' }, new AbortController().signal);
    expect(r).not.toBeNull();
  });

  test('fetch YT ok con videos => retorna lista', async function () {
    var ytResp = makeYTResponse([
      { videoId: 'v1', title: 'N1', channelTitle: 'Canal1' },
      { videoId: 'v2', title: 'N2', channelTitle: 'Canal2' },
    ]);
    mockFetch({ 'youtube': { ok: true, json: ytResp } });
    var r = await youtubeAdapter({ pais: 'colombia', apiKey: 'MYKEY' }, new AbortController().signal);
    expect(r).not.toBeNull();
    expect(r[0].source).toBe('youtube');
    expect(r[0].link).toContain('youtube.com/watch?v=v1');
  });

  test('fetch YT !ok => continua al siguiente canal', async function () {
    // primer canal !ok, segundo ok
    var calls = 0;
    __setFetchForTests(async function (url) {
      calls++;
      if (calls === 1) return { ok: false, json: async function () { return {}; } };
      return { ok: true, json: async function () { return makeYTResponse([{ videoId: 'z1', title: 'Z' }]); } };
    });
    var r = await youtubeAdapter({ pais: 'colombia', apiKey: 'KEY' }, new AbortController().signal);
    expect(r).not.toBeNull();
  });

  test('fetch YT lanza error => continua al siguiente canal', async function () {
    var calls = 0;
    __setFetchForTests(async function (url) {
      calls++;
      if (calls === 1) throw new Error('YT-FAIL');
      return { ok: true, json: async function () { return makeYTResponse([{ videoId: 'y1', title: 'Y' }]); } };
    });
    var r = await youtubeAdapter({ pais: 'colombia', apiKey: 'KEY' }, new AbortController().signal);
    expect(r).not.toBeNull();
  });

  test('todos los canales fallan => null', async function () {
    __setFetchForTests(async function () { throw new Error('YT-ALL-FAIL'); });
    var r = await youtubeAdapter({ pais: 'colombia', apiKey: 'KEY' }, new AbortController().signal);
    expect(r).toBeNull();
  });

  test('todos los canales !ok => null', async function () {
    __setFetchForTests(async function () { return { ok: false, json: async function () { return {}; } }; });
    var r = await youtubeAdapter({ pais: 'colombia', apiKey: 'KEY' }, new AbortController().signal);
    expect(r).toBeNull();
  });

  test('respuesta YT sin items => vacio, siguiente canal', async function () {
    var calls = 0;
    __setFetchForTests(async function () {
      calls++;
      if (calls === 1) return { ok: true, json: async function () { return { items: [] }; } };
      return { ok: true, json: async function () { return makeYTResponse([{ videoId: 'z2' }]); } };
    });
    var r = await youtubeAdapter({ pais: 'colombia', apiKey: 'KEY' }, new AbortController().signal);
    expect(r).not.toBeNull();
  });

  test('apiKey desde env YOUTUBE_API_KEY', async function () {
    process.env.YOUTUBE_API_KEY = 'ENV_KEY';
    var ytResp = makeYTResponse([{ videoId: 'env1', title: 'Env' }]);
    mockFetch({ 'youtube': { ok: true, json: ytResp } });
    var r = await youtubeAdapter({ pais: 'colombia' }, new AbortController().signal);
    expect(r).not.toBeNull();
    delete process.env.YOUTUBE_API_KEY;
  });

  test('params null => usa {} defaults (cubre || {} brazo derecho linea 94)', async function () {
    process.env.YOUTUBE_API_KEY = 'ENV_KEY2';
    var ytResp = makeYTResponse([{ videoId: 'n1', title: 'Null Params' }]);
    mockFetch({ 'youtube': { ok: true, json: ytResp } });
    var r = await youtubeAdapter(null, new AbortController().signal);
    expect(r).not.toBeNull();
    delete process.env.YOUTUBE_API_KEY;
  });

  test('respuesta YT sin campo items => usa [] (cubre || [] brazo derecho linea 113)', async function () {
    var calls = 0;
    __setFetchForTests(async function () {
      calls++;
      // primer canal: json sin items => {} => json.items undefined => usa []
      if (calls === 1) return { ok: true, json: async function () { return {}; } };
      // segundo canal: con items
      return { ok: true, json: async function () { return makeYTResponse([{ videoId: 'zz1' }]); } };
    });
    var r = await youtubeAdapter({ pais: 'colombia', apiKey: 'K' }, new AbortController().signal);
    expect(r).not.toBeNull();
  });

  test('item YT sin snippet => usa defaults vacios', async function () {
    __setFetchForTests(async function () {
      return {
        ok: true,
        json: async function () {
          return { items: [{ id: { videoId: 'x1' }, snippet: null }] };
        },
      };
    });
    var r = await youtubeAdapter({ pais: 'colombia', apiKey: 'K' }, new AbortController().signal);
    expect(r).not.toBeNull();
    expect(r[0].title).toBe('');
    expect(r[0].publishedAt).toBeNull();
  });

  test('limita a MAX_YT_RESULTS aunque haya mas', async function () {
    var many = Array.from({ length: 10 }, function (_, i) { return { videoId: 'v' + i, title: 'T' + i }; });
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return makeYTResponse(many); } };
    });
    var r = await youtubeAdapter({ pais: 'colombia', apiKey: 'K' }, new AbortController().signal);
    expect(r).toHaveLength(MAX_YT_RESULTS);
  });
});

// ── newsAdapter (composicion) ─────────────────────────────────────────────────
describe('newsAdapter', function () {
  test('RSS disponible => retorna RSS (no llama YouTube)', async function () {
    var xml = makeRSSXml([{ title: 'RSS News', link: 'http://rss' }]);
    mockFetch({ 'eltiempo': { ok: true, text: xml } });
    var r = await newsAdapter({ pais: 'colombia', apiKey: 'KEY' }, new AbortController().signal);
    expect(r).not.toBeNull();
    expect(r[0].source).toBe('rss');
  });

  test('RSS falla => cae a YouTube', async function () {
    mockFetch({
      'eltiempo': { ok: false },
      'semana': { ok: false },
      'youtube': { ok: true, json: makeYTResponse([{ videoId: 'y1', title: 'YT' }]) },
    });
    var r = await newsAdapter({ pais: 'colombia', apiKey: 'KEY' }, new AbortController().signal);
    expect(r).not.toBeNull();
    expect(r[0].source).toBe('youtube');
  });

  test('RSS y YouTube fallan => null', async function () {
    mockFetch({ 'eltiempo': { ok: false }, 'semana': { ok: false } });
    var origEnv = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    var r = await newsAdapter({ pais: 'colombia' }, new AbortController().signal);
    expect(r).toBeNull();
    if (origEnv) process.env.YOUTUBE_API_KEY = origEnv;
  });
});

// ── constantes exportadas ─────────────────────────────────────────────────────
describe('constantes', function () {
  test('RSS_FEEDS tiene los 4 paises', function () {
    expect(RSS_FEEDS).toHaveProperty('colombia');
    expect(RSS_FEEDS).toHaveProperty('argentina');
    expect(RSS_FEEDS).toHaveProperty('mexico');
    expect(RSS_FEEDS).toHaveProperty('chile');
  });

  test('YT_CHANNELS tiene los 4 paises', function () {
    expect(YT_CHANNELS).toHaveProperty('colombia');
    expect(YT_CHANNELS).toHaveProperty('argentina');
    expect(YT_CHANNELS).toHaveProperty('mexico');
    expect(YT_CHANNELS).toHaveProperty('chile');
  });

  test('MAX_ARTICLES=5, MAX_YT_RESULTS=5, DEFAULT_PAIS=colombia', function () {
    expect(MAX_ARTICLES).toBe(5);
    expect(MAX_YT_RESULTS).toBe(5);
    expect(DEFAULT_PAIS).toBe('colombia');
  });

  test('CACHE_TTL_NEWS = 10min', function () {
    expect(CACHE_TTL_NEWS).toBe(10 * 60 * 1000);
  });
});
