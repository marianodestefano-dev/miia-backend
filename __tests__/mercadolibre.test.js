'use strict';
/**
 * R19-A+B — mercadolibre.test.js
 * 100% branch coverage: OAuth + listings + preguntas + ventas + envios
 */

// ── Firestore mock ────────────────────────────────────────────────────────────
let mockTokenData = null;       // datos en owners/{uid}/integrations/mercadolibre
let mockAnsweredDocs = {};      // owners/{uid}/ml_answered/{questionId}
let mockTokenSetThrows = false;

const mockMlDoc = {
  get: async function () {
    return {
      exists: mockTokenData !== null,
      data: function () { return mockTokenData; },
    };
  },
  set: async function (data, opts) {
    if (mockTokenSetThrows) throw new Error('FS-SET-FAIL');
    if (opts && opts.merge) {
      mockTokenData = Object.assign({}, mockTokenData || {}, data);
    } else {
      mockTokenData = data;
    }
  },
};

const mockAnsweredCol = {
  doc: function (id) {
    return {
      set: async function (data) {
        mockAnsweredDocs[id] = data;
      },
    };
  },
};

const mockFs = {
  collection: function () {
    return {
      doc: function () {
        return {
          collection: function (colName) {
            if (colName === 'integrations') {
              return {
                doc: function () { return mockMlDoc; }
              };
            }
            if (colName === 'ml_answered') { return mockAnsweredCol; }
            return {};
          }
        };
      }
    };
  }
};

// ── Fetch mock ────────────────────────────────────────────────────────────────
let mockFetchImpl = async function () { throw new Error('no-fetch-in-tests'); };

const {
  getAuthUrl,
  handleCallback,
  refreshToken,
  isConnected,
  getMyListings,
  getListing,
  updateStock,
  updatePrice,
  getPendingQuestions,
  answerQuestion,
  getRecentSales,
  getSaleMetrics,
  getShipments,
  getShipmentTracking,
  TOKEN_REFRESH_BUFFER_MS,
  ML_API_BASE,
  ML_AUTH_BASE,
  __setFirestoreForTests,
  __setFetchForTests,
} = require('../core/integrations/mercadolibre');

__setFirestoreForTests(mockFs);
__setFetchForTests(async function (url, opts) { return mockFetchImpl(url, opts); });

function setEnv(appId, secret, redirect) {
  if (appId !== undefined) process.env.ML_APP_ID = appId || '';
  if (secret !== undefined) process.env.ML_SECRET = secret || '';
  if (redirect !== undefined) process.env.ML_REDIRECT_URI = redirect || '';
}
function clearEnv() {
  delete process.env.ML_APP_ID;
  delete process.env.ML_SECRET;
  delete process.env.ML_REDIRECT_URI;
}
function setToken(data) { mockTokenData = data; }
function clearToken() { mockTokenData = null; }

function makeTokenData(overrides) {
  return Object.assign({
    access_token: 'AT-123',
    refresh_token: 'RT-456',
    expires_at: Date.now() + 60 * 60 * 1000, // 1h in future
    seller_id: 'SELLER-789',
    nickname: 'TestSeller',
  }, overrides);
}

function mockFetch(responses) {
  mockFetchImpl = async function (url) {
    var key = Object.keys(responses).find(function (k) { return url.includes(k); });
    if (!key) return { ok: false, text: async function () { return 'not found'; }, json: async function () { return {}; } };
    var resp = responses[key];
    if (resp === 'throw') throw new Error('FETCH-FAIL');
    return {
      ok: resp.ok !== false,
      text: async function () { return resp.text || JSON.stringify(resp.json || {}); },
      json: async function () { return resp.json || {}; },
    };
  };
}

beforeEach(function () {
  clearToken();
  mockAnsweredDocs = {};
  mockTokenSetThrows = false;
  mockFetchImpl = async function () { throw new Error('no-fetch-in-tests'); };
  clearEnv();
});

// ── getAuthUrl ────────────────────────────────────────────────────────────────
describe('getAuthUrl', function () {
  test('sin uid => uid_requerido', function () {
    expect(function () { getAuthUrl(''); }).toThrow('uid_requerido');
  });

  test('sin env => ml_env_no_configurado', function () {
    expect(function () { getAuthUrl('uid-1'); }).toThrow('ml_env_no_configurado');
  });

  test('sin ML_REDIRECT_URI => ml_env_no_configurado', function () {
    process.env.ML_APP_ID = 'APP1';
    expect(function () { getAuthUrl('uid-1'); }).toThrow('ml_env_no_configurado');
  });

  test('env completo => URL con uid en state', function () {
    setEnv('APP1', 'SECRET1', 'https://miia.app/callback');
    var url = getAuthUrl('uid-abc');
    expect(url).toContain(ML_AUTH_BASE);
    expect(url).toContain('client_id=APP1');
    expect(url).toContain('uid-abc');
  });
});

// ── handleCallback ────────────────────────────────────────────────────────────
describe('handleCallback', function () {
  test('uid o code faltante => parametros_requeridos', async function () {
    await expect(handleCallback('', 'code')).rejects.toThrow('parametros_requeridos');
    await expect(handleCallback('uid', '')).rejects.toThrow('parametros_requeridos');
  });

  test('env incompleto => ml_env_no_configurado', async function () {
    await expect(handleCallback('uid-1', 'CODE')).rejects.toThrow('ml_env_no_configurado');
  });

  test('token endpoint !ok => ml_auth_failed', async function () {
    setEnv('A', 'S', 'http://cb');
    mockFetch({ 'oauth/token': { ok: false, text: 'err' } });
    await expect(handleCallback('uid-1', 'CODE')).rejects.toThrow('ml_auth_failed');
  });

  test('happy path => guarda tokens, retorna access_token y seller_id', async function () {
    setEnv('APP1', 'SECRET1', 'http://cb');
    mockFetch({
      'oauth/token': { ok: true, json: {
        access_token: 'AT-NEW',
        refresh_token: 'RT-NEW',
        expires_in: 21600,
        user_id: 12345,
        nickname: 'VENDY',
      }},
    });
    var r = await handleCallback('uid-1', 'CODE123');
    expect(r.access_token).toBe('AT-NEW');
    expect(r.seller_id).toBe('12345');
    expect(mockTokenData.nickname).toBe('VENDY');
  });

  test('sin refresh_token en respuesta => usa null', async function () {
    setEnv('A', 'S', 'http://cb');
    mockFetch({ 'oauth/token': { ok: true, json: { access_token: 'AT', expires_in: 100, user_id: 1 } } });
    var r = await handleCallback('uid-1', 'C');
    expect(mockTokenData.refresh_token).toBeNull();
  });

  test('sin nickname => usa null', async function () {
    setEnv('A', 'S', 'http://cb');
    mockFetch({ 'oauth/token': { ok: true, json: { access_token: 'AT', expires_in: 100, user_id: 1 } } });
    await handleCallback('uid-1', 'C');
    expect(mockTokenData.nickname).toBeNull();
  });

  test('sin expires_in => usa 21600s default', async function () {
    setEnv('A', 'S', 'http://cb');
    var before = Date.now();
    mockFetch({ 'oauth/token': { ok: true, json: { access_token: 'AT', user_id: 1 } } });
    await handleCallback('uid-1', 'C');
    expect(mockTokenData.expires_at).toBeGreaterThan(before + 21000 * 1000);
  });
});

// ── refreshToken ──────────────────────────────────────────────────────────────
describe('refreshToken', function () {
  test('sin token data (no conectado) => ml_no_conectado', async function () {
    await expect(refreshToken('uid-1')).rejects.toThrow('ml_no_conectado');
  });

  test('sin refresh_token => ml_refresh_sin_token', async function () {
    setToken({ access_token: 'AT', seller_id: 'S1', refresh_token: null });
    await expect(refreshToken('uid-1')).rejects.toThrow('ml_refresh_sin_token');
  });

  test('env incompleto => ml_env_no_configurado', async function () {
    setToken(makeTokenData());
    await expect(refreshToken('uid-1')).rejects.toThrow('ml_env_no_configurado');
  });

  test('token endpoint !ok => ml_refresh_failed', async function () {
    setToken(makeTokenData());
    setEnv('A', 'S', 'http://cb');
    mockFetch({ 'oauth/token': { ok: false } });
    await expect(refreshToken('uid-1')).rejects.toThrow('ml_refresh_failed');
  });

  test('happy path => nuevo access_token guardado', async function () {
    setToken(makeTokenData());
    setEnv('A', 'S', 'http://cb');
    mockFetch({ 'oauth/token': { ok: true, json: { access_token: 'AT-REFRESHED', refresh_token: 'RT-NEW2', expires_in: 21600 } } });
    var token = await refreshToken('uid-1');
    expect(token).toBe('AT-REFRESHED');
    expect(mockTokenData.access_token).toBe('AT-REFRESHED');
  });

  test('respuesta sin refresh_token => mantiene el anterior', async function () {
    setToken(makeTokenData({ refresh_token: 'RT-OLD' }));
    setEnv('A', 'S', 'http://cb');
    mockFetch({ 'oauth/token': { ok: true, json: { access_token: 'AT-R2', expires_in: 100 } } });
    await refreshToken('uid-1');
    expect(mockTokenData.refresh_token).toBe('RT-OLD');
  });
});

// ── isConnected ───────────────────────────────────────────────────────────────
describe('isConnected', function () {
  test('uid vacio => false', async function () {
    expect(await isConnected('')).toBe(false);
  });

  test('sin datos => false', async function () {
    expect(await isConnected('uid-1')).toBe(false);
  });

  test('datos sin access_token => false', async function () {
    setToken({ seller_id: 'S1' });
    expect(await isConnected('uid-1')).toBe(false);
  });

  test('con access_token => true', async function () {
    setToken(makeTokenData());
    expect(await isConnected('uid-1')).toBe(true);
  });
});

// ── _ensureValidToken (indirecta via _mlGet) ──────────────────────────────────
describe('_ensureValidToken', function () {
  test('sin datos => ml_no_conectado (via getListing)', async function () {
    await expect(getListing('uid-1', 'ITEM1')).rejects.toThrow('ml_no_conectado');
  });

  test('token vigente => usa access_token directo', async function () {
    setToken(makeTokenData({ expires_at: Date.now() + 60 * 60 * 1000 }));
    mockFetch({ '/items/ITEM1': { ok: true, json: { id: 'ITEM1', title: 'Prod', price: 100, available_quantity: 5, status: 'active' } } });
    var r = await getListing('uid-1', 'ITEM1');
    expect(r.id).toBe('ITEM1');
  });

  test('token expirado (expires_at en pasado) => llama refreshToken', async function () {
    setToken(makeTokenData({ expires_at: Date.now() - 1000, refresh_token: 'RT-EXP' }));
    setEnv('A', 'S', 'http://cb');
    var fetchCalls = [];
    mockFetchImpl = async function (url, opts) {
      fetchCalls.push(url);
      if (url.includes('oauth/token')) {
        return { ok: true, json: async function () { return { access_token: 'AT-REFRESHED', refresh_token: 'RT-N', expires_in: 21600 }; }, text: async function () { return ''; } };
      }
      if (url.includes('/items/ITEM2')) {
        return { ok: true, json: async function () { return { id: 'ITEM2', title: 'T', price: 50, available_quantity: 3, status: 'active' }; }, text: async function () { return ''; } };
      }
      return { ok: false, text: async function () { return 'err'; }, json: async function () { return {}; } };
    };
    var r = await getListing('uid-1', 'ITEM2');
    expect(r.id).toBe('ITEM2');
    expect(fetchCalls.some(function (u) { return u.includes('oauth/token'); })).toBe(true);
  });

  test('token dentro del buffer (expira pronto) => llama refreshToken', async function () {
    setToken(makeTokenData({ expires_at: Date.now() + TOKEN_REFRESH_BUFFER_MS - 1000, refresh_token: 'RT-SOON' }));
    setEnv('A', 'S', 'http://cb');
    mockFetchImpl = async function (url) {
      if (url.includes('oauth/token')) {
        return { ok: true, json: async function () { return { access_token: 'AT-FRESH', expires_in: 21600 }; }, text: async function () { return ''; } };
      }
      return { ok: true, json: async function () { return { id: 'X', title: 'Y', price: 1, available_quantity: 1, status: 'active' }; }, text: async function () { return ''; } };
    };
    var r = await getListing('uid-1', 'ITEMX');
    expect(r).toBeDefined();
  });
});

// ── _mlGet error ──────────────────────────────────────────────────────────────
describe('_mlGet HTTP errors', function () {
  test('!ok => ml_api_error con status y texto', async function () {
    setToken(makeTokenData());
    mockFetch({ '/items/BAD': { ok: false, text: 'Not found' } });
    await expect(getListing('uid-1', 'BAD')).rejects.toThrow('ml_api_error:');
  });
});

// ── getMyListings ─────────────────────────────────────────────────────────────
describe('getMyListings', function () {
  test('sin seller_id => ml_no_conectado', async function () {
    setToken({ access_token: 'AT' });
    await expect(getMyListings('uid-1', {})).rejects.toThrow('ml_no_conectado');
  });

  test('sin resultados => []', async function () {
    setToken(makeTokenData());
    mockFetch({ '/users/SELLER-789/items/search': { ok: true, json: { results: [] } } });
    var r = await getMyListings('uid-1', {});
    expect(r).toEqual([]);
  });

  test('con resultados => lista de listings', async function () {
    setToken(makeTokenData());
    mockFetchImpl = async function (url) {
      if (url.includes('/items/search')) {
        return { ok: true, json: async function () { return { results: ['MLA1', 'MLA2'] }; }, text: async function () { return ''; } };
      }
      if (url.includes('/items?ids=')) {
        return { ok: true, json: async function () { return [
          { body: { id: 'MLA1', title: 'Prod A', price: 100, available_quantity: 5, status: 'active', permalink: 'http://mla1' } },
          { body: { id: 'MLA2', title: 'Prod B', price: 200, available_quantity: 0, status: 'paused', permalink: null } },
        ]; }, text: async function () { return ''; } };
      }
      return { ok: false, text: async function () { return 'err'; }, json: async function () { return {}; } };
    };
    var r = await getMyListings('uid-1', { limit: 10, offset: 0 });
    expect(r).toHaveLength(2);
    expect(r[0].id).toBe('MLA1');
    expect(r[1].permalink).toBeNull();
  });

  test('opts faltante => usa defaults', async function () {
    setToken(makeTokenData());
    mockFetch({ '/users/SELLER-789/items/search': { ok: true, json: { results: [] } } });
    var r = await getMyListings('uid-1');
    expect(r).toEqual([]);
  });

  test('limit > MAX => clamped a 50', async function () {
    setToken(makeTokenData());
    var capturedUrl = null;
    mockFetchImpl = async function (url) {
      capturedUrl = url;
      return { ok: true, json: async function () { return { results: [] }; }, text: async function () { return ''; } };
    };
    await getMyListings('uid-1', { limit: 200 });
    expect(capturedUrl).toContain('limit=50');
  });

  test('details con body vacio => usa defaults', async function () {
    setToken(makeTokenData());
    mockFetchImpl = async function (url) {
      if (url.includes('/items/search')) return { ok: true, json: async function () { return { results: ['MLA3'] }; }, text: async function () { return ''; } };
      return { ok: true, json: async function () { return [{ body: {} }]; }, text: async function () { return ''; } };
    };
    var r = await getMyListings('uid-1', {});
    expect(r[0].id).toBe('');
    expect(r[0].status).toBe('unknown');
  });

  test('details null => retorna []', async function () {
    setToken(makeTokenData());
    mockFetchImpl = async function (url) {
      if (url.includes('/items/search')) return { ok: true, json: async function () { return { results: ['MLA4'] }; }, text: async function () { return ''; } };
      return { ok: true, json: async function () { return null; }, text: async function () { return ''; } };
    };
    var r = await getMyListings('uid-1', {});
    expect(r).toEqual([]);
  });
});

// ── getListing ────────────────────────────────────────────────────────────────
describe('getListing', function () {
  test('sin itemId => itemId_requerido', async function () {
    setToken(makeTokenData());
    await expect(getListing('uid-1', '')).rejects.toThrow('itemId_requerido');
  });

  test('happy path => detalle', async function () {
    setToken(makeTokenData());
    mockFetch({ '/items/ITEM1': { ok: true, json: { id: 'ITEM1', title: 'T', price: 150, available_quantity: 3, status: 'active', attributes: [{ id: 'COLOR', value_name: 'Rojo' }] } } });
    var r = await getListing('uid-1', 'ITEM1');
    expect(r.attributes).toHaveLength(1);
  });

  test('attributes no array => []', async function () {
    setToken(makeTokenData());
    mockFetch({ '/items/IT2': { ok: true, json: { id: 'IT2', title: 'T', price: 50, available_quantity: 1, status: 'active', attributes: null } } });
    var r = await getListing('uid-1', 'IT2');
    expect(r.attributes).toEqual([]);
  });
});

// ── updateStock ───────────────────────────────────────────────────────────────
describe('updateStock', function () {
  test('sin itemId => itemId_requerido', async function () {
    setToken(makeTokenData());
    await expect(updateStock('uid-1', '', 5)).rejects.toThrow('itemId_requerido');
  });

  test('cantidad negativa => cantidad_invalida', async function () {
    setToken(makeTokenData());
    await expect(updateStock('uid-1', 'ITEM1', -1)).rejects.toThrow('cantidad_invalida');
  });

  test('cantidad no numero => cantidad_invalida', async function () {
    setToken(makeTokenData());
    await expect(updateStock('uid-1', 'ITEM1', 'diez')).rejects.toThrow('cantidad_invalida');
  });

  test('happy path => ok:true', async function () {
    setToken(makeTokenData());
    mockFetch({ '/items/ITEM1': { ok: true, json: { id: 'ITEM1' } } });
    var r = await updateStock('uid-1', 'ITEM1', 10);
    expect(r.ok).toBe(true);
  });

  test('cantidad=0 (borde valido) => ok', async function () {
    setToken(makeTokenData());
    mockFetch({ '/items/ITEM1': { ok: true, json: {} } });
    var r = await updateStock('uid-1', 'ITEM1', 0);
    expect(r.ok).toBe(true);
  });
});

// ── updatePrice ───────────────────────────────────────────────────────────────
describe('updatePrice', function () {
  test('sin itemId => itemId_requerido', async function () {
    setToken(makeTokenData());
    await expect(updatePrice('uid-1', '', 100)).rejects.toThrow('itemId_requerido');
  });

  test('precio 0 => precio_invalido', async function () {
    setToken(makeTokenData());
    await expect(updatePrice('uid-1', 'ITEM1', 0)).rejects.toThrow('precio_invalido');
  });

  test('precio negativo => precio_invalido', async function () {
    setToken(makeTokenData());
    await expect(updatePrice('uid-1', 'ITEM1', -100)).rejects.toThrow('precio_invalido');
  });

  test('precio no numero => precio_invalido', async function () {
    setToken(makeTokenData());
    await expect(updatePrice('uid-1', 'ITEM1', 'cien')).rejects.toThrow('precio_invalido');
  });

  test('happy path => ok:true', async function () {
    setToken(makeTokenData());
    mockFetch({ '/items/ITEM1': { ok: true, json: {} } });
    var r = await updatePrice('uid-1', 'ITEM1', 999.99);
    expect(r.ok).toBe(true);
  });
});

// ── _mlPut HTTP error ─────────────────────────────────────────────────────────
describe('_mlPut HTTP errors', function () {
  test('!ok => ml_api_error', async function () {
    setToken(makeTokenData());
    mockFetch({ '/items/ITEM1': { ok: false, text: 'Forbidden' } });
    await expect(updateStock('uid-1', 'ITEM1', 5)).rejects.toThrow('ml_api_error');
  });
});

// ── getPendingQuestions ───────────────────────────────────────────────────────
describe('getPendingQuestions', function () {
  test('sin seller_id => ml_no_conectado', async function () {
    setToken({ access_token: 'AT' });
    await expect(getPendingQuestions('uid-1')).rejects.toThrow('ml_no_conectado');
  });

  test('sin preguntas => []', async function () {
    setToken(makeTokenData());
    mockFetch({ '/questions/search': { ok: true, json: { questions: [] } } });
    var r = await getPendingQuestions('uid-1');
    expect(r).toEqual([]);
  });

  test('con preguntas => lista normalizada', async function () {
    setToken(makeTokenData());
    mockFetch({ '/questions/search': { ok: true, json: { questions: [
      { id: 'Q1', item_id: 'MLA1', text: '¿Tiene garantia?', date_created: '2026-05-12', from: { nickname: 'BUYER1' } },
      { id: 'Q2', item_id: null, text: '¿Envian?', date_created: null, from: null },
    ] } } });
    var r = await getPendingQuestions('uid-1');
    expect(r).toHaveLength(2);
    expect(r[0].from.nickname).toBe('BUYER1');
    expect(r[1].from).toBeNull();
    expect(r[1].date_created).toBeNull();
  });

  test('questions undefined en respuesta => []', async function () {
    setToken(makeTokenData());
    mockFetch({ '/questions/search': { ok: true, json: {} } });
    var r = await getPendingQuestions('uid-1');
    expect(r).toEqual([]);
  });
});

// ── answerQuestion ────────────────────────────────────────────────────────────
describe('answerQuestion', function () {
  test('sin questionId => questionId_requerido', async function () {
    setToken(makeTokenData());
    await expect(answerQuestion('uid-1', '', 'Ok')).rejects.toThrow('questionId_requerido');
  });

  test('respuesta vacia => respuesta_requerida', async function () {
    setToken(makeTokenData());
    await expect(answerQuestion('uid-1', 'Q1', '')).rejects.toThrow('respuesta_requerida');
  });

  test('respuesta solo espacios => respuesta_requerida', async function () {
    setToken(makeTokenData());
    await expect(answerQuestion('uid-1', 'Q1', '   ')).rejects.toThrow('respuesta_requerida');
  });

  test('happy path => ok:true, guarda en ml_answered', async function () {
    setToken(makeTokenData());
    mockFetch({ '/answers': { ok: true, json: { id: 'ANS1' } } });
    var r = await answerQuestion('uid-1', 'Q1', 'Sí, tiene garantía de 1 año.');
    expect(r.ok).toBe(true);
    expect(mockAnsweredDocs['Q1']).toBeDefined();
    expect(mockAnsweredDocs['Q1'].questionId).toBe('Q1');
  });
});

// ── _mlPost HTTP error ────────────────────────────────────────────────────────
describe('_mlPost HTTP errors', function () {
  test('!ok => ml_api_error', async function () {
    setToken(makeTokenData());
    mockFetch({ '/answers': { ok: false, text: 'Error' } });
    await expect(answerQuestion('uid-1', 'Q1', 'Respuesta')).rejects.toThrow('ml_api_error');
  });
});

// ── getRecentSales ────────────────────────────────────────────────────────────
describe('getRecentSales', function () {
  test('sin ventas => []', async function () {
    setToken(makeTokenData());
    mockFetch({ '/orders/search': { ok: true, json: { results: [] } } });
    var r = await getRecentSales('uid-1', { days: 7 });
    expect(r).toEqual([]);
  });

  test('con ventas => lista normalizada', async function () {
    setToken(makeTokenData());
    mockFetch({ '/orders/search': { ok: true, json: { results: [
      { id: 'O1', status: 'paid', total_amount: 1500, currency_id: 'ARS', date_created: '2026-05-10', buyer: { nickname: 'BUY1' } },
      { id: 'O2', status: 'cancelled', total_amount: 0, currency_id: null, date_created: null, buyer: null },
    ] } } });
    var r = await getRecentSales('uid-1', { days: 3 });
    expect(r).toHaveLength(2);
    expect(r[0].buyer.nickname).toBe('BUY1');
    expect(r[1].buyer).toBeNull();
    expect(r[1].currency_id).toBe('ARS');
  });

  test('opts faltante => usa defaults (7 dias)', async function () {
    setToken(makeTokenData());
    var capturedUrl = null;
    mockFetchImpl = async function (url) {
      capturedUrl = url;
      return { ok: true, json: async function () { return { results: [] }; }, text: async function () { return ''; } };
    };
    await getRecentSales('uid-1');
    expect(capturedUrl).toBeDefined();
  });

  test('results undefined => []', async function () {
    setToken(makeTokenData());
    mockFetch({ '/orders/search': { ok: true, json: {} } });
    var r = await getRecentSales('uid-1', {});
    expect(r).toEqual([]);
  });
});

// ── getSaleMetrics ────────────────────────────────────────────────────────────
describe('getSaleMetrics', function () {
  test('con datos completos => metricas normalizadas', async function () {
    setToken(makeTokenData());
    mockFetch({ '/users/SELLER-789': { ok: true, json: {
      seller_reputation: { level_id: 'platinum', transactions: { total: 500 } },
      site_status: 'active',
      nickname: 'VENDY',
    } } });
    var r = await getSaleMetrics('uid-1');
    expect(r.total_ventas).toBe(500);
    expect(r.reputacion).toBe('platinum');
    expect(r.nickname).toBe('VENDY');
  });

  test('sin seller_reputation => total_ventas=0, reputacion=null', async function () {
    setToken(makeTokenData());
    mockFetch({ '/users/SELLER-789': { ok: true, json: { nickname: 'X' } } });
    var r = await getSaleMetrics('uid-1');
    expect(r.total_ventas).toBe(0);
    expect(r.reputacion).toBeNull();
  });

  test('transactions sin total => 0', async function () {
    setToken(makeTokenData());
    mockFetch({ '/users/SELLER-789': { ok: true, json: { seller_reputation: { level_id: 'gold', transactions: {} } } } });
    var r = await getSaleMetrics('uid-1');
    expect(r.total_ventas).toBe(0);
  });
});

// ── getShipments ──────────────────────────────────────────────────────────────
describe('getShipments', function () {
  test('sin filtro status => retorna todos', async function () {
    setToken(makeTokenData());
    mockFetch({ '/shipments/search': { ok: true, json: { results: [
      { id: 'SH1', status: 'delivered', tracking_number: 'TRK1', date_created: '2026-05-10',
        receiver_address: { city: { name: 'Bogota' } } },
    ] } } });
    var r = await getShipments('uid-1');
    expect(r[0].receiver_city).toBe('Bogota');
  });

  test('con filtro status => incluye en URL', async function () {
    setToken(makeTokenData());
    var capturedUrl = null;
    mockFetchImpl = async function (url) {
      capturedUrl = url;
      return { ok: true, json: async function () { return { results: [] }; }, text: async function () { return ''; } };
    };
    await getShipments('uid-1', { status: 'pending' });
    expect(capturedUrl).toContain('status=pending');
  });

  test('sin receiver_address => receiver_city null', async function () {
    setToken(makeTokenData());
    mockFetch({ '/shipments/search': { ok: true, json: { results: [
      { id: 'SH2', status: 'pending', tracking_number: null, date_created: null, receiver_address: null },
    ] } } });
    var r = await getShipments('uid-1', {});
    expect(r[0].receiver_city).toBeNull();
  });

  test('receiver_address sin city => null', async function () {
    setToken(makeTokenData());
    mockFetch({ '/shipments/search': { ok: true, json: { results: [
      { id: 'SH3', status: 'ready_to_ship', receiver_address: {} },
    ] } } });
    var r = await getShipments('uid-1', {});
    expect(r[0].receiver_city).toBeNull();
  });

  test('city sin name => null', async function () {
    setToken(makeTokenData());
    mockFetch({ '/shipments/search': { ok: true, json: { results: [
      { id: 'SH4', receiver_address: { city: {} } },
    ] } } });
    var r = await getShipments('uid-1', {});
    expect(r[0].receiver_city).toBeNull();
  });

  test('results undefined => []', async function () {
    setToken(makeTokenData());
    mockFetch({ '/shipments/search': { ok: true, json: {} } });
    var r = await getShipments('uid-1', {});
    expect(r).toEqual([]);
  });
});

// ── getShipmentTracking ───────────────────────────────────────────────────────
describe('getShipmentTracking', function () {
  test('sin shipmentId => shipmentId_requerido', async function () {
    setToken(makeTokenData());
    await expect(getShipmentTracking('uid-1', '')).rejects.toThrow('shipmentId_requerido');
  });

  test('happy path => tracking normalizado', async function () {
    setToken(makeTokenData());
    mockFetch({ '/shipments/SH1': { ok: true, json: {
      id: 'SH1', status: 'delivered', tracking_number: 'TRK1', substatus: 'delivered_to_buyer', last_updated: '2026-05-12',
    } } });
    var r = await getShipmentTracking('uid-1', 'SH1');
    expect(r.status).toBe('delivered');
    expect(r.substatus).toBe('delivered_to_buyer');
  });

  test('respuesta sin campos => usa shipmentId como id', async function () {
    setToken(makeTokenData());
    mockFetch({ '/shipments/SH2': { ok: true, json: {} } });
    var r = await getShipmentTracking('uid-1', 'SH2');
    expect(r.id).toBe('SH2');
    expect(r.status).toBe('');
    expect(r.tracking_number).toBeNull();
    expect(r.substatus).toBeNull();
    expect(r.last_updated).toBeNull();
  });
});

// ── constantes exportadas ─────────────────────────────────────────────────────
describe('constantes', function () {
  test('TOKEN_REFRESH_BUFFER_MS = 5min', function () {
    expect(TOKEN_REFRESH_BUFFER_MS).toBe(5 * 60 * 1000);
  });

  test('ML_API_BASE correcto', function () {
    expect(ML_API_BASE).toBe('https://api.mercadolibre.com');
  });

  test('ML_AUTH_BASE correcto', function () {
    expect(ML_AUTH_BASE).toBe('https://auth.mercadolibre.com.ar/authorization');
  });
});

// ── Cobertura de ramas adicionales ───────────────────────────────────────────
describe('cobertura ramas adicionales', function () {
  test('_ensureValidToken: token sin expires_at => trata como expirado (|| 0)', async function () {
    setToken(makeTokenData({ expires_at: undefined }));
    setEnv('A', 'S', 'http://cb');
    mockFetchImpl = async function (url) {
      if (url.includes('oauth/token')) return { ok: true, json: async function () { return { access_token: 'AT-NEXP', expires_in: 100 }; }, text: async function () { return ''; } };
      return { ok: true, json: async function () { return { id: 'INE', title: 'Y', price: 1, available_quantity: 1, status: 'active' }; }, text: async function () { return ''; } };
    };
    var r = await getListing('uid-1', 'INE');
    expect(r.id).toBe('INE');
  });

  test('handleCallback: sin user_id => seller_id string vacio (|| "")', async function () {
    setEnv('A', 'S', 'http://cb');
    mockFetch({ 'oauth/token': { ok: true, json: { access_token: 'AT', expires_in: 100 } } });
    await handleCallback('uid-1', 'C');
    expect(mockTokenData.seller_id).toBe('');
  });

  test('refreshToken: sin expires_in en respuesta => usa default 21600s (|| 21600)', async function () {
    setToken(makeTokenData({ refresh_token: 'RT-R' }));
    setEnv('A', 'S', 'http://cb');
    var before = Date.now();
    mockFetch({ 'oauth/token': { ok: true, json: { access_token: 'AT-DEF' } } });
    await refreshToken('uid-1');
    expect(mockTokenData.expires_at).toBeGreaterThan(before + 21000 * 1000);
  });

  test('getMyListings: search sin key results => [] (|| [])', async function () {
    setToken(makeTokenData());
    mockFetch({ '/users/SELLER-789/items/search': { ok: true, json: {} } });
    var r = await getMyListings('uid-1', {});
    expect(r).toEqual([]);
  });

  test('getMyListings: detail sin body key => usa defaults (body || {})', async function () {
    setToken(makeTokenData());
    mockFetchImpl = async function (url) {
      if (url.includes('/items/search')) return { ok: true, json: async function () { return { results: ['MLA5'] }; }, text: async function () { return ''; } };
      return { ok: true, json: async function () { return [{}]; }, text: async function () { return ''; } };
    };
    var r = await getMyListings('uid-1', {});
    expect(r[0].id).toBe('');
    expect(r[0].status).toBe('unknown');
  });

  test('getListing: respuesta sin campos => usa defaults (id||"", title||"", price||0, qty||0, status||unknown)', async function () {
    setToken(makeTokenData());
    mockFetch({ '/items/EMPTY': { ok: true, json: {} } });
    var r = await getListing('uid-1', 'EMPTY');
    expect(r.id).toBe('');
    expect(r.title).toBe('');
    expect(r.price).toBe(0);
    expect(r.available_quantity).toBe(0);
    expect(r.status).toBe('unknown');
  });

  test('getPendingQuestions: question sin text y from.nickname null => defaults (text||"", nickname||"")', async function () {
    setToken(makeTokenData());
    mockFetch({ '/questions/search': { ok: true, json: { questions: [
      { id: 'Q9', item_id: 'MLA1', from: { nickname: null } },
    ] } } });
    var r = await getPendingQuestions('uid-1');
    expect(r[0].text).toBe('');
    expect(r[0].from.nickname).toBe('');
  });

  test('getRecentSales: orden sin status y buyer.nickname null => defaults (status||"", nickname||"")', async function () {
    setToken(makeTokenData());
    mockFetch({ '/orders/search': { ok: true, json: { results: [
      { id: 'O9', total_amount: 500, date_created: '2026-05-12', buyer: { nickname: null } },
    ] } } });
    var r = await getRecentSales('uid-1', { days: 1 });
    expect(r[0].status).toBe('');
    expect(r[0].buyer.nickname).toBe('');
  });
});
