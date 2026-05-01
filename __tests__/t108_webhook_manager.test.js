'use strict';
const { registerWebhook, fireWebhook, deleteWebhook, ALLOWED_EVENTS, MAX_RETRIES, __setFirestoreForTests, __setFetchForTests } = require('../core/webhook_manager');

const UID = 'uid_wh_test';

function makeMockDb(webhooks = []) {
  const store = {};
  webhooks.forEach(wh => { store[wh.webhookId] = wh; });
  return {
    collection: () => ({
      doc: (uid) => ({
        collection: () => ({
          get: async () => ({
            docs: Object.values(store).map(w => ({ data: () => w }))
          }),
          doc: (id) => ({
            set: async (data, opts) => {
              if (opts && opts.merge) store[id] = Object.assign({}, store[id] || {}, data);
              else store[id] = data;
            },
            get: async () => store[id]
              ? { exists: true, data: () => store[id] }
              : { exists: false }
          })
        })
      })
    })
  };
}

afterEach(() => {
  __setFirestoreForTests(null);
  __setFetchForTests(null);
});

describe('ALLOWED_EVENTS', () => {
  test('tiene los 4 eventos esperados y es frozen', () => {
    expect(ALLOWED_EVENTS).toContain('message_received');
    expect(ALLOWED_EVENTS).toContain('lead_classified');
    expect(ALLOWED_EVENTS).toContain('broadcast_sent');
    expect(ALLOWED_EVENTS).toContain('consent_changed');
    expect(() => { ALLOWED_EVENTS.push('hack'); }).toThrow();
  });
});

describe('registerWebhook — validacion', () => {
  test('lanza error si uid vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(registerWebhook('', { url: 'http://test.com', events: ['message_received'] }))
      .rejects.toThrow('uid requerido');
  });
  test('lanza error si url vacia', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(registerWebhook(UID, { url: '', events: ['message_received'] }))
      .rejects.toThrow('url requerida');
  });
  test('lanza error si events vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(registerWebhook(UID, { url: 'http://test.com', events: [] }))
      .rejects.toThrow('events');
  });
  test('lanza error si evento no permitido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(registerWebhook(UID, { url: 'http://test.com', events: ['hacked_event'] }))
      .rejects.toThrow('no permitidos');
  });
});

describe('registerWebhook — exito', () => {
  test('retorna webhookId, uid, url, events, active=true', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await registerWebhook(UID, { url: 'https://myhook.com/wh', events: ['message_received'] });
    expect(r.webhookId).toBeDefined();
    expect(r.uid).toBe(UID);
    expect(r.active).toBe(true);
    expect(r.events).toContain('message_received');
  });
});

describe('fireWebhook', () => {
  test('dispara a webhook activo que escucha el evento', async () => {
    const wh = { webhookId: 'wh1', uid: UID, url: 'https://hook.com', events: ['message_received'], active: true, secret: null, failCount: 0 };
    __setFirestoreForTests(makeMockDb([wh]));
    let called = false;
    __setFetchForTests(async (url, opts) => { called = true; return { ok: true, status: 200 }; });
    const r = await fireWebhook(UID, 'message_received', { test: 1 });
    expect(called).toBe(true);
    expect(r.firedCount).toBe(1);
    expect(r.results[0].success).toBe(true);
  });

  test('no dispara si webhook no escucha ese evento', async () => {
    const wh = { webhookId: 'wh2', uid: UID, url: 'https://hook.com', events: ['broadcast_sent'], active: true, secret: null, failCount: 0 };
    __setFirestoreForTests(makeMockDb([wh]));
    let called = false;
    __setFetchForTests(async () => { called = true; return { ok: true, status: 200 }; });
    const r = await fireWebhook(UID, 'message_received', {});
    expect(called).toBe(false);
    expect(r.firedCount).toBe(0);
  });

  test('marca failure si fetch lanza error', async () => {
    const wh = { webhookId: 'wh3', uid: UID, url: 'https://hook.com', events: ['lead_classified'], active: true, secret: null, failCount: 0 };
    __setFirestoreForTests(makeMockDb([wh]));
    __setFetchForTests(async () => { throw new Error('connection refused'); });
    const r = await fireWebhook(UID, 'lead_classified', {});
    expect(r.results[0].success).toBe(false);
    expect(r.results[0].error).toContain('connection refused');
  });

  test('incluye HMAC signature si webhook tiene secret', async () => {
    const wh = { webhookId: 'wh4', uid: UID, url: 'https://hook.com', events: ['broadcast_sent'], active: true, secret: 'mysecret', failCount: 0 };
    __setFirestoreForTests(makeMockDb([wh]));
    let sigHeader = null;
    __setFetchForTests(async (url, opts) => {
      sigHeader = opts.headers['X-MIIA-Signature'];
      return { ok: true, status: 200 };
    });
    await fireWebhook(UID, 'broadcast_sent', {});
    expect(sigHeader).toBeDefined();
    expect(sigHeader).toMatch(/^sha256=/);
  });
});

describe('deleteWebhook', () => {
  test('marca webhook como inactivo', async () => {
    const wh = { webhookId: 'wh5', active: true };
    const store = makeMockDb([wh]);
    __setFirestoreForTests(store);
    const r = await deleteWebhook(UID, 'wh5');
    expect(r.deleted).toBe(true);
  });
  test('lanza error si uid o webhookId vacios', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(deleteWebhook('', 'wh1')).rejects.toThrow('uid y webhookId requeridos');
  });
});
