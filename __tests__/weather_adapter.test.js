'use strict';
/**
 * R18-C — weather_adapter.test.js
 * 100% branch coverage: officialWeatherAdapter + owmAdapter + geminiWeatherAdapter + weatherAdapter
 */

const {
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
} = require('../core/weather_adapter');

beforeEach(function () {
  __setFetchForTests(async function () { throw new Error('no-fetch-in-tests'); });
  __setGeminiForTests(async function () { return null; });
  delete process.env.OPENWEATHER_API_KEY;
});

// ── _parseOfficialResponse (indirecta via officialWeatherAdapter) ──────────────
describe('_parseOfficialResponse', function () {
  test('json con temperatura => normaliza', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return { temperatura: '18.5', descripcion: 'Nublado', ciudad: 'Bogota', humedad: 80, viento: 10 }; } };
    });
    var r = await officialWeatherAdapter({ pais: 'colombia', ciudad: 'Bogota' }, new AbortController().signal);
    expect(r).not.toBeNull();
    expect(r.temp_c).toBe(19);
    expect(r.source).toBe('oficial_colombia');
    expect(r.humedad_pct).toBe(80);
    expect(r.viento_kmh).toBe(10);
  });

  test('json con temp alternativo y description alternativo', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return { temp: 22, description: 'Soleado' }; } };
    });
    var r = await officialWeatherAdapter({ pais: 'argentina', ciudad: 'Buenos Aires' }, new AbortController().signal);
    expect(r).not.toBeNull();
    expect(r.temp_c).toBe(22);
  });

  test('json con temperature y condicion y nombre', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return { temperature: 28, condicion: 'Caluroso', nombre: 'Guadalajara' }; } };
    });
    var r = await officialWeatherAdapter({ pais: 'mexico', ciudad: 'Guadalajara' }, new AbortController().signal);
    expect(r).not.toBeNull();
    expect(r.descripcion).toBe('Caluroso');
  });

  test('json con condition y city', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return { temperatura: 15, condition: 'Frio', city: 'Santiago' }; } };
    });
    var r = await officialWeatherAdapter({ pais: 'chile', ciudad: 'Santiago' }, new AbortController().signal);
    expect(r).not.toBeNull();
    expect(r.ciudad).toBe('Santiago');
  });

  test('json sin temperatura ni descripcion => null', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return { otro: 'dato' }; } };
    });
    var r = await officialWeatherAdapter({ pais: 'colombia', ciudad: 'X' }, new AbortController().signal);
    expect(r).toBeNull();
  });

  test('json null => null', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return null; } };
    });
    var r = await officialWeatherAdapter({ pais: 'colombia', ciudad: 'X' }, new AbortController().signal);
    expect(r).toBeNull();
  });

  test('temperatura null + descripcion presente => retorna con temp_c null', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return { descripcion: 'Lluvioso' }; } };
    });
    var r = await officialWeatherAdapter({ pais: 'colombia', ciudad: 'X' }, new AbortController().signal);
    expect(r).not.toBeNull();
    expect(r.temp_c).toBeNull();
    expect(r.descripcion).toBe('Lluvioso');
  });

  test('json sin humedad ni viento => ambos null', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return { temperatura: 20 }; } };
    });
    var r = await officialWeatherAdapter({ pais: 'colombia', ciudad: 'X' }, new AbortController().signal);
    expect(r.humedad_pct).toBeNull();
    expect(r.viento_kmh).toBeNull();
  });
});

// ── officialWeatherAdapter ────────────────────────────────────────────────────
describe('officialWeatherAdapter', function () {
  test('pais sin API oficial (desconocido) => null', async function () {
    var r = await officialWeatherAdapter({ pais: 'zzzz', ciudad: 'X' }, new AbortController().signal);
    expect(r).toBeNull();
  });

  test('params null => usa defaults', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return { temperatura: 20, descripcion: 'Ok' }; } };
    });
    var r = await officialWeatherAdapter(null, new AbortController().signal);
    expect(r).not.toBeNull();
  });

  test('API !ok => null', async function () {
    __setFetchForTests(async function () { return { ok: false }; });
    var r = await officialWeatherAdapter({ pais: 'colombia', ciudad: 'Bog' }, new AbortController().signal);
    expect(r).toBeNull();
  });

  test('fetch lanza error => null (catch)', async function () {
    __setFetchForTests(async function () { throw new Error('NET-FAIL'); });
    var r = await officialWeatherAdapter({ pais: 'colombia', ciudad: 'Bog' }, new AbortController().signal);
    expect(r).toBeNull();
  });
});

// ── _parseOWMResponse (indirecta via owmAdapter) ──────────────────────────────
describe('_parseOWMResponse', function () {
  function makeOWMJson(overrides) {
    return Object.assign({
      name: 'Bogota',
      sys: { country: 'CO' },
      main: { temp: 18, feels_like: 16, humidity: 75 },
      weather: [{ description: 'cielo despejado' }],
      wind: { speed: 3 },
    }, overrides);
  }

  test('json completo => parsea todos los campos', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return makeOWMJson(); } };
    });
    var r = await owmAdapter({ ciudad: 'Bogota', apiKey: 'KEY' }, new AbortController().signal);
    expect(r).not.toBeNull();
    expect(r.temp_c).toBe(18);
    expect(r.viento_kmh).toBe(Math.round(3 * 3.6));
    expect(r.source).toBe('openweathermap');
  });

  test('json sin main => null', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return { name: 'X' }; } };
    });
    var r = await owmAdapter({ ciudad: 'X', apiKey: 'KEY' }, new AbortController().signal);
    expect(r).toBeNull();
  });

  test('json null => null', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return null; } };
    });
    var r = await owmAdapter({ ciudad: 'X', apiKey: 'KEY' }, new AbortController().signal);
    expect(r).toBeNull();
  });

  test('sin weather array => descripcion vacia', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return makeOWMJson({ weather: null }); } };
    });
    var r = await owmAdapter({ ciudad: 'Bogota', apiKey: 'KEY' }, new AbortController().signal);
    expect(r.descripcion).toBe('');
  });

  test('sin sys => pais vacio', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return makeOWMJson({ sys: null }); } };
    });
    var r = await owmAdapter({ ciudad: 'Bogota', apiKey: 'KEY' }, new AbortController().signal);
    expect(r.pais).toBe('');
  });

  test('sin wind => viento_kmh null', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return makeOWMJson({ wind: null }); } };
    });
    var r = await owmAdapter({ ciudad: 'Bogota', apiKey: 'KEY' }, new AbortController().signal);
    expect(r.viento_kmh).toBeNull();
  });

  test('wind sin speed => usa 0 (cubre || 0 brazo derecho linea 58)', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return makeOWMJson({ wind: {} }); } };
    });
    var r = await owmAdapter({ ciudad: 'Bogota', apiKey: 'KEY' }, new AbortController().signal);
    expect(r.viento_kmh).toBe(0);
  });

  test('main.temp undefined => temp_c null', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return makeOWMJson({ main: { humidity: 70 } }); } };
    });
    var r = await owmAdapter({ ciudad: 'Bogota', apiKey: 'KEY' }, new AbortController().signal);
    expect(r.temp_c).toBeNull();
  });

  test('main.feels_like undefined => feels_like_c null', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return makeOWMJson({ main: { temp: 20, humidity: 70 } }); } };
    });
    var r = await owmAdapter({ ciudad: 'Bogota', apiKey: 'KEY' }, new AbortController().signal);
    expect(r.feels_like_c).toBeNull();
  });

  test('main.humidity undefined => humedad_pct null (cubre !== undefined false branch)', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return makeOWMJson({ main: { temp: 20, feels_like: 18 } }); } };
    });
    var r = await owmAdapter({ ciudad: 'Bogota', apiKey: 'KEY' }, new AbortController().signal);
    expect(r.humedad_pct).toBeNull();
  });

  test('json.name falsy => ciudad vacia (cubre || "" brazo derecho linea 52)', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return makeOWMJson({ name: null }); } };
    });
    var r = await owmAdapter({ ciudad: 'Bogota', apiKey: 'KEY' }, new AbortController().signal);
    expect(r.ciudad).toBe('');
  });
});

// ── owmAdapter ────────────────────────────────────────────────────────────────
describe('owmAdapter', function () {
  test('sin apiKey ni env => null', async function () {
    var r = await owmAdapter({ ciudad: 'Bogota' }, new AbortController().signal);
    expect(r).toBeNull();
  });

  test('apiKey desde env OPENWEATHER_API_KEY', async function () {
    process.env.OPENWEATHER_API_KEY = 'ENV_OWM_KEY';
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return { name: 'Bogota', sys: { country: 'CO' }, main: { temp: 20, feels_like: 18, humidity: 80 }, weather: [{ description: 'ok' }], wind: { speed: 2 } }; } };
    });
    var r = await owmAdapter({ ciudad: 'Bogota' }, new AbortController().signal);
    expect(r).not.toBeNull();
  });

  test('params null => usa defaults', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return { name: 'Bogota', sys: { country: 'CO' }, main: { temp: 18, feels_like: 16, humidity: 75 }, weather: [{ description: 'ok' }], wind: { speed: 1 } }; } };
    });
    var r = await owmAdapter(null, new AbortController().signal);
    // no apiKey, returns null unless env set
    expect(r).toBeNull();
  });

  test('fetch !ok => null', async function () {
    __setFetchForTests(async function () { return { ok: false }; });
    var r = await owmAdapter({ ciudad: 'Bogota', apiKey: 'KEY' }, new AbortController().signal);
    expect(r).toBeNull();
  });

  test('fetch lanza error => null (catch)', async function () {
    __setFetchForTests(async function () { throw new Error('OWM-FAIL'); });
    var r = await owmAdapter({ ciudad: 'Bogota', apiKey: 'KEY' }, new AbortController().signal);
    expect(r).toBeNull();
  });
});

// ── geminiWeatherAdapter ──────────────────────────────────────────────────────
describe('geminiWeatherAdapter', function () {
  test('gemini retorna texto => objeto con source=gemini', async function () {
    __setGeminiForTests(async function () { return 'Temperatura 22°C, cielo despejado'; });
    var r = await geminiWeatherAdapter({ ciudad: 'Medellin' });
    expect(r).not.toBeNull();
    expect(r.source).toBe('gemini');
    expect(r.descripcion).toContain('22°C');
    expect(r.ciudad).toBe('Medellin');
  });

  test('gemini retorna null => null', async function () {
    __setGeminiForTests(async function () { return null; });
    var r = await geminiWeatherAdapter({ ciudad: 'X' });
    expect(r).toBeNull();
  });

  test('gemini lanza error => null (catch)', async function () {
    __setGeminiForTests(async function () { throw new Error('GEMINI-FAIL'); });
    var r = await geminiWeatherAdapter({ ciudad: 'X' });
    expect(r).toBeNull();
  });

  test('params null => usa DEFAULT_CIUDAD', async function () {
    __setGeminiForTests(async function () { return 'ok'; });
    var r = await geminiWeatherAdapter(null);
    expect(r).not.toBeNull();
    expect(r.ciudad).toBe(DEFAULT_CIUDAD);
  });
});

// ── weatherAdapter (composicion) ──────────────────────────────────────────────
describe('weatherAdapter', function () {
  test('oficial ok => retorna oficial', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () { return { temperatura: 18, descripcion: 'Ok' }; } };
    });
    var r = await weatherAdapter({ pais: 'colombia', ciudad: 'Bogota' }, new AbortController().signal);
    expect(r.source).toBe('oficial_colombia');
  });

  test('oficial null, OWM ok => retorna OWM', async function () {
    __setFetchForTests(async function () {
      return { ok: true, json: async function () {
        return { name: 'Bogota', sys: { country: 'CO' }, main: { temp: 18, feels_like: 16, humidity: 75 }, weather: [{ description: 'ok' }], wind: { speed: 2 } };
      }};
    });
    // oficial retorna null porque pais=zzzz no tiene API
    var r = await weatherAdapter({ pais: 'zzzz', ciudad: 'Bogota', apiKey: 'KEY' }, new AbortController().signal);
    expect(r.source).toBe('openweathermap');
  });

  test('oficial null, OWM null, Gemini ok => retorna Gemini', async function () {
    // oficial: pais desconocido => null; OWM: sin apiKey => null; Gemini: retorna texto
    __setGeminiForTests(async function () { return 'Clima fresco'; });
    var r = await weatherAdapter({ pais: 'zzzz', ciudad: 'Medellin' }, new AbortController().signal);
    expect(r.source).toBe('gemini');
  });

  test('todas las capas null => null', async function () {
    // oficial: desconocido => null; OWM: sin key => null; Gemini: null
    __setGeminiForTests(async function () { return null; });
    var r = await weatherAdapter({ pais: 'zzzz', ciudad: 'X' }, new AbortController().signal);
    expect(r).toBeNull();
  });
});

// ── constantes exportadas ─────────────────────────────────────────────────────
describe('constantes', function () {
  test('OFFICIAL_APIS tiene los 4 paises', function () {
    expect(OFFICIAL_APIS).toHaveProperty('colombia');
    expect(OFFICIAL_APIS).toHaveProperty('argentina');
    expect(OFFICIAL_APIS).toHaveProperty('mexico');
    expect(OFFICIAL_APIS).toHaveProperty('chile');
    expect(OFFICIAL_APIS.colombia.name).toBe('IDEAM');
    expect(OFFICIAL_APIS.argentina.name).toBe('SMN');
  });

  test('CACHE_TTL_WEATHER = 30min', function () {
    expect(CACHE_TTL_WEATHER).toBe(30 * 60 * 1000);
  });

  test('DEFAULT_CIUDAD y DEFAULT_PAIS', function () {
    expect(DEFAULT_CIUDAD).toBe('Bogota');
    expect(DEFAULT_PAIS).toBe('colombia');
  });
});
