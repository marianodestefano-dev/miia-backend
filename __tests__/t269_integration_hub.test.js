'use strict';

// T269 integration_hub — suite completa
const {
  buildIntegrationRecord,
  buildWebhookPayload,
  validateWebhookPayload,
  filterEventsForIntegration,
  buildEventRecord,
  saveIntegration,
  getIntegration,
  updateIntegrationStatus,
  listIntegrations,
  saveEvent,
  listPendingEvents,
  buildIntegrationSummaryText,
  INTEGRATION_TYPES,
  EVENT_TYPES,
  INTEGRATION_STATUSES,
  WEBHOOK_METHODS,
  MAX_PAYLOAD_SIZE_KB,
  MAX_RETRY_ATTEMPTS,
  MAX_INTEGRATIONS_PER_OWNER,
  WEBHOOK_TIMEOUT_MS,
  __setFirestoreForTests: setDb,
} = require('../core/integration_hub');

const UID = 'hub269Uid';
const WEBHOOK_URL = 'https://example.com/webhook';

function makeMockDb({ stored = {}, evtStored = {}, throwGet = false, throwSet = false } = {}) {
  const db_stored = { ...stored };
  const evt_stored = { ...evtStored };
  return {
    collection: () => ({
      doc: () => ({
        collection: (subCol) => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              const target = subCol === 'integration_events' ? evt_stored : db_stored;
              target[id] = opts && opts.merge ? { ...(target[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              const target = subCol === 'integration_events' ? evt_stored : db_stored;
              return { exists: !!target[id], data: () => target[id] };
            },
          }),
          where: (field, op, val) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const target = subCol === 'integration_events' ? evt_stored : db_stored;
              const entries = Object.values(target).filter(d => d && d[field] === val);
              return { empty: entries.length === 0, forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            const target = subCol === 'integration_events' ? evt_stored : db_stored;
            return { empty: Object.keys(target).length === 0, forEach: fn => Object.values(target).forEach(d => fn({ data: () => d })) };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => setDb(null));
afterEach(() => setDb(null));

// ─── CONSTANTES ──────────────────────────────────────────────────────────────
describe('integration_hub — constantes', () => {
  test('INTEGRATION_TYPES incluye tipos clave', () => {
    ['google_calendar', 'mercadopago', 'stripe', 'webhook', 'shopify', 'zapier'].forEach(t =>
      expect(INTEGRATION_TYPES).toContain(t)
    );
  });
  test('EVENT_TYPES incluye eventos clave', () => {
    ['payment_confirmed', 'appointment_booked', 'lead_created', 'coupon_redeemed', 'custom'].forEach(e =>
      expect(EVENT_TYPES).toContain(e)
    );
  });
  test('INTEGRATION_STATUSES incluye active, inactive, error', () => {
    ['active', 'inactive', 'error', 'pending_auth'].forEach(s =>
      expect(INTEGRATION_STATUSES).toContain(s)
    );
  });
  test('WEBHOOK_METHODS incluye POST y GET', () => {
    expect(WEBHOOK_METHODS).toContain('POST');
    expect(WEBHOOK_METHODS).toContain('GET');
  });
  test('MAX_PAYLOAD_SIZE_KB es 64', () => {
    expect(MAX_PAYLOAD_SIZE_KB).toBe(64);
  });
  test('MAX_RETRY_ATTEMPTS es 3', () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(3);
  });
  test('WEBHOOK_TIMEOUT_MS es 30000', () => {
    expect(WEBHOOK_TIMEOUT_MS).toBe(30000);
  });
  test('MAX_INTEGRATIONS_PER_OWNER es 20', () => {
    expect(MAX_INTEGRATIONS_PER_OWNER).toBe(20);
  });
});

// ─── buildIntegrationRecord ───────────────────────────────────────────────────
describe('buildIntegrationRecord', () => {
  test('defaults correctos', () => {
    const integ = buildIntegrationRecord(UID, { type: 'mercadopago', name: 'MercadoPago Prod' });
    expect(integ.uid).toBe(UID);
    expect(integ.type).toBe('mercadopago');
    expect(integ.name).toBe('MercadoPago Prod');
    expect(integ.status).toBe('inactive');
    expect(integ.webhookMethod).toBe('POST');
    expect(integ.subscribedEvents).toEqual([]);
    expect(integ.config).toEqual({});
    expect(integ.retryAttempts).toBe(0);
  });
  test('type invalido cae a custom', () => {
    const integ = buildIntegrationRecord(UID, { type: 'fake_integration' });
    expect(integ.type).toBe('custom');
  });
  test('status invalido cae a inactive', () => {
    const integ = buildIntegrationRecord(UID, { status: 'borrado' });
    expect(integ.status).toBe('inactive');
  });
  test('webhookMethod invalido cae a POST', () => {
    const integ = buildIntegrationRecord(UID, { webhookMethod: 'CONNECT' });
    expect(integ.webhookMethod).toBe('POST');
  });
  test('subscribedEvents filtra invalidos', () => {
    const integ = buildIntegrationRecord(UID, {
      subscribedEvents: ['payment_confirmed', 'evento_fake', 'lead_created'],
    });
    expect(integ.subscribedEvents).toEqual(['payment_confirmed', 'lead_created']);
  });
  test('config se copia', () => {
    const integ = buildIntegrationRecord(UID, { config: { apiKey: 'abc123', mode: 'live' } });
    expect(integ.config.apiKey).toBe('abc123');
    expect(integ.config.mode).toBe('live');
  });
  test('integrationId se puede forzar', () => {
    const integ = buildIntegrationRecord(UID, { integrationId: 'integ_custom_001' });
    expect(integ.integrationId).toBe('integ_custom_001');
  });
  test('webhookUrl y headers se guardan', () => {
    const integ = buildIntegrationRecord(UID, {
      webhookUrl: WEBHOOK_URL,
      webhookHeaders: { 'Authorization': 'Bearer token123' },
    });
    expect(integ.webhookUrl).toBe(WEBHOOK_URL);
    expect(integ.webhookHeaders['Authorization']).toBe('Bearer token123');
  });
});

// ─── buildWebhookPayload ──────────────────────────────────────────────────────
describe('buildWebhookPayload', () => {
  test('construye payload correctamente', () => {
    const p = buildWebhookPayload('payment_confirmed', { amount: 1000, currency: 'ARS' }, { uid: UID });
    expect(p.event).toBe('payment_confirmed');
    expect(p.version).toBe('1.0');
    expect(p.source).toBe('miia');
    expect(p.uid).toBe(UID);
    expect(p.payload.amount).toBe(1000);
    expect(p.timestamp).toBeDefined();
  });
  test('eventType invalido lanza error', () => {
    expect(() => buildWebhookPayload('evento_fake', {})).toThrow('eventType invalido');
  });
  test('data no objeto se normaliza a objeto vacio', () => {
    const p = buildWebhookPayload('lead_created', null);
    expect(p.payload).toEqual({});
  });
  test('metadata se guarda', () => {
    const p = buildWebhookPayload('coupon_redeemed', {}, { metadata: { source: 'whatsapp' } });
    expect(p.metadata.source).toBe('whatsapp');
  });
});

// ─── validateWebhookPayload ───────────────────────────────────────────────────
describe('validateWebhookPayload', () => {
  test('payload valido retorna valid=true', () => {
    const p = buildWebhookPayload('lead_created', { phone: '+5491155554444' }, { uid: UID });
    const r = validateWebhookPayload(p);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
  test('sin event es invalido', () => {
    const r = validateWebhookPayload({ timestamp: Date.now(), payload: {} });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('event'))).toBe(true);
  });
  test('event invalido es invalido', () => {
    const r = validateWebhookPayload({ event: 'fake_event', timestamp: Date.now() });
    expect(r.valid).toBe(false);
  });
  test('sin timestamp es invalido', () => {
    const r = validateWebhookPayload({ event: 'lead_created' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('timestamp'))).toBe(true);
  });
  test('payload null es invalido', () => {
    const r = validateWebhookPayload(null);
    expect(r.valid).toBe(false);
  });
  test('payload muy grande es invalido', () => {
    const bigPayload = buildWebhookPayload('custom', { data: 'X'.repeat(MAX_PAYLOAD_SIZE_KB * 1024 + 1) });
    const r = validateWebhookPayload(bigPayload);
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('MAX'))).toBe(true);
  });
});

// ─── filterEventsForIntegration ───────────────────────────────────────────────
describe('filterEventsForIntegration', () => {
  const events = [
    { event: 'payment_confirmed', data: {} },
    { event: 'lead_created', data: {} },
    { event: 'appointment_booked', data: {} },
  ];
  test('sin subscribedEvents retorna todos', () => {
    const integ = buildIntegrationRecord(UID, { type: 'webhook', subscribedEvents: [] });
    const r = filterEventsForIntegration(integ, events);
    expect(r.length).toBe(3);
  });
  test('con subscribedEvents filtra correctamente', () => {
    const integ = buildIntegrationRecord(UID, {
      type: 'webhook',
      subscribedEvents: ['payment_confirmed', 'lead_created'],
    });
    const r = filterEventsForIntegration(integ, events);
    expect(r.length).toBe(2);
    expect(r.every(e => ['payment_confirmed', 'lead_created'].includes(e.event))).toBe(true);
  });
  test('events null retorna array vacio', () => {
    const integ = buildIntegrationRecord(UID, { type: 'webhook' });
    expect(filterEventsForIntegration(integ, null)).toEqual([]);
  });
});

// ─── buildEventRecord ─────────────────────────────────────────────────────────
describe('buildEventRecord', () => {
  test('construye evento correctamente', () => {
    const e = buildEventRecord(UID, 'payment_confirmed', { amount: 500 }, { integrationIds: ['integ_001'] });
    expect(e.uid).toBe(UID);
    expect(e.type).toBe('payment_confirmed');
    expect(e.data.amount).toBe(500);
    expect(e.processed).toBe(false);
    expect(e.dispatched).toBe(false);
    expect(e.integrationIds).toEqual(['integ_001']);
  });
  test('eventType invalido lanza error', () => {
    expect(() => buildEventRecord(UID, 'evento_fake', {})).toThrow('eventType invalido');
  });
  test('data no objeto cae a objeto vacio', () => {
    const e = buildEventRecord(UID, 'custom', null);
    expect(e.data).toEqual({});
  });
});

// ─── saveIntegration + getIntegration ─────────────────────────────────────────
describe('saveIntegration + getIntegration', () => {
  test('round-trip exitoso', async () => {
    const db = makeMockDb();
    setDb(db);
    const integ = buildIntegrationRecord(UID, {
      type: 'mercadopago', name: 'MP Produccion', status: 'active',
      config: { publicKey: 'pk_123' }, webhookUrl: WEBHOOK_URL,
    });
    const savedId = await saveIntegration(UID, integ);
    expect(savedId).toBe(integ.integrationId);
    const loaded = await getIntegration(UID, integ.integrationId);
    expect(loaded.type).toBe('mercadopago');
    expect(loaded.config.publicKey).toBe('pk_123');
    expect(loaded.webhookUrl).toBe(WEBHOOK_URL);
  });
  test('getIntegration retorna null si no existe', async () => {
    setDb(makeMockDb());
    const loaded = await getIntegration(UID, 'integ_no_existe');
    expect(loaded).toBeNull();
  });
  test('saveIntegration con throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    const integ = buildIntegrationRecord(UID, { type: 'webhook' });
    await expect(saveIntegration(UID, integ)).rejects.toThrow('set error');
  });
  test('getIntegration con throwGet retorna null', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const loaded = await getIntegration(UID, 'integ_001');
    expect(loaded).toBeNull();
  });
});

// ─── updateIntegrationStatus ──────────────────────────────────────────────────
describe('updateIntegrationStatus', () => {
  test('actualiza a active', async () => {
    setDb(makeMockDb());
    const id = await updateIntegrationStatus(UID, 'integ_001', 'active');
    expect(id).toBe('integ_001');
  });
  test('error setea lastErrorAt', async () => {
    const db = makeMockDb();
    setDb(db);
    const integ = buildIntegrationRecord(UID, { type: 'webhook', integrationId: 'integ_001' });
    await saveIntegration(UID, integ);
    await updateIntegrationStatus(UID, 'integ_001', 'error', { lastError: 'Connection timeout' });
    const loaded = await getIntegration(UID, 'integ_001');
    expect(loaded.status).toBe('error');
    expect(loaded.lastErrorAt).toBeDefined();
    expect(loaded.lastError).toBe('Connection timeout');
  });
  test('status invalido lanza error', async () => {
    setDb(makeMockDb());
    await expect(updateIntegrationStatus(UID, 'integ_001', 'broken')).rejects.toThrow('status invalido');
  });
  test('throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    await expect(updateIntegrationStatus(UID, 'integ_001', 'inactive')).rejects.toThrow('set error');
  });
});

// ─── listIntegrations ─────────────────────────────────────────────────────────
describe('listIntegrations', () => {
  test('retorna todas las integraciones', async () => {
    const i1 = buildIntegrationRecord(UID, { type: 'stripe', status: 'active' });
    const i2 = buildIntegrationRecord(UID, { type: 'mercadopago', status: 'inactive' });
    i2.integrationId = i2.integrationId + '_2';
    setDb(makeMockDb({ stored: { [i1.integrationId]: i1, [i2.integrationId]: i2 } }));
    const r = await listIntegrations(UID);
    expect(r.length).toBe(2);
  });
  test('filtra por status', async () => {
    const i1 = buildIntegrationRecord(UID, { type: 'stripe', status: 'active' });
    const i2 = buildIntegrationRecord(UID, { type: 'mercadopago', status: 'inactive' });
    i2.integrationId = i2.integrationId + '_2';
    setDb(makeMockDb({ stored: { [i1.integrationId]: i1, [i2.integrationId]: i2 } }));
    const actives = await listIntegrations(UID, { status: 'active' });
    expect(actives.every(i => i.status === 'active')).toBe(true);
  });
  test('throwGet retorna array vacio', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const r = await listIntegrations(UID);
    expect(r).toEqual([]);
  });
});

// ─── saveEvent + listPendingEvents ────────────────────────────────────────────
describe('saveEvent + listPendingEvents', () => {
  test('round-trip exitoso', async () => {
    const db = makeMockDb();
    setDb(db);
    const e = buildEventRecord(UID, 'lead_created', { phone: '+5491155554444' });
    const savedId = await saveEvent(UID, e);
    expect(savedId).toBe(e.eventId);
    const pending = await listPendingEvents(UID);
    expect(pending.length).toBe(1);
    expect(pending[0].type).toBe('lead_created');
  });
  test('filtra por tipo', async () => {
    const e1 = buildEventRecord(UID, 'lead_created', {});
    const e2 = buildEventRecord(UID, 'payment_confirmed', {});
    e2.eventId = e2.eventId + '_2';
    setDb(makeMockDb({ evtStored: { [e1.eventId]: e1, [e2.eventId]: e2 } }));
    const payments = await listPendingEvents(UID, { type: 'payment_confirmed' });
    expect(payments.every(e => e.type === 'payment_confirmed')).toBe(true);
  });
  test('saveEvent con throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    const e = buildEventRecord(UID, 'custom', {});
    await expect(saveEvent(UID, e)).rejects.toThrow('set error');
  });
  test('throwGet retorna array vacio', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const pending = await listPendingEvents(UID);
    expect(pending).toEqual([]);
  });
});

// ─── buildIntegrationSummaryText ──────────────────────────────────────────────
describe('buildIntegrationSummaryText', () => {
  test('null retorna mensaje no encontrado', () => {
    expect(buildIntegrationSummaryText(null)).toContain('no encontrada');
  });
  test('incluye nombre y tipo', () => {
    const integ = buildIntegrationRecord(UID, { type: 'stripe', name: 'Stripe Live', status: 'active' });
    const text = buildIntegrationSummaryText(integ);
    expect(text).toContain('Stripe Live');
    expect(text).toContain('stripe');
    expect(text).toContain('active');
  });
  test('incluye url webhook si existe', () => {
    const integ = buildIntegrationRecord(UID, { type: 'webhook', name: 'My Hook', webhookUrl: WEBHOOK_URL });
    const text = buildIntegrationSummaryText(integ);
    expect(text).toContain('Webhook');
    expect(text).toContain('example.com');
  });
  test('incluye eventos suscritos', () => {
    const integ = buildIntegrationRecord(UID, {
      type: 'zapier',
      subscribedEvents: ['payment_confirmed', 'lead_created', 'appointment_booked', 'coupon_redeemed'],
    });
    const text = buildIntegrationSummaryText(integ);
    expect(text).toContain('Eventos');
    expect(text).toContain('+1 mas');
  });
});
