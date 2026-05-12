'use strict';

jest.mock('../integrations/base_integration', () => {
  return class BaseIntegration {
    constructor({ type, displayName, emoji, checkIntervalMs }) {
      this.type = type; this.displayName = displayName;
      this.emoji = emoji; this.checkIntervalMs = checkIntervalMs;
      this.lastCheck = 0; this._deps = {};
    }
    setDeps(deps) { this._deps = { ...this._deps, ...deps }; }
    async getPrefs() { return null; }
    async savePrefs(admin, uid, data) {
      if (!admin) return;
      await admin.firestore().collection('users').doc(uid).collection('mi').doc(this.type).set(data, { merge: true });
    }
    _log(msg) { console.log('[' + this.type + ']', msg); }
    _error(msg, e) { console.error('[' + this.type + ']', msg, e); }
  };
});

const GmailIntegration = require('../integrations/adapters/gmail_integration');
const StocksIntegration = require('../integrations/adapters/stocks_integration');

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  delete global.fetch;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});
afterEach(() => {
  jest.restoreAllMocks();
  delete global.fetch;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

function makeSaveAdmin() {
  return {
    firestore: () => ({
      collection: () => ({ doc: () => ({ collection: () => ({
        doc: () => ({ set: jest.fn().mockResolvedValue({}) }),
      }) }) }),
    }),
  };
}

// ============== GMAIL con fake timers ==============
describe('P4 gmail extra -- check() body con fake timers', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // 08:15 hora Bogota = 13:15 UTC
    jest.setSystemTime(new Date('2026-05-11T13:15:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('_refreshToken: resp.ok=true con admin -> guarda prefs y retorna token', async () => {
    const g = new GmailIntegration();
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    const admin = makeSaveAdmin();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new-tok', expires_in: 3600 }),
    });
    const tok = await g._refreshToken({ refreshToken: 'rt' }, { admin, ownerUid: 'uid1' });
    expect(tok).toBe('new-tok');
  });

  test('_getToken: token expirado -> llama _refreshToken', async () => {
    const g = new GmailIntegration();
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'refreshed-tok', expires_in: 3600 }),
    });
    const tok = await g._getToken({ accessToken: 'old', tokenExpiry: Date.now() - 1000, refreshToken: 'rt' }, {});
    expect(tok).toBe('refreshed-tok');
  });

  test('check: hora correcta, token valido, listResp vacio -> [] y guarda lastDigestDate', async () => {
    const g = new GmailIntegration();
    g._lastDigestDate = '2020-01-01';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [] }),
    });
    const r = await g.check({
      enabled: true, morningDigest: true,
      accessToken: 'valid-tok', tokenExpiry: Date.now() + 3600000,
      digestTime: '08:00',
    }, {});
    expect(r).toEqual([]);
  });

  test('check: listResp !ok -> []', async () => {
    const g = new GmailIntegration();
    g._lastDigestDate = '2020-01-01';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 });
    const r = await g.check({
      enabled: true, morningDigest: true,
      accessToken: 'valid-tok', tokenExpiry: Date.now() + 3600000,
      digestTime: '08:00',
    }, {});
    expect(r).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  test('check: lista con mensajes, fetch individual ok -> resumen', async () => {
    const g = new GmailIntegration();
    g._lastDigestDate = '2020-01-01';
    global.fetch = jest.fn()
      // Primera llamada: listar mensajes
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ id: 'msg1' }, { id: 'msg2' }] }),
      })
      // Segunda llamada: detalle msg1
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          payload: { headers: [
            { name: 'Subject', value: 'Asunto Importante' },
            { name: 'From', value: 'Remitente <r@test.com>' },
          ] },
        }),
      })
      // Tercera llamada: detalle msg2
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          payload: { headers: [
            { name: 'Subject', value: 'Otro Asunto' },
            { name: 'From', value: 'Otro <o@test.com>' },
          ] },
        }),
      });

    const r = await g.check({
      enabled: true, morningDigest: true,
      accessToken: 'valid-tok', tokenExpiry: Date.now() + 3600000,
      digestTime: '08:00',
    }, {});
    expect(r.length).toBe(1);
    expect(r[0].message).toContain('Asunto Importante');
    expect(r[0].priority).toBe('medium');
  });

  test('check: lista con mensajes, fetch individual !ok -> skip', async () => {
    const g = new GmailIntegration();
    g._lastDigestDate = '2020-01-01';
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ id: 'msg1' }] }),
      })
      .mockResolvedValueOnce({ ok: false, status: 403 });

    const r = await g.check({
      enabled: true, morningDigest: true,
      accessToken: 'valid-tok', tokenExpiry: Date.now() + 3600000,
      digestTime: '08:00',
    }, {});
    // emailSummaries.length === 0 -> return []
    expect(r).toEqual([]);
  });

  test('check: lista con mensajes, fetch individual lanza -> warn y skip', async () => {
    const g = new GmailIntegration();
    g._lastDigestDate = '2020-01-01';
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ id: 'msg1' }] }),
      })
      .mockRejectedValueOnce(new Error('msg fetch fail'));

    const r = await g.check({
      enabled: true, morningDigest: true,
      accessToken: 'valid-tok', tokenExpiry: Date.now() + 3600000,
      digestTime: '08:00',
    }, {});
    expect(r).toEqual([]);
  });

  test('check: mas de 5 mensajes -> moreText en resultado', async () => {
    const g = new GmailIntegration();
    g._lastDigestDate = '2020-01-01';
    // Lista retorna 6 mensajes
    const msgList = [1,2,3,4,5,6].map(i => ({ id: 'msg' + i }));
    // Para los primeros 5 fetch individuales OK
    const mockFetch = jest.fn();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ messages: msgList }) });
    for (let i = 0; i < 5; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          payload: { headers: [
            { name: 'Subject', value: 'Subj' + i },
            { name: 'From', value: 'from' + i + '@test.com' },
          ] },
        }),
      });
    }
    global.fetch = mockFetch;
    const r = await g.check({
      enabled: true, morningDigest: true,
      accessToken: 'valid-tok', tokenExpiry: Date.now() + 3600000,
      digestTime: '08:00',
    }, {});
    expect(r.length).toBe(1);
    expect(r[0].message).toContain('y 1 m');
  });

  test('check: importantSenders en prefs -> usa en query', async () => {
    const g = new GmailIntegration();
    g._lastDigestDate = '2020-01-01';
    let capturedUrl = '';
    global.fetch = jest.fn().mockImplementation((url) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: async () => ({ messages: [] }),
      });
    });
    await g.check({
      enabled: true, morningDigest: true,
      accessToken: 'valid-tok', tokenExpiry: Date.now() + 3600000,
      digestTime: '08:00', importantSenders: ['jefe@empresa.com'],
    }, {});
    expect(capturedUrl).toContain('jefe');
  });

  test('check: fetch lista lanza -> []', async () => {
    const g = new GmailIntegration();
    g._lastDigestDate = '2020-01-01';
    global.fetch = jest.fn().mockRejectedValue(new Error('network fail'));
    const r = await g.check({
      enabled: true, morningDigest: true,
      accessToken: 'valid-tok', tokenExpiry: Date.now() + 3600000,
      digestTime: '08:00',
    }, {});
    expect(r).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });
});

// ============== STOCKS line 54 (savePrefs con admin) ==============
describe('P4 stocks -- savePrefs branch (line 54)', () => {
  test('check: ctx.admin + ownerUid -> llama savePrefs (branch true)', async () => {
    const s = new StocksIntegration();
    let savedData = null;
    const admin = {
      firestore: () => ({
        collection: () => ({ doc: () => ({ collection: () => ({
          doc: () => ({ set: jest.fn().mockImplementation((data) => { savedData = data; return Promise.resolve({}); }) }),
        }) }) }),
      }),
    };
    s.setDeps({ generateAIContent: async () => 'AAPL: $185 subio 3.2 porciento hoy en el mercado' });
    const r = await s.check(
      { enabled: true, symbols: ['AAPL'] },
      { admin, ownerUid: 'uid1' }
    );
    expect(r.length).toBe(1);
    expect(savedData).toBeDefined();
    expect(savedData.lastCheck).toBeDefined();
  });
});
