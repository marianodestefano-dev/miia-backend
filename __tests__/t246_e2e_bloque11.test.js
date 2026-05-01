'use strict';

/**
 * T246 - Tests E2E Bloque 11
 * Flujos combinando: webhook_manager, api_key_manager.
 * + Integracion con notification_builder, broadcast_engine.
 */

const {
  buildWebhookRecord, saveWebhook, updateWebhookStatus, getWebhooks,
  logWebhookEvent, buildWebhookPayload, getWebhooksForEvent, shouldRetry,
  signPayload, verifySignature, generateWebhookSecret,
  WEBHOOK_DIRECTIONS, WEBHOOK_STATUSES, WEBHOOK_EVENT_TYPES,
  MAX_WEBHOOKS_PER_TENANT, MAX_RETRY_ATTEMPTS,
  __setFirestoreForTests: setWebhookDb,
} = require('../core/webhook_manager');

const {
  createAPIKey, revokeAPIKey, rotateAPIKey, getAPIKeys, validateAPIKey,
  generateRawKey, hashKey, hasScope, buildKeyInfoText,
  KEY_SCOPES, MAX_KEYS_PER_TENANT, DEFAULT_EXPIRY_DAYS,
  __setFirestoreForTests: setAPIKeyDb,
} = require('../core/api_key_manager');

const {
  buildNotificationRecord, buildNotificationText,
  getPriorityForType,
} = require('../core/notification_builder');

const {
  buildBroadcastRecord, filterAudience, buildBatches, personalizeMessage,
  AUDIENCE_FILTERS,
} = require('../core/broadcast_engine');

const UID = 'testUid1234567890';
const URL = 'https://mi-sistema.com/webhook';

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

beforeEach(() => {
  setWebhookDb(null);
  setAPIKeyDb(null);
});
afterEach(() => {
  setWebhookDb(null);
  setAPIKeyDb(null);
});

// ─────────────────────────────────────────────
describe('E2E: Flujo webhooks', () => {
  test('constantes completas y congeladas', () => {
    expect(WEBHOOK_DIRECTIONS).toContain('inbound');
    expect(WEBHOOK_DIRECTIONS).toContain('outbound');
    expect(() => { WEBHOOK_DIRECTIONS.push('x'); }).toThrow();
    expect(WEBHOOK_EVENT_TYPES).toContain('new_lead');
    expect(WEBHOOK_EVENT_TYPES).toContain('payment_received');
    expect(() => { WEBHOOK_EVENT_TYPES.push('x'); }).toThrow();
  });

  test('flujo completo: crear, activar, disparar, loguear', async () => {
    setWebhookDb(makeMockDb());

    // 1. Crear webhook
    const record = buildWebhookRecord(UID, URL, { events: ['new_lead', 'handoff'], name: 'CRM Webhook' });
    expect(record.webhookId).toMatch(/^wh_/);
    expect(record.secret.length).toBe(64);

    const id = await saveWebhook(UID, record);
    expect(id).toBe(record.webhookId);

    // 2. Verificar que aparece en lista para evento
    const stored_wh = [{ ...record, status: 'active' }];
    const forEvent = getWebhooksForEvent(stored_wh, 'new_lead');
    expect(forEvent.length).toBe(1);

    // 3. Construir payload firmado
    const payload = buildWebhookPayload('new_lead', { phone: '+54111', text: 'Hola' }, UID);
    const sig = signPayload(payload, record.secret);
    expect(verifySignature(JSON.stringify(payload), signPayload(JSON.stringify(payload), record.secret), record.secret)).toBe(true);

    // 4. Loguear resultado
    const logId = await logWebhookEvent(UID, id, 'new_lead', payload, { success: true, statusCode: 200, durationMs: 45 });
    expect(logId).toMatch(/^whlog_/);
  });

  test('firma HMAC resiste tampering', () => {
    const secret = generateWebhookSecret();
    const original = JSON.stringify({ event: 'new_lead', data: { phone: '+54111' } });
    const tampered = JSON.stringify({ event: 'new_lead', data: { phone: '+54999_HACKED' } });
    const sig = signPayload(original, secret);
    expect(verifySignature(original, sig, secret)).toBe(true);
    expect(verifySignature(tampered, sig, secret)).toBe(false);
  });

  test('retry logic funciona correctamente', () => {
    expect(shouldRetry({ retryAttempts: 0, status: 'failed' })).toBe(true);
    expect(shouldRetry({ retryAttempts: 2, status: 'failed' })).toBe(true);
    expect(shouldRetry({ retryAttempts: MAX_RETRY_ATTEMPTS, status: 'failed' })).toBe(false);
    expect(shouldRetry({ retryAttempts: 1, status: 'suspended' })).toBe(false);
    expect(shouldRetry(null)).toBe(false);
  });

  test('filtros de getWebhooks funcionan por direction y event', async () => {
    const stored = {
      'wh_1': { webhookId: 'wh_1', status: 'active', direction: 'outbound', events: ['new_lead'] },
      'wh_2': { webhookId: 'wh_2', status: 'active', direction: 'inbound', events: ['form_submitted'] },
      'wh_3': { webhookId: 'wh_3', status: 'inactive', direction: 'outbound', events: ['new_lead'] },
    };
    setWebhookDb(makeMockDb({ stored }));
    const outbound = await getWebhooks(UID, { direction: 'outbound', status: 'active' });
    expect(outbound.length).toBe(1);
    const forLead = await getWebhooks(UID, { event: 'new_lead' });
    expect(forLead.length).toBe(2);
  });

  test('maximo de webhooks por tenant bloqueado', async () => {
    const stored = {};
    for (let i = 0; i < MAX_WEBHOOKS_PER_TENANT; i++) {
      stored['wh_' + i] = { webhookId: 'wh_' + i, status: 'active' };
    }
    setWebhookDb(makeMockDb({ stored }));
    const record = buildWebhookRecord(UID, URL);
    await expect(saveWebhook(UID, record)).rejects.toThrow('maximo');
  });
});

// ─────────────────────────────────────────────
describe('E2E: Flujo API keys', () => {
  test('constantes de scopes completas y congeladas', () => {
    expect(KEY_SCOPES).toContain('read_conversations');
    expect(KEY_SCOPES).toContain('full_access');
    expect(KEY_SCOPES).toContain('webhook_manage');
    expect(() => { KEY_SCOPES.push('x'); }).toThrow();
  });

  test('flujo completo: crear, validar, revocar', async () => {
    setAPIKeyDb(makeMockDb());

    const { rawKey, record } = await createAPIKey(UID, {
      scopes: ['read_conversations', 'manage_catalog'],
      name: 'Integración CRM',
    });
    expect(rawKey).toMatch(/^miia_/);
    expect(record.status).toBe('active');

    // Validar key valida
    const validation = await validateAPIKey(UID, rawKey);
    expect(validation.valid).toBe(true);
    expect(validation.scopes).toContain('read_conversations');

    // Revocar key
    await revokeAPIKey(UID, record.keyId);
  });

  test('hasScope full_access es bypass universal', () => {
    const record = { scopes: ['full_access'] };
    KEY_SCOPES.forEach(scope => {
      expect(hasScope(record, scope)).toBe(true);
    });
  });

  test('hasScope granular funciona por scope', () => {
    const record = { scopes: ['read_conversations', 'manage_catalog'] };
    expect(hasScope(record, 'read_conversations')).toBe(true);
    expect(hasScope(record, 'send_broadcast')).toBe(false);
    expect(hasScope(record, 'admin_global')).toBe(false);
  });

  test('rotacion de key produce nueva key activa', async () => {
    setAPIKeyDb(makeMockDb({ stored: {
      'key1': { keyId: 'key1', status: 'active', scopes: ['read_conversations'], name: 'Key Original' }
    }}));
    const { rawKey: newRaw, record: newRecord } = await rotateAPIKey(UID, 'key1');
    expect(newRaw).toMatch(/^miia_/);
    expect(newRecord.status).toBe('active');
  });

  test('keys revocadas no validan', async () => {
    setAPIKeyDb(makeMockDb());
    const { rawKey, record } = await createAPIKey(UID, { scopes: ['read_conversations'] });
    await revokeAPIKey(UID, record.keyId);

    // Actualizar mock para simular key revocada en Firestore
    const stored = { [record.keyId]: { ...record, status: 'revoked', revokedAt: new Date().toISOString() } };
    setAPIKeyDb(makeMockDb({ stored }));
    const v = await validateAPIKey(UID, rawKey);
    expect(v.valid).toBe(false);
    expect(v.reason).toContain('revoked');
  });

  test('buildKeyInfoText genera texto WhatsApp correcto', () => {
    const rawKey = generateRawKey();
    const { buildAPIKeyRecord } = require('../core/api_key_manager');
    const record = buildAPIKeyRecord(UID, rawKey, { name: 'Mi Clave', scopes: ['read_conversations', 'send_broadcast'] });
    const text = buildKeyInfoText(record);
    expect(text).toContain('Mi Clave');
    expect(text).toContain('read_conversations');
    expect(text).toContain('send_broadcast');
  });
});

// ─────────────────────────────────────────────
describe('E2E: Integracion webhook + API key + notificaciones', () => {
  test('nueva API key activa genera notificacion informativa', () => {
    // API key creada → notif al owner (no es evento critico, es normal)
    const notif = buildNotificationRecord(UID, 'system_alert', {
      component: 'api_keys', message: 'Nueva API key creada: Integracion CRM', severity: 'info',
    });
    const text = buildNotificationText(notif);
    expect(text).toContain('api_keys');
    expect(text).toContain('Integracion CRM');
  });

  test('webhook recibe evento de broadcast y genera payload correcto', () => {
    const webhooks = [
      { status: 'active', events: ['broadcast_done', 'new_lead'] },
      { status: 'active', events: ['handoff'] },
    ];

    const broadcast_done_webhooks = getWebhooksForEvent(webhooks, 'broadcast_done');
    expect(broadcast_done_webhooks.length).toBe(1);

    const payload = buildWebhookPayload('broadcast_done', { sent: 50, failed: 2 }, UID);
    expect(payload.event).toBe('broadcast_done');
    expect(payload.data.sent).toBe(50);
  });

  test('API key con scope send_broadcast permite operacion de broadcast', () => {
    const keyRecord = { scopes: ['send_broadcast', 'read_contacts'] };
    expect(hasScope(keyRecord, 'send_broadcast')).toBe(true);
    expect(hasScope(keyRecord, 'manage_catalog')).toBe(false);

    // Simular intento de operacion con scope correcto
    const contacts = [
      { phone: '+541', name: 'Juan', type: 'lead', tags: [] },
      { phone: '+542', name: 'Ana', type: 'client', tags: [] },
    ];
    const audience = filterAudience(contacts, 'all');
    const batches = buildBatches(audience, 50);
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(2);
  });

  test('flujo seguro: validar API key + verificar scope + ejecutar webhook', () => {
    // 1. API key con scope webhook_manage
    const rawKey = generateRawKey();
    const { buildAPIKeyRecord } = require('../core/api_key_manager');
    const keyRecord = buildAPIKeyRecord(UID, rawKey, { scopes: ['webhook_manage'] });

    // 2. Verificar que tiene el scope correcto
    expect(hasScope(keyRecord, 'webhook_manage')).toBe(true);
    expect(hasScope(keyRecord, 'send_broadcast')).toBe(false);

    // 3. Construir y firmar payload del webhook
    const webhookSecret = generateWebhookSecret();
    const payload = buildWebhookPayload('new_lead', { phone: '+54111' }, UID);
    const sig = signPayload(JSON.stringify(payload), webhookSecret);

    // 4. Verificar firma en el lado receptor
    const isValid = verifySignature(JSON.stringify(payload), sig, webhookSecret);
    expect(isValid).toBe(true);
  });
});
