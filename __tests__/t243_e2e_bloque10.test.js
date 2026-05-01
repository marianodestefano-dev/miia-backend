'use strict';

/**
 * T243 - Tests E2E Bloque 10
 * Flujos combinando: media_handler, notification_builder, broadcast_engine.
 * + Integracion con catalog_manager y conversation_search_engine.
 */

const {
  validateMediaMessage, buildMediaRef, saveMediaRef, getMediaRef,
  markMediaProcessed, isMediaExpired, buildMediaContextText, getMediaCategory,
  SUPPORTED_IMAGE_TYPES, MEDIA_CATEGORIES, MAX_IMAGE_SIZE_BYTES,
  __setFirestoreForTests: setMediaDb,
} = require('../core/media_handler');

const {
  buildNotificationRecord, saveNotification, updateNotificationStatus,
  getRecentNotifications, hasSentRecentNotification, buildNotificationText,
  getPriorityForType, isValidType, isValidPriority,
  NOTIFICATION_TYPES, NOTIFICATION_PRIORITIES,
  __setFirestoreForTests: setNotifDb,
} = require('../core/notification_builder');

const {
  buildBroadcastRecord, saveBroadcast, updateBroadcastStatus,
  getBroadcasts, filterAudience, buildBatches, personalizeMessage,
  buildBroadcastSummaryText, isValidStatus, isValidAudienceFilter,
  BROADCAST_STATUSES, AUDIENCE_FILTERS, MAX_BATCH_SIZE,
  __setFirestoreForTests: setBroadcastDb,
} = require('../core/broadcast_engine');

const {
  buildCatalogSummaryText, searchCatalogByText, buildItemDetailText,
  formatPriceText,
} = require('../core/catalog_manager');

const {
  searchContacts, searchMessages,
  computeRelevance, normalizeText,
} = require('../core/conversation_search_engine');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const IMG_MSG = { mimeType: 'image/jpeg', sizeBytes: 1024 * 100, fileName: 'foto.jpg', caption: 'Mi producto' };
const DOC_MSG = { mimeType: 'application/pdf', sizeBytes: 1024 * 200, fileName: 'catalogo.pdf' };

function makeMockDb({ stored = {}, throwGet = false, throwSet = false, whereResults = [] } = {}) {
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
            get: async () => ({ exists: !!db_stored[id], data: () => db_stored[id] }),
            ref: { delete: async () => { delete db_stored[id]; } },
          }),
          where: () => ({
            get: async () => ({
              forEach: fn => whereResults.forEach(data => fn({ data: () => data })),
            }),
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return {
              forEach: fn => Object.entries(db_stored).forEach(([id, data]) => fn({
                data: () => data,
                ref: { delete: async () => { delete db_stored[id]; } },
              })),
            };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => {
  setMediaDb(null);
  setNotifDb(null);
  setBroadcastDb(null);
});
afterEach(() => {
  setMediaDb(null);
  setNotifDb(null);
  setBroadcastDb(null);
});

// ─────────────────────────────────────────────
describe('E2E: Flujo media WhatsApp', () => {
  test('categorias de media completas y congeladas', () => {
    expect(MEDIA_CATEGORIES).toContain('image');
    expect(MEDIA_CATEGORIES).toContain('document');
    expect(MEDIA_CATEGORIES).toContain('audio');
    expect(() => { MEDIA_CATEGORIES.push('x'); }).toThrow();
  });

  test('clasificacion correcta por mimeType', () => {
    expect(getMediaCategory('image/jpeg')).toBe('image');
    expect(getMediaCategory('audio/ogg')).toBe('audio');
    expect(getMediaCategory('application/pdf')).toBe('document');
    expect(getMediaCategory(null)).toBeNull();
    expect(getMediaCategory('application/unknown')).toBeNull();
  });

  test('validacion de limites de tamano', () => {
    expect(() => validateMediaMessage({ mimeType: 'image/jpeg', sizeBytes: MAX_IMAGE_SIZE_BYTES + 1 }))
      .toThrow('demasiado grande');
    expect(() => validateMediaMessage({ mimeType: 'image/jpeg', sizeBytes: MAX_IMAGE_SIZE_BYTES }))
      .not.toThrow();
  });

  test('flujo completo: crear, guardar y marcar procesado', async () => {
    setMediaDb(makeMockDb());
    const ref = buildMediaRef(UID, PHONE, IMG_MSG);
    expect(ref.refId).toMatch(/^media_/);
    expect(ref.category).toBe('image');
    expect(ref.processed).toBe(false);

    const refId = await saveMediaRef(UID, ref);
    expect(refId).toBe(ref.refId);

    await markMediaProcessed(UID, refId, '/storage/imgs/' + refId + '.jpg');
  });

  test('expiry: media expirado detectado correctamente', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 100000).toISOString();
    expect(isMediaExpired({ expiresAt: past })).toBe(true);
    expect(isMediaExpired({ expiresAt: future })).toBe(false);
    expect(isMediaExpired(null)).toBe(false);
  });

  test('buildMediaContextText genera texto para IA', () => {
    const ref = buildMediaRef(UID, PHONE, IMG_MSG);
    const text = buildMediaContextText(ref);
    expect(text).toContain('image');
    expect(text).toContain('foto.jpg');
    expect(text).toContain('Mi producto');
  });

  test('documento PDF construye ref correctamente', () => {
    const ref = buildMediaRef(UID, PHONE, DOC_MSG, { context: 'catalog' });
    expect(ref.category).toBe('document');
    expect(ref.context).toBe('catalog');
    expect(ref.mimeType).toBe('application/pdf');
  });
});

// ─────────────────────────────────────────────
describe('E2E: Flujo sistema de notificaciones', () => {
  test('tipos de notificacion cubren los casos criticos', () => {
    ['spam_detected', 'otp_requested', 'system_alert', 'recovery_initiated'].forEach(t => {
      expect(NOTIFICATION_TYPES).toContain(t);
    });
  });

  test('prioridades asignadas correctamente segun tipo', () => {
    expect(getPriorityForType('otp_requested')).toBe('critical');
    expect(getPriorityForType('recovery_initiated')).toBe('critical');
    expect(getPriorityForType('new_lead')).toBe('high');
    expect(getPriorityForType('daily_summary')).toBe('low');
    expect(getPriorityForType('catalog_updated')).toBe('normal');
  });

  test('flujo completo: crear, guardar y actualizar notificacion', async () => {
    setNotifDb(makeMockDb());
    const record = buildNotificationRecord(UID, 'new_lead', { phone: PHONE, text: 'Hola' });
    const id = await saveNotification(UID, record);
    expect(id).toBe(record.notifId);

    await updateNotificationStatus(UID, id, 'sent');
  });

  test('texto de notificaciones es informativo', () => {
    const cases = [
      { type: 'new_lead', data: { name: 'Juan', text: 'Quiero info' }, expects: ['Juan'] },
      { type: 'spam_detected', data: { phone: PHONE, severity: 'high' }, expects: ['SPAM', 'high'] },
      { type: 'daily_summary', data: { messages: 100, leads: 5 }, expects: ['100', '5'] },
      { type: 'system_alert', data: { component: 'gemini', message: 'lento', severity: 'warning' }, expects: ['gemini', 'lento'] },
      { type: 'broadcast_done', data: { sent: 30 }, expects: ['30'] },
      { type: 'low_stock', data: { itemName: 'Empanada', stock: 2 }, expects: ['Empanada', '2'] },
    ];
    cases.forEach(({ type, data, expects }) => {
      const r = buildNotificationRecord(UID, type, data);
      const text = buildNotificationText(r);
      expects.forEach(e => expect(text).toContain(e));
    });
  });

  test('supresion por ventana temporal funciona', async () => {
    const stored = {
      'n1': { type: 'spam_detected', status: 'sent', sentAt: new Date().toISOString(), createdAt: new Date().toISOString() },
    };
    setNotifDb(makeMockDb({ stored }));
    const isDuplicate = await hasSentRecentNotification(UID, 'spam_detected', 60000);
    expect(isDuplicate).toBe(true);
  });

  test('notificacion critica no bloqueada por misma ventana si tipo diferente', async () => {
    const stored = {
      'n1': { type: 'spam_detected', status: 'sent', sentAt: new Date().toISOString(), createdAt: new Date().toISOString() },
    };
    setNotifDb(makeMockDb({ stored }));
    const isDuplicate = await hasSentRecentNotification(UID, 'otp_requested', 60000);
    expect(isDuplicate).toBe(false);
  });
});

// ─────────────────────────────────────────────
describe('E2E: Flujo broadcast campanas', () => {
  test('estados y filtros de audiencia completos y congelados', () => {
    expect(BROADCAST_STATUSES).toContain('draft');
    expect(BROADCAST_STATUSES).toContain('completed');
    expect(() => { BROADCAST_STATUSES.push('x'); }).toThrow();
    expect(AUDIENCE_FILTERS).toContain('leads');
    expect(AUDIENCE_FILTERS).toContain('tagged');
    expect(() => { AUDIENCE_FILTERS.push('x'); }).toThrow();
  });

  test('flujo completo: draft → scheduled → running → completed', async () => {
    setBroadcastDb(makeMockDb());
    const record = buildBroadcastRecord(UID, 'Hola {nombre}, oferta especial!', {
      audienceFilter: 'leads', name: 'Campaña Test',
    });
    const id = await saveBroadcast(UID, record);
    expect(id).toBe(record.broadcastId);

    await updateBroadcastStatus(UID, id, 'scheduled');
    await updateBroadcastStatus(UID, id, 'running');
    await updateBroadcastStatus(UID, id, 'completed', {
      stats: { total: 20, sent: 19, failed: 1, skipped: 0 },
    });
  });

  test('filterAudience todos los filtros funcionan', () => {
    const contacts = [
      { phone: '+541', name: 'Juan', type: 'lead', tags: ['vip'], lastMessageAt: '2024-01-01T00:00:00Z' },
      { phone: '+542', name: 'Ana', type: 'client', tags: ['premium'], lastMessageAt: new Date().toISOString() },
      { phone: '+543', name: 'Carlos', contactType: 'lead', tags: ['vip'] },
    ];
    expect(filterAudience(contacts, 'all')).toHaveLength(3);
    expect(filterAudience(contacts, 'leads')).toHaveLength(2);
    expect(filterAudience(contacts, 'clients')).toHaveLength(1);
    expect(filterAudience(contacts, 'tagged', ['vip'])).toHaveLength(2);
    const inactive = filterAudience(contacts, 'inactive');
    expect(inactive.some(c => c.name === 'Juan')).toBe(true);
  });

  test('buildBatches divide correctamente', () => {
    const contacts = Array.from({ length: 130 }, (_, i) => ({ phone: '+5411' + i }));
    const batches = buildBatches(contacts, MAX_BATCH_SIZE);
    expect(batches.length).toBe(3);
    expect(batches[0].length).toBe(50);
    expect(batches[2].length).toBe(30);
  });

  test('personalizeMessage con todos los placeholders', () => {
    const template = 'Hola {nombre}, tu numero {phone}, negocio {negocio}';
    const contact = { name: 'Ana', phone: '+54111', businessName: 'Cafetería' };
    const msg = personalizeMessage(template, contact);
    expect(msg).toContain('Ana');
    expect(msg).toContain('+54111');
    expect(msg).toContain('Cafetería');
  });

  test('resumen de broadcast con estadisticas', () => {
    const record = buildBroadcastRecord(UID, 'Oferta!', { name: 'Lunes Promo' });
    const summary = buildBroadcastSummaryText({
      ...record, status: 'completed',
      stats: { total: 100, sent: 95, failed: 3, skipped: 2 },
    });
    expect(summary).toContain('Lunes Promo');
    expect(summary).toContain('95');
    expect(summary).toContain('3');
  });
});

// ─────────────────────────────────────────────
describe('E2E: Integracion media + notificaciones + catalogo', () => {
  test('imagen de producto activa notificacion de actualizacion catalogo', async () => {
    setMediaDb(makeMockDb());
    setNotifDb(makeMockDb());

    // 1. Recibir imagen de producto via WhatsApp
    const mediaMsg = { mimeType: 'image/jpeg', sizeBytes: 500000, fileName: 'empanadas.jpg', caption: 'Nuestras empanadas' };
    const ref = buildMediaRef(UID, PHONE, mediaMsg, { context: 'catalog' });
    await saveMediaRef(UID, ref);

    // 2. Generar notificacion al owner
    const notif = buildNotificationRecord(UID, 'catalog_updated', {
      itemName: 'Empanadas', mediaRefId: ref.refId,
    });
    const notifId = await saveNotification(UID, notif);
    expect(notifId).toBeDefined();

    // 3. Verificar texto de notificacion
    const text = buildNotificationText(notif);
    expect(text).toContain('Empanadas');
  });

  test('busqueda de catalogo + broadcast a clientes encontrados', () => {
    const items = [
      { name: 'Pizza Muzzarella', status: 'active', price: 1200, currency: 'ARS', tags: ['pizza'] },
      { name: 'Empanadas (6u)', status: 'active', price: 800, currency: 'ARS', tags: ['empanada'] },
    ];
    const contacts = [
      { phone: '+541', name: 'Juan', type: 'lead', tags: ['pizza_lover'] },
      { phone: '+542', name: 'Ana', type: 'client', tags: ['empanadas'] },
    ];

    // Buscar items del catalogo
    const foundItems = searchCatalogByText(items, 'pizza');
    expect(foundItems.length).toBe(1);

    // Construir template de broadcast con el item encontrado
    const item = foundItems[0];
    const priceText = formatPriceText(item);
    const template = 'Hola {nombre}! Hoy tenemos ' + item.name + ' a ' + priceText + '. ¿Te interesa?';

    // Personalizar para cada contacto
    const messages = filterAudience(contacts, 'all').map(c => personalizeMessage(template, c));
    expect(messages.length).toBe(2);
    expect(messages[0]).toContain('Juan');
    expect(messages[0]).toContain('Pizza Muzzarella');
    expect(messages[0]).toContain('ARS');
  });

  test('busqueda semantica de conversaciones + notificacion handoff', () => {
    const messages = [
      { text: 'Estoy muy enojado con el servicio quiero hablar con alguien', phone: '+54111' },
      { text: 'Hola quiero saber el precio de las empanadas', phone: '+54222' },
    ];

    // Detectar mensaje que requiere handoff
    const results = searchMessages(messages, 'enojado');
    expect(results.results.length).toBeGreaterThan(0);
    const urgentPhone = results.results[0].message.phone;

    // Construir notificacion de handoff
    const notif = buildNotificationRecord(UID, 'handoff_requested', {
      phone: urgentPhone, reason: 'complaint',
    });
    const text = buildNotificationText(notif);
    expect(text).toContain(urgentPhone);
    expect(text).toContain('complaint');
    expect(notif.priority).toBe('high');
  });
});
