'use strict';

const {
  buildWebhookRecord, saveWebhook, updateWebhookStatus,
  getWebhooks, logWebhookEvent, buildWebhookPayload, getWebhooksForEvent, shouldRetry,
  signPayload, verifySignature, generateWebhookSecret,
  isValidDirection, isValidStatus, isValidEventType,
  WEBHOOK_DIRECTIONS, WEBHOOK_STATUSES, WEBHOOK_EVENT_TYPES,
  MAX_WEBHOOKS_PER_TENANT, MAX_RETRY_ATTEMPTS, RETRY_DELAY_MS, WEBHOOK_TIMEOUT_MS,
  __setFirestoreForTests,
} = require('../core/webhook_manager');

const UID = 'testUid1234567890';
const URL = 'https://ejemplo.com/webhook';

function makeMockDb({ stored = {}, throwGet = false, throwSet = false } = {}) {
  const db_stored = { ...stored };
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              db_stored[id] = opts && opts.merge ? { ...(db_stored[id] || {}), ...data } : data;
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return {
              forEach: fn => Object.entries(db_stored).forEach(([id, data]) => fn({ data: () => data })),
            };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

describe('Constantes', () => {
  test('WEBHOOK_DIRECTIONS tiene 2', () => { expect(WEBHOOK_DIRECTIONS.length).toBe(2); });
  test('frozen WEBHOOK_DIRECTIONS', () => { expect(() => { WEBHOOK_DIRECTIONS.push('x'); }).toThrow(); });
  test('WEBHOOK_STATUSES tiene 4', () => { expect(WEBHOOK_STATUSES.length).toBe(4); });
  test('WEBHOOK_EVENT_TYPES tiene 8', () => { expect(WEBHOOK_EVENT_TYPES.length).toBe(8); });
  test('frozen WEBHOOK_EVENT_TYPES', () => { expect(() => { WEBHOOK_EVENT_TYPES.push('x'); }).toThrow(); });
  test('MAX_WEBHOOKS_PER_TENANT es 10', () => { expect(MAX_WEBHOOKS_PER_TENANT).toBe(10); });
  test('MAX_RETRY_ATTEMPTS es 3', () => { expect(MAX_RETRY_ATTEMPTS).toBe(3); });
  test('RETRY_DELAY_MS es 5min', () => { expect(RETRY_DELAY_MS).toBe(5 * 60 * 1000); });
  test('WEBHOOK_TIMEOUT_MS es 10s', () => { expect(WEBHOOK_TIMEOUT_MS).toBe(10 * 1000); });
});

describe('isValidDirection / isValidStatus / isValidEventType', () => {
  test('outbound es direction valida', () => { expect(isValidDirection('outbound')).toBe(true); });
  test('push no es direction valida', () => { expect(isValidDirection('push')).toBe(false); });
  test('active es status valido', () => { expect(isValidStatus('active')).toBe(true); });
  test('deleted no es valido', () => { expect(isValidStatus('deleted')).toBe(false); });
  test('new_lead es eventType valido', () => { expect(isValidEventType('new_lead')).toBe(true); });
  test('email no es eventType valido', () => { expect(isValidEventType('email')).toBe(false); });
});

describe('generateWebhookSecret / signPayload / verifySignature', () => {
  test('generateWebhookSecret retorna hex 64 chars', () => {
    const secret = generateWebhookSecret();
    expect(typeof secret).toBe('string');
    expect(secret.length).toBe(64);
  });

  test('signPayload retorna firma sha256=...', () => {
    const sig = signPayload({ event: 'test' }, 'mi-secreto');
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  test('signPayload lanza si payload o secret undefined', () => {
    expect(() => signPayload(null, 'secret')).toThrow('requeridos');
    expect(() => signPayload({ data: 1 }, null)).toThrow('requeridos');
  });

  test('verifySignature valida firma correcta', () => {
    const secret = 'mi-secreto-hmac';
    const payload = JSON.stringify({ event: 'new_lead', data: { phone: '+54111' } });
    const sig = signPayload(payload, secret);
    expect(verifySignature(payload, sig, secret)).toBe(true);
  });

  test('verifySignature rechaza firma incorrecta', () => {
    const secret = 'mi-secreto';
    const payload = JSON.stringify({ event: 'test' });
    expect(verifySignature(payload, 'sha256=wrongsignature_must_be_64_chars_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', secret)).toBe(false);
  });

  test('verifySignature retorna false si parametros null', () => {
    expect(verifySignature(null, 'sig', 'secret')).toBe(false);
    expect(verifySignature('payload', null, 'secret')).toBe(false);
  });
});

describe('buildWebhookRecord', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildWebhookRecord(undefined, URL)).toThrow('uid requerido');
  });
  test('lanza si url undefined', () => {
    expect(() => buildWebhookRecord(UID, undefined)).toThrow('url requerido');
  });
  test('lanza si url no es http/https', () => {
    expect(() => buildWebhookRecord(UID, 'ftp://example.com')).toThrow('http/https');
  });
  test('construye record con defaults', () => {
    const r = buildWebhookRecord(UID, URL);
    expect(r.webhookId).toMatch(/^wh_/);
    expect(r.uid).toBe(UID);
    expect(r.url).toBe(URL);
    expect(r.direction).toBe('outbound');
    expect(r.status).toBe('active');
    expect(r.secret).toBeDefined();
    expect(r.secret.length).toBe(64);
    expect(r.events.length).toBeGreaterThan(0);
    expect(r.retryAttempts).toBe(0);
  });
  test('aplica opts: direction, events, name', () => {
    const r = buildWebhookRecord(UID, URL, {
      direction: 'inbound', events: ['new_lead', 'handoff'], name: 'Mi Webhook',
    });
    expect(r.direction).toBe('inbound');
    expect(r.events).toEqual(['new_lead', 'handoff']);
    expect(r.name).toBe('Mi Webhook');
  });
  test('filtra eventTypes invalidos de events', () => {
    const r = buildWebhookRecord(UID, URL, { events: ['new_lead', 'invalid_event'] });
    expect(r.events).toContain('new_lead');
    expect(r.events).not.toContain('invalid_event');
  });
});

describe('saveWebhook', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveWebhook(undefined, { webhookId: 'x' })).rejects.toThrow('uid requerido');
  });
  test('lanza si record invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveWebhook(UID, null)).rejects.toThrow('record invalido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const record = buildWebhookRecord(UID, URL);
    const id = await saveWebhook(UID, record);
    expect(id).toBe(record.webhookId);
  });
  test('lanza si se supera el maximo', async () => {
    const stored = {};
    for (let i = 0; i < MAX_WEBHOOKS_PER_TENANT; i++) {
      stored['wh_' + i] = { webhookId: 'wh_' + i, status: 'active' };
    }
    __setFirestoreForTests(makeMockDb({ stored }));
    const record = buildWebhookRecord(UID, URL);
    await expect(saveWebhook(UID, record)).rejects.toThrow('maximo');
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const record = buildWebhookRecord(UID, URL);
    await expect(saveWebhook(UID, record)).rejects.toThrow('set error');
  });
});

describe('updateWebhookStatus', () => {
  test('lanza si uid undefined', async () => {
    await expect(updateWebhookStatus(undefined, 'wh1', 'active')).rejects.toThrow('uid requerido');
  });
  test('lanza si status invalido', async () => {
    await expect(updateWebhookStatus(UID, 'wh1', 'broken')).rejects.toThrow('status invalido');
  });
  test('actualiza sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateWebhookStatus(UID, 'wh1', 'inactive')).resolves.toBeUndefined();
  });
  test('actualiza con lastStatusCode', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateWebhookStatus(UID, 'wh1', 'failed', { lastStatusCode: 500 })).resolves.toBeUndefined();
  });
});

describe('getWebhooks', () => {
  test('lanza si uid undefined', async () => {
    await expect(getWebhooks(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna vacio si no hay webhooks', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getWebhooks(UID)).toEqual([]);
  });
  test('filtra por status', async () => {
    const stored = {
      'wh_1': { webhookId: 'wh_1', status: 'active', direction: 'outbound', events: ['new_lead'] },
      'wh_2': { webhookId: 'wh_2', status: 'inactive', direction: 'outbound', events: ['handoff'] },
    };
    __setFirestoreForTests(makeMockDb({ stored }));
    const r = await getWebhooks(UID, { status: 'active' });
    expect(r.length).toBe(1);
    expect(r[0].status).toBe('active');
  });
  test('filtra por event', async () => {
    const stored = {
      'wh_1': { webhookId: 'wh_1', status: 'active', events: ['new_lead', 'handoff'] },
      'wh_2': { webhookId: 'wh_2', status: 'active', events: ['broadcast_done'] },
    };
    __setFirestoreForTests(makeMockDb({ stored }));
    const r = await getWebhooks(UID, { event: 'handoff' });
    expect(r.length).toBe(1);
    expect(r[0].events).toContain('handoff');
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getWebhooks(UID)).toEqual([]);
  });
});

describe('logWebhookEvent', () => {
  test('lanza si uid undefined', async () => {
    await expect(logWebhookEvent(undefined, 'wh1', 'new_lead', {}, {})).rejects.toThrow('uid requerido');
  });
  test('guarda log sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const logId = await logWebhookEvent(UID, 'wh1', 'new_lead', { phone: '+54111' }, { success: true, statusCode: 200 });
    expect(logId).toMatch(/^whlog_/);
  });
  test('fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const logId = await logWebhookEvent(UID, 'wh1', 'test', {}, {});
    expect(logId).toBeNull();
  });
});

describe('buildWebhookPayload', () => {
  test('lanza si eventType invalido', () => {
    expect(() => buildWebhookPayload('invalid_event', {}, UID)).toThrow('eventType invalido');
  });
  test('construye payload correctamente', () => {
    const p = buildWebhookPayload('new_lead', { phone: '+54111' }, UID);
    expect(p.event).toBe('new_lead');
    expect(p.uid).toBe(UID);
    expect(p.version).toBe('1.0');
    expect(p.data.phone).toBe('+54111');
    expect(p.timestamp).toBeDefined();
  });
});

describe('getWebhooksForEvent / shouldRetry', () => {
  test('getWebhooksForEvent filtra activos con evento', () => {
    const webhooks = [
      { status: 'active', events: ['new_lead', 'handoff'] },
      { status: 'inactive', events: ['new_lead'] },
      { status: 'active', events: ['broadcast_done'] },
    ];
    const r = getWebhooksForEvent(webhooks, 'new_lead');
    expect(r.length).toBe(1);
    expect(r[0].events).toContain('new_lead');
  });
  test('getWebhooksForEvent retorna vacio si null', () => {
    expect(getWebhooksForEvent(null, 'new_lead')).toEqual([]);
  });
  test('shouldRetry true si intentos < max y no suspendido', () => {
    expect(shouldRetry({ retryAttempts: 1, status: 'failed' })).toBe(true);
  });
  test('shouldRetry false si intentos >= max', () => {
    expect(shouldRetry({ retryAttempts: MAX_RETRY_ATTEMPTS, status: 'failed' })).toBe(false);
  });
  test('shouldRetry false si suspendido', () => {
    expect(shouldRetry({ retryAttempts: 1, status: 'suspended' })).toBe(false);
  });
  test('shouldRetry false si null', () => {
    expect(shouldRetry(null)).toBe(false);
  });
});
