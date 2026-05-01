'use strict';

const {
  registerToken, getOwnerTokens, deactivateToken,
  sendPushNotification, notifyHighScoreLead,
  saveNotificationPrefs, getNotificationPrefs,
  NOTIFICATION_TYPES, MAX_TOKENS_PER_OWNER,
  FCM_ENDPOINT, NOTIFICATION_TITLE_DEFAULT,
  __setFirestoreForTests, __setHttpClientForTests,
} = require('../core/push_notifier');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const TOKEN = 'fcm_token_test_1234567890_abcdefghijklmnopqrs';

function makeMockDb({ throwGet = false, throwSet = false, docs = [] } = {}) {
  const docsMap = {};
  docs.forEach(d => { docsMap[d.id || 'doc1'] = d.data; });

  const tokensColl = {
    doc: (id) => ({
      set: async (data, opts) => { if (throwSet) throw new Error('set error'); docsMap[id] = data; },
      get: async () => {
        if (throwGet) throw new Error('get error');
        const data = docsMap[id];
        return { exists: !!data, data: () => data };
      },
    }),
    where: () => ({
      get: async () => {
        if (throwGet) throw new Error('get error');
        const items = Object.entries(docsMap).map(([id, d]) => ({ id, data: () => d }));
        return { forEach: fn => items.forEach(fn) };
      },
    }),
  };

  const prefsColl = {
    doc: (id) => ({
      set: async (data, opts) => { if (throwSet) throw new Error('set error'); docsMap['pref_' + id] = data; },
      get: async () => {
        if (throwGet) throw new Error('get error');
        const data = docsMap['pref_' + id];
        return { exists: !!data, data: () => data };
      },
    }),
  };

  return {
    collection: (name) => {
      if (name === 'push_prefs') return prefsColl;
      return {
        doc: () => ({
          collection: () => tokensColl,
        }),
      };
    },
  };
}

function makeHttpClient(responses = []) {
  let idx = 0;
  return async (url, payload, headers) => {
    const resp = responses[idx] || { success: 1 };
    idx++;
    return resp;
  };
}

beforeEach(() => {
  __setFirestoreForTests(null);
  __setHttpClientForTests(null);
  delete process.env.FCM_SERVER_KEY;
});
afterEach(() => {
  __setFirestoreForTests(null);
  __setHttpClientForTests(null);
  delete process.env.FCM_SERVER_KEY;
});

describe('NOTIFICATION_TYPES y constants', () => {
  test('tiene tipos definidos', () => {
    expect(NOTIFICATION_TYPES).toContain('high_score_lead');
    expect(NOTIFICATION_TYPES).toContain('catalog_purchase');
    expect(NOTIFICATION_TYPES.length).toBeGreaterThanOrEqual(5);
  });
  test('es frozen', () => {
    expect(() => { NOTIFICATION_TYPES.push('nuevo'); }).toThrow();
  });
  test('MAX_TOKENS_PER_OWNER es 10', () => {
    expect(MAX_TOKENS_PER_OWNER).toBe(10);
  });
  test('FCM_ENDPOINT comienza con https', () => {
    expect(FCM_ENDPOINT).toMatch(/^https:\/\//);
  });
});

describe('registerToken', () => {
  test('lanza si uid undefined', async () => {
    await expect(registerToken(undefined, TOKEN)).rejects.toThrow('uid requerido');
  });
  test('lanza si token undefined', async () => {
    await expect(registerToken(UID, undefined)).rejects.toThrow('token requerido');
  });
  test('registra sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(registerToken(UID, TOKEN, 'android')).resolves.toBeUndefined();
  });
  test('acepta platform web por default', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(registerToken(UID, TOKEN)).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(registerToken(UID, TOKEN)).rejects.toThrow('set error');
  });
});


describe('getOwnerTokens', () => {
  test('lanza si uid undefined', async () => {
    await expect(getOwnerTokens(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay tokens', async () => {
    __setFirestoreForTests(makeMockDb());
    const tokens = await getOwnerTokens(UID);
    expect(tokens).toEqual([]);
  });
  test('retorna tokens activos', async () => {
    const db = makeMockDb({ docs: [{ id: TOKEN.slice(-20), data: { token: TOKEN, active: true } }] });
    __setFirestoreForTests(db);
    const tokens = await getOwnerTokens(UID);
    expect(tokens).toContain(TOKEN);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const tokens = await getOwnerTokens(UID);
    expect(tokens).toEqual([]);
  });
});

describe('deactivateToken', () => {
  test('lanza si uid undefined', async () => {
    await expect(deactivateToken(undefined, TOKEN)).rejects.toThrow('uid requerido');
  });
  test('lanza si token undefined', async () => {
    await expect(deactivateToken(UID, undefined)).rejects.toThrow('token requerido');
  });
  test('desactiva sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(deactivateToken(UID, TOKEN)).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(deactivateToken(UID, TOKEN)).rejects.toThrow('set error');
  });
});

describe('sendPushNotification', () => {
  test('lanza si uid undefined', async () => {
    await expect(sendPushNotification(undefined, { type: 'high_score_lead' })).rejects.toThrow('uid requerido');
  });
  test('lanza si notification undefined', async () => {
    await expect(sendPushNotification(UID, null)).rejects.toThrow('notification requerido');
  });
  test('lanza si tipo invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(sendPushNotification(UID, { type: 'tipo_falso' })).rejects.toThrow('tipo invalido');
  });
  test('retorna sent=0 si sin tokens', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await sendPushNotification(UID, { type: 'high_score_lead' });
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(0);
  });
  test('retorna sent=0 si FCM_SERVER_KEY no configurada', async () => {
    const db = makeMockDb({ docs: [{ id: TOKEN.slice(-20), data: { token: TOKEN, active: true } }] });
    __setFirestoreForTests(db);
    const r = await sendPushNotification(UID, { type: 'high_score_lead' });
    expect(r.sent).toBe(0);
    expect(r.failed).toBeGreaterThan(0);
  });
  test('envia y cuenta sent=1', async () => {
    process.env.FCM_SERVER_KEY = 'test-key';
    const db = makeMockDb({ docs: [{ id: TOKEN.slice(-20), data: { token: TOKEN, active: true } }] });
    __setFirestoreForTests(db);
    __setHttpClientForTests(makeHttpClient([{ success: 1 }]));
    const r = await sendPushNotification(UID, { type: 'high_score_lead', title: 'Test', body: 'Test' });
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(0);
  });
  test('desactiva token NotRegistered', async () => {
    process.env.FCM_SERVER_KEY = 'test-key';
    const db = makeMockDb({ docs: [{ id: TOKEN.slice(-20), data: { token: TOKEN, active: true } }] });
    __setFirestoreForTests(db);
    __setHttpClientForTests(makeHttpClient([{ success: 0, error: 'NotRegistered' }]));
    const r = await sendPushNotification(UID, { type: 'high_score_lead' });
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(1);
  });
  test('cuenta failed si http falla', async () => {
    process.env.FCM_SERVER_KEY = 'test-key';
    const db = makeMockDb({ docs: [{ id: TOKEN.slice(-20), data: { token: TOKEN, active: true } }] });
    __setFirestoreForTests(db);
    __setHttpClientForTests(async () => { throw new Error('network error'); });
    const r = await sendPushNotification(UID, { type: 'high_score_lead' });
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(1);
  });
});


describe('notifyHighScoreLead', () => {
  test('lanza si uid undefined', async () => {
    await expect(notifyHighScoreLead(undefined, PHONE, 50)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(notifyHighScoreLead(UID, undefined, 50)).rejects.toThrow('phone requerido');
  });
  test('lanza si score no es numero', async () => {
    await expect(notifyHighScoreLead(UID, PHONE, 'alto')).rejects.toThrow('score debe ser numero');
  });
  test('shouldNotify = false si score < threshold', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await notifyHighScoreLead(UID, PHONE, 10);
    expect(r.shouldNotify).toBe(false);
    expect(r.notified).toBe(false);
  });
  test('shouldNotify = true si score >= threshold', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await notifyHighScoreLead(UID, PHONE, 25);
    expect(r.shouldNotify).toBe(true);
    expect(r.score).toBe(25);
  });
  test('notified = true si hay tokens y FCM OK', async () => {
    process.env.FCM_SERVER_KEY = 'test-key';
    const db = makeMockDb({ docs: [{ id: TOKEN.slice(-20), data: { token: TOKEN, active: true } }] });
    __setFirestoreForTests(db);
    __setHttpClientForTests(makeHttpClient([{ success: 1 }]));
    const r = await notifyHighScoreLead(UID, PHONE, 30);
    expect(r.notified).toBe(true);
  });
  test('usa threshold personalizado', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await notifyHighScoreLead(UID, PHONE, 15, 20);
    expect(r.shouldNotify).toBe(false);
    const r2 = await notifyHighScoreLead(UID, PHONE, 20, 20);
    expect(r2.shouldNotify).toBe(true);
  });
});

describe('saveNotificationPrefs y getNotificationPrefs', () => {
  test('lanza si uid undefined en save', async () => {
    await expect(saveNotificationPrefs(undefined, {})).rejects.toThrow('uid requerido');
  });
  test('lanza si prefs undefined', async () => {
    await expect(saveNotificationPrefs(UID, null)).rejects.toThrow('prefs requerido');
  });
  test('guarda y lee prefs', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveNotificationPrefs(UID, { enabled: true, threshold: 30 })).resolves.toBeUndefined();
  });
  test('lanza si uid undefined en get', async () => {
    await expect(getNotificationPrefs(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna defaults si no hay prefs', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getNotificationPrefs(UID);
    expect(r.enabled).toBe(true);
    expect(r.threshold).toBe(20);
  });
  test('fail-open en get si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getNotificationPrefs(UID);
    expect(r.enabled).toBe(true);
  });
  test('propaga error Firestore en save', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(saveNotificationPrefs(UID, { enabled: false })).rejects.toThrow('set error');
  });
});
