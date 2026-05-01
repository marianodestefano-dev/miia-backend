'use strict';

// T264 E2E Bloque 15: catalog_manager + onboarding_engine + broadcast_engine + notification_engine
const {
  buildProductRecord, saveProduct, listAvailableProducts,
  updateProductStatus, buildCatalogText, searchProductsLocal,
  computeProductAvailability,
  __setFirestoreForTests: setCatalog,
} = require('../core/catalog_manager');

const {
  buildOnboardingRecord, saveOnboarding, getOnboarding,
  advanceStep, computeProgress, buildWelcomeMessage,
  buildOnboardingText, ONBOARDING_STEPS,
  __setFirestoreForTests: setOnboarding,
} = require('../core/onboarding_engine');

const {
  buildBroadcastRecord, saveBroadcast, updateBroadcastStatus,
  addRecipients, validateBroadcastContent, computeBroadcastStats,
  buildBroadcastSummaryText, scheduleBroadcast,
  __setFirestoreForTests: setBroadcast,
} = require('../core/broadcast_engine');

const {
  buildNotificationRecord, buildNotificationBody, saveNotification,
  updateNotificationStatus, getPendingNotifications,
  buildNotificationSummaryText,
  __setFirestoreForTests: setNotif,
} = require('../core/notification_engine');

const UID = 'bloque15Uid';
const PHONES = ['+5491155554444', '+5491155554445', '+5491155554446'];
const FUTURE = Date.now() + 3600000;

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
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { exists: !!db_stored[id], data: () => db_stored[id] };
            },
          }),
          where: (field, op, val) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const entries = Object.values(db_stored).filter(d => d && d[field] === val);
              return { empty: entries.length === 0, forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return { empty: Object.keys(db_stored).length === 0, forEach: fn => Object.values(db_stored).forEach(d => fn({ data: () => d })) };
          },
        }),
      }),
    }),
  };
}

function setAll(db) { setCatalog(db); setOnboarding(db); setBroadcast(db); setNotif(db); }

beforeEach(() => setAll(null));
afterEach(() => setAll(null));

// ─── CATALOG MANAGER ─────────────────────────────────────────────────────────
describe('catalog_manager — E2E', () => {
  test('buildProductRecord + computeProductAvailability disponible', () => {
    const p = buildProductRecord(UID, { name: 'Corte Premium', price: 800, category: 'servicios', stock: 10 });
    const avail = computeProductAvailability(p);
    expect(avail.available).toBe(true);
    expect(avail.stock).toBe(10);
  });
  test('saveProduct + listAvailableProducts round-trip', async () => {
    const db = makeMockDb();
    setAll(db);
    const p = buildProductRecord(UID, { name: 'Serv A', price: 500, category: 'servicios' });
    await saveProduct(UID, p);
    setAll(db);
    const available = await listAvailableProducts(UID);
    expect(available.length).toBe(1);
    expect(available[0].name).toBe('Serv A');
  });
  test('updateProductStatus discontinuado', async () => {
    setAll(makeMockDb());
    const id = await updateProductStatus(UID, 'prod_001', 'discontinued');
    expect(id).toBe('prod_001');
  });
  test('searchProductsLocal por precio', () => {
    const products = [
      buildProductRecord(UID, { name: 'Basico', price: 100, category: 'servicios' }),
      buildProductRecord(UID, { name: 'Premium', price: 500, category: 'servicios' }),
      buildProductRecord(UID, { name: 'Elite', price: 1000, category: 'servicios' }),
    ];
    products[0].productId = 'p1'; products[1].productId = 'p2'; products[2].productId = 'p3';
    const r = searchProductsLocal(products, '', { maxPrice: 500, sortBy: 'price' });
    expect(r.length).toBe(2);
    expect(r.every(p => p.price <= 500)).toBe(true);
  });
  test('buildCatalogText agrupa y muestra productos', () => {
    const products = [
      buildProductRecord(UID, { name: 'Corte', price: 500, category: 'servicios' }),
      buildProductRecord(UID, { name: 'Shampoo', price: 200, category: 'productos_fisicos' }),
    ];
    products[0].productId = 'p1'; products[1].productId = 'p2';
    const text = buildCatalogText(products, { title: 'Menu de Servicios' });
    expect(text).toContain('Menu de Servicios');
    expect(text).toContain('Corte');
    expect(text).toContain('Shampoo');
    expect(text).toContain('500');
  });
});

// ─── ONBOARDING ENGINE ────────────────────────────────────────────────────────
describe('onboarding_engine — E2E', () => {
  test('ONBOARDING_STEPS tiene 7 pasos iniciando con welcome', () => {
    expect(ONBOARDING_STEPS[0]).toBe('welcome');
    expect(ONBOARDING_STEPS.length).toBe(7);
  });
  test('buildOnboardingRecord defaults correctos', () => {
    const r = buildOnboardingRecord(UID);
    expect(r.status).toBe('not_started');
    expect(r.currentStep).toBe('welcome');
    expect(computeProgress(r.completedSteps)).toBe(0);
  });
  test('saveOnboarding + getOnboarding round-trip', async () => {
    const db = makeMockDb();
    setAll(db);
    const r = buildOnboardingRecord(UID, { status: 'in_progress', currentStep: 'catalog_setup' });
    await saveOnboarding(UID, r);
    setAll(db);
    const loaded = await getOnboarding(UID);
    expect(loaded.currentStep).toBe('catalog_setup');
  });
  test('advanceStep welcome -> business_info', async () => {
    setAll(makeMockDb());
    const r = await advanceStep(UID, 'welcome', { acknowledged: true });
    expect(r.nextStep).toBe('business_info');
    expect(r.completedSteps).toContain('welcome');
  });
  test('buildWelcomeMessage incluye nombre negocio', () => {
    const msg = buildWelcomeMessage('Salon Bella');
    expect(msg).toContain('Salon Bella');
    expect(msg.toLowerCase()).toContain('whatsapp');
  });
  test('buildOnboardingText muestra progreso', () => {
    const r = buildOnboardingRecord(UID, {
      status: 'in_progress',
      currentStep: 'catalog_setup',
      completedSteps: ['welcome', 'business_info', 'whatsapp_setup'],
      businessInfo: { name: 'CorteStyle', type: 'salud_belleza' },
      whatsappConnected: true,
    });
    const text = buildOnboardingText(r);
    expect(text).toContain('CorteStyle');
    expect(text).toContain('WhatsApp conectado');
    expect(text).toContain('%');
  });
});

// ─── BROADCAST ENGINE ─────────────────────────────────────────────────────────
describe('broadcast_engine — E2E', () => {
  test('buildBroadcastRecord con recipients validos', () => {
    const b = buildBroadcastRecord(UID, { name: 'Promo', message: 'Hola clientes!', recipients: PHONES, type: 'promotional' });
    expect(b.recipientCount).toBe(3);
    expect(b.type).toBe('promotional');
    expect(b.status).toBe('draft');
  });
  test('validateBroadcastContent valida correctamente', () => {
    const r = validateBroadcastContent({ name: 'Test', message: 'Hola!', recipients: PHONES });
    expect(r.valid).toBe(true);
  });
  test('addRecipients agrega nuevos sin duplicar', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', recipients: [PHONES[0]] });
    const updated = addRecipients(b, [PHONES[1], PHONES[2]]);
    expect(updated.recipientCount).toBe(3);
  });
  test('saveBroadcast + updateBroadcastStatus round-trip', async () => {
    const db = makeMockDb();
    setAll(db);
    const b = buildBroadcastRecord(UID, { name: 'Promo Junio', message: 'Hola!', recipients: PHONES });
    await saveBroadcast(UID, b);
    setAll(db);
    const id = await updateBroadcastStatus(UID, b.broadcastId, 'sending');
    expect(id).toBe(b.broadcastId);
  });
  test('scheduleBroadcast cambia a scheduled', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', recipients: PHONES });
    const scheduled = scheduleBroadcast(b, FUTURE);
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.scheduledAt).toBe(FUTURE);
  });
  test('computeBroadcastStats calcula tasa entrega', () => {
    const results = { p1: 'sent', p2: 'sent', p3: 'failed', p4: 'sent' };
    const stats = computeBroadcastStats(results);
    expect(stats.sentCount).toBe(3);
    expect(stats.failedCount).toBe(1);
    expect(stats.deliveryRate).toBe(75);
  });
  test('buildBroadcastSummaryText incluye datos clave', () => {
    const b = buildBroadcastRecord(UID, { name: 'Promo Verano', message: 'Oferta!', recipients: PHONES, type: 'promotional' });
    const text = buildBroadcastSummaryText(b);
    expect(text).toContain('Promo Verano');
    expect(text).toContain('3');
    expect(text).toContain('draft');
  });
});

// ─── NOTIFICATION ENGINE ──────────────────────────────────────────────────────
describe('notification_engine — E2E', () => {
  test('buildNotificationRecord tipo appointment_reminder', () => {
    const n = buildNotificationRecord(UID, { type: 'appointment_reminder', priority: 'high', recipientPhone: PHONES[0] });
    expect(n.type).toBe('appointment_reminder');
    expect(n.priority).toBe('high');
    expect(n.status).toBe('pending');
  });
  test('buildNotificationBody todos los tipos no lanzan error', () => {
    ['appointment_reminder','appointment_confirmation','payment_received','new_lead','follow_up_due','broadcast_complete','system_alert','custom'].forEach(t => {
      expect(() => buildNotificationBody(t, {})).not.toThrow();
    });
  });
  test('saveNotification + getPendingNotifications round-trip', async () => {
    const db = makeMockDb();
    setAll(db);
    const n = buildNotificationRecord(UID, { type: 'new_lead', priority: 'high' });
    await saveNotification(UID, n);
    setAll(db);
    const pending = await getPendingNotifications(UID);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.some(p => p.type === 'new_lead')).toBe(true);
  });
  test('updateNotificationStatus a read', async () => {
    setAll(makeMockDb());
    const id = await updateNotificationStatus(UID, 'notif_001', 'read');
    expect(id).toBe('notif_001');
  });
  test('buildNotificationSummaryText incluye tipo y estado', () => {
    const n = buildNotificationRecord(UID, { type: 'system_alert', title: 'Alerta critica', priority: 'urgent', body: 'Falla detectada' });
    const text = buildNotificationSummaryText(n);
    expect(text).toContain('system_alert');
    expect(text).toContain('urgent');
    expect(text).toContain('Falla detectada');
  });
});

// ─── PIPELINE INTEGRADO ───────────────────────────────────────────────────────
describe('Pipeline P3: owner completa onboarding, configura catalogo, hace broadcast y notifica', () => {
  test('flujo completo Piso 3 — Bloque 15', async () => {
    const db = makeMockDb();
    setAll(db);

    // 1. Iniciar onboarding
    const onboarding = buildOnboardingRecord(UID, { status: 'in_progress' });
    await saveOnboarding(UID, onboarding);

    // 2. Avanzar welcome
    setAll(db);
    const step1 = await advanceStep(UID, 'welcome', { acknowledged: true });
    expect(step1.nextStep).toBe('business_info');

    // 3. Avanzar business_info
    setAll(db);
    const step2 = await advanceStep(UID, 'business_info', { name: 'Salon Bella', type: 'salud_belleza', phone: PHONES[0] });
    expect(step2.completedSteps).toContain('business_info');

    // 4. Verificar mensaje de bienvenida
    const welcomeMsg = buildWelcomeMessage('Salon Bella');
    expect(welcomeMsg).toContain('Salon Bella');

    // 5. Crear y guardar catalogo de servicios
    const productA = buildProductRecord(UID, { name: 'Corte de Pelo', price: 500, currency: 'ARS', category: 'servicios' });
    const productB = buildProductRecord(UID, { name: 'Tinte', price: 1500, currency: 'ARS', category: 'servicios' });
    productB.productId = UID.slice(0,8) + '_prod_tinte';
    setAll(db);
    await saveProduct(UID, productA);
    setAll(db);
    await saveProduct(UID, productB);
    setAll(db);
    const available = await listAvailableProducts(UID);
    expect(available.length).toBe(2);

    // 6. Construir texto de catalogo
    const catalogText = buildCatalogText(available, { title: 'Servicios Salon Bella' });
    expect(catalogText).toContain('Salon Bella');
    expect(catalogText).toContain('Corte de Pelo');

    // 7. Crear broadcast promocional
    const broadcast = buildBroadcastRecord(UID, {
      name: 'Apertura Salon',
      message: 'Hola! Te invitamos a conocer Salon Bella. Presentate con este mensaje y tenes 20% off tu primer turno!',
      recipients: PHONES,
      type: 'promotional',
    });
    const validationResult = validateBroadcastContent({ name: broadcast.name, message: broadcast.message, recipients: broadcast.recipients });
    expect(validationResult.valid).toBe(true);
    setAll(db);
    const broadcastId = await saveBroadcast(UID, broadcast);
    expect(broadcastId).toBe(broadcast.broadcastId);

    // 8. Marcar broadcast como enviado
    setAll(db);
    await updateBroadcastStatus(UID, broadcastId, 'sent');

    // 9. Crear notificacion de broadcast completado
    const notifBody = buildNotificationBody('broadcast_complete', { broadcastName: 'Apertura Salon' });
    expect(notifBody).toContain('Apertura Salon');
    const notif = buildNotificationRecord(UID, {
      type: 'broadcast_complete',
      body: notifBody,
      priority: 'normal',
      recipientPhone: PHONES[0],
    });
    setAll(db);
    await saveNotification(UID, notif);

    // 10. Computar stats del broadcast
    const stats = computeBroadcastStats({ p1: 'sent', p2: 'sent', p3: 'failed' });
    expect(stats.deliveryRate).toBeGreaterThan(0);

    // 11. Texto resumen broadcast
    const summary = buildBroadcastSummaryText({ ...broadcast, status: 'sent', results: { p1: 'sent', p2: 'sent', p3: 'failed' } });
    expect(summary).toContain('Apertura Salon');

    // 12. Verificar notificacion pendiente
    setAll(db);
    const pending = await getPendingNotifications(UID);
    expect(pending.length).toBeGreaterThan(0);
  });
});
