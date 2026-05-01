'use strict';

const {
  registerWebhook, dispatchEvent, deactivateWebhook,
  listWebhooks, signPayload, WEBHOOK_EVENTS, DISPATCH_DEFAULTS,
  __setFirestoreForTests, __setFetchForTests,
} = require('../core/webhook_dispatcher');

const UID = 'testUid1234567890abcdef';
const VALID_URL = 'https://example.com/webhook';

function makeDoc(data) {
  return { data: () => data };
}

function makeMockDb({ configs = [], throwGet = false, throwSet = false, throwList = false } = {}) {
  const docs = configs.map(c => makeDoc(c));
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            set: async (d, opts) => {
              if (throwSet) throw new Error('set error');
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { exists: false };
            },
          }),
          where: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { forEach: (fn) => docs.forEach(fn) };
            },
          }),
          get: async () => {
            if (throwList) throw new Error('list error');
            return { forEach: (fn) => docs.forEach(fn) };
          },
        }),
      }),
    }),
  };
}

function makeFetch(statusCode, { throws = false } = {}) {
  return async (url, opts) => {
    if (throws) throw new Error('network error');
    return { ok: statusCode >= 200 && statusCode < 300, status: statusCode };
  };
}

beforeEach(() => { __setFirestoreForTests(null); __setFetchForTests(null); });
afterEach(() => { __setFirestoreForTests(null); __setFetchForTests(null); });

describe('WEBHOOK_EVENTS y DISPATCH_DEFAULTS', () => {
  test('WEBHOOK_EVENTS es frozen con 8 eventos', () => {
    expect(Array.isArray(WEBHOOK_EVENTS)).toBe(true);
    expect(WEBHOOK_EVENTS.length).toBe(8);
    expect(() => { WEBHOOK_EVENTS.push('x'); }).toThrow();
  });
  test('DISPATCH_DEFAULTS es frozen con valores correctos', () => {
    expect(DISPATCH_DEFAULTS.timeoutMs).toBe(10000);
    expect(DISPATCH_DEFAULTS.maxRetries).toBe(3);
    expect(DISPATCH_DEFAULTS.baseDelayMs).toBe(1000);
    expect(() => { DISPATCH_DEFAULTS.timeoutMs = 1; }).toThrow();
  });
});

describe('registerWebhook â€” validacion', () => {
  test('lanza si uid undefined', async () => {
    await expect(registerWebhook(undefined, { url: VALID_URL })).rejects.toThrow('uid requerido');
  });
  test('lanza si url undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(registerWebhook(UID, {})).rejects.toThrow('url requerida');
  });
  test('lanza si url no es HTTPS', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(registerWebhook(UID, { url: 'http://evil.com' })).rejects.toThrow('HTTPS');
  });
  test('lanza si url demasiado larga', async () => {
    __setFirestoreForTests(makeMockDb());
    const longUrl = 'https://example.com/' + 'x'.repeat(2100);
    await expect(registerWebhook(UID, { url: longUrl })).rejects.toThrow('demasiado larga');
  });
  test('lanza si evento invalido en events', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(registerWebhook(UID, { url: VALID_URL, events: ['evento.fake'] })).rejects.toThrow('eventos invalidos');
  });
  test('registra con todos los eventos por default', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await registerWebhook(UID, { url: VALID_URL });
    expect(r.webhookId).toMatch(/^wh_/);
    expect(r.url).toBe(VALID_URL);
    expect(r.events).toEqual(WEBHOOK_EVENTS.slice());
  });
  test('registra con subset de eventos', async () => {
    __setFirestoreForTests(makeMockDb());
    const events = ['message.received', 'message.sent'];
    const r = await registerWebhook(UID, { url: VALID_URL, events });
    expect(r.events).toEqual(events);
  });
});

describe('dispatchEvent â€” validacion', () => {
  test('lanza si uid undefined', async () => {
    await expect(dispatchEvent(undefined, 'message.received', {})).rejects.toThrow('uid requerido');
  });
  test('lanza si evento invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(dispatchEvent(UID, 'evento.fake', {})).rejects.toThrow('evento invalido');
  });
  test('retorna ceros si no hay webhooks activos', async () => {
    __setFirestoreForTests(makeMockDb({ configs: [] }));
    __setFetchForTests(makeFetch(200));
    const r = await dispatchEvent(UID, 'message.received', { text: 'hi' });
    expect(r).toEqual({ dispatched: 0, failed: 0, skipped: 0 });
  });
  test('retorna skipped si no hay webhook relevante para el evento', async () => {
    const wh = { webhookId: 'wh_1', url: VALID_URL, events: ['message.sent'], active: true, secret: null };
    __setFirestoreForTests(makeMockDb({ configs: [wh] }));
    __setFetchForTests(makeFetch(200));
    const r = await dispatchEvent(UID, 'message.received', {});
    expect(r.dispatched).toBe(0);
    expect(r.skipped).toBe(1);
  });
  test('despacha correctamente a webhook relevante', async () => {
    const wh = { webhookId: 'wh_1', url: VALID_URL, events: ['message.received'], active: true, secret: null };
    __setFirestoreForTests(makeMockDb({ configs: [wh] }));
    __setFetchForTests(makeFetch(200));
    const r = await dispatchEvent(UID, 'message.received', { text: 'hello' });
    expect(r.dispatched).toBe(1);
    expect(r.failed).toBe(0);
  });
  test('cuenta failed cuando HTTP falla', async () => {
    const wh = { webhookId: 'wh_1', url: VALID_URL, events: ['message.received'], active: true, secret: null };
    __setFirestoreForTests(makeMockDb({ configs: [wh] }));
    __setFetchForTests(makeFetch(500));
    const r = await dispatchEvent(UID, 'message.received', {}, { maxRetries: 0 });
    expect(r.failed).toBe(1);
    expect(r.dispatched).toBe(0);
  });
  test('fail-open si Firestore falla al leer configs', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await dispatchEvent(UID, 'message.received', {});
    expect(r).toEqual({ dispatched: 0, failed: 0, skipped: 0 });
  });
  test('no despacha si payload supera MAX_PAYLOAD_BYTES', async () => {
    const wh = { webhookId: 'wh_1', url: VALID_URL, events: ['message.received'], active: true, secret: null };
    __setFirestoreForTests(makeMockDb({ configs: [wh] }));
    __setFetchForTests(makeFetch(200));
    const bigData = { text: 'x'.repeat(70000) };
    const r = await dispatchEvent(UID, 'message.received', bigData);
    expect(r.dispatched).toBe(0);
    expect(r.skipped).toBe(1);
  });
});

describe('dispatchEvent â€” retry', () => {
  test('reintenta hasta maxRetries en error de red', async () => {
    const wh = { webhookId: 'wh_1', url: VALID_URL, events: ['message.received'], active: true, secret: null };
    __setFirestoreForTests(makeMockDb({ configs: [wh] }));
    let attempts = 0;
    __setFetchForTests(async () => { attempts++; throw new Error('network'); });
    const r = await dispatchEvent(UID, 'message.received', {}, { maxRetries: 2, baseDelayMs: 0 });
    expect(r.failed).toBe(1);
    expect(attempts).toBe(3); // 1 inicial + 2 retries
  });
  test('exitoso al segundo intento', async () => {
    const wh = { webhookId: 'wh_1', url: VALID_URL, events: ['message.received'], active: true, secret: null };
    __setFirestoreForTests(makeMockDb({ configs: [wh] }));
    let attempts = 0;
    __setFetchForTests(async () => {
      attempts++;
      if (attempts < 2) throw new Error('network');
      return { ok: true, status: 200 };
    });
    const r = await dispatchEvent(UID, 'message.received', {}, { maxRetries: 2, baseDelayMs: 0 });
    expect(r.dispatched).toBe(1);
    expect(attempts).toBe(2);
  });
});

describe('signPayload', () => {
  test('retorna string con prefijo sha256=', () => {
    const sig = signPayload('hello', 'mysecret');
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });
  test('mismo payload y secret producen misma firma', () => {
    const a = signPayload('payload', 'secret');
    const b = signPayload('payload', 'secret');
    expect(a).toBe(b);
  });
  test('payload diferente produce firma diferente', () => {
    const a = signPayload('payload1', 'secret');
    const b = signPayload('payload2', 'secret');
    expect(a).not.toBe(b);
  });
  test('secret diferente produce firma diferente', () => {
    const a = signPayload('payload', 'secret1');
    const b = signPayload('payload', 'secret2');
    expect(a).not.toBe(b);
  });
});

describe('deactivateWebhook', () => {
  test('lanza si uid undefined', async () => {
    await expect(deactivateWebhook(undefined, 'wh_1')).rejects.toThrow('uid requerido');
  });
  test('lanza si webhookId undefined', async () => {
    await expect(deactivateWebhook(UID, undefined)).rejects.toThrow('webhookId requerido');
  });
  test('desactiva sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(deactivateWebhook(UID, 'wh_1')).resolves.toBeUndefined();
  });
  test('lanza si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(deactivateWebhook(UID, 'wh_1')).rejects.toThrow('set error');
  });
});

describe('listWebhooks', () => {
  test('lanza si uid undefined', async () => {
    await expect(listWebhooks(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay webhooks', async () => {
    __setFirestoreForTests(makeMockDb({ configs: [] }));
    const result = await listWebhooks(UID);
    expect(result).toEqual([]);
  });
  test('retorna lista de webhooks', async () => {
    const wh = { webhookId: 'wh_1', url: VALID_URL, events: ['message.received'], active: true, secret: null };
    __setFirestoreForTests(makeMockDb({ configs: [wh] }));
    const result = await listWebhooks(UID);
    expect(result.length).toBe(1);
    expect(result[0].webhookId).toBe('wh_1');
    expect(result[0].url).toBe(VALID_URL);
  });
  test('fail-open: retorna array vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwList: true }));
    const result = await listWebhooks(UID);
    expect(result).toEqual([]);
  });
});
