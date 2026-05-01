'use strict';

/**
 * T304 -- E2E Bloque 30
 * Pipeline: onboarding completo (7 pasos) → seleccion de plan (dynamic_pricing)
 * → suscripcion creada → pago primer mes → factura emitida → negocio live.
 */

const {
  buildOnboardingRecord,
  buildStepPayload,
  validateStepCompletion,
  advanceStep,
  saveOnboarding,
  getOnboarding,
  getNextStep,
  computeProgress,
  buildOnboardingText,
  buildWelcomeMessage,
  ONBOARDING_STEPS,
  __setFirestoreForTests: setOBDb,
} = require('../core/onboarding_engine');

const {
  getPlanPrice,
  comparePlans,
  recommendPlan,
  invalidateCache,
  __setFirestoreForTests: setPricingDb,
} = require('../core/dynamic_pricing_engine');

const {
  buildSubscriptionRecord,
  computeSubscriptionPrice,
  recordBilling,
  __setFirestoreForTests: setSubDb,
} = require('../core/subscription_engine');

const {
  buildPaymentRecord,
  processPayment,
  markProcessing,
  __setFirestoreForTests: setPayDb,
} = require('../core/payment_engine');

const {
  buildInvoiceRecord,
  buildLineItem,
  applyPayment,
  __setFirestoreForTests: setInvDb,
} = require('../core/invoice_engine');

function makeMockDb() {
  const store = { global_pricing: {} };
  return {
    store,
    db: {
      collection: (colName) => {
        if (colName === 'global_pricing') {
          return {
            get: async () => {
              const entries = Object.entries(store.global_pricing || {});
              return {
                empty: entries.length === 0,
                forEach: (fn) => entries.forEach(([id, data]) => fn({ id, data: () => data })),
              };
            },
            doc: (id) => ({
              set: async (data, opts) => {
                if (opts && opts.merge) {
                  store.global_pricing[id] = { ...(store.global_pricing[id] || {}), ...data };
                } else {
                  store.global_pricing[id] = { ...data };
                }
              },
            }),
          };
        }
        // owners collection
        return {
          doc: (uid) => ({
            collection: (subCol) => ({
              doc: (id) => ({
                set: async (data, opts) => {
                  if (!store[uid]) store[uid] = {};
                  if (!store[uid][subCol]) store[uid][subCol] = {};
                  if (opts && opts.merge) {
                    store[uid][subCol][id] = { ...(store[uid][subCol][id] || {}), ...data };
                  } else {
                    store[uid][subCol][id] = { ...data };
                  }
                },
                get: async () => {
                  const rec = store[uid] && store[uid][subCol] && store[uid][subCol][id];
                  return { exists: !!rec, data: () => rec };
                },
              }),
              where: (field, op, val) => {
                const chain = { filters: [[field, op, val]] };
                chain.where = (f2, op2, v2) => { chain.filters.push([f2, op2, v2]); return chain; };
                chain.get = async () => {
                  const all = Object.values((store[uid] || {})[subCol] || {});
                  const filtered = all.filter(r => chain.filters.every(([f, o, v]) => o === '==' ? r[f] === v : true));
                  return {
                    empty: filtered.length === 0,
                    forEach: (fn) => filtered.forEach(d => fn({ data: () => d })),
                  };
                };
                return chain;
              },
              get: async () => {
                const all = Object.values((store[uid] || {})[subCol] || {});
                return {
                  empty: all.length === 0,
                  forEach: (fn) => all.forEach(d => fn({ data: () => d })),
                };
              },
            }),
          }),
        };
      },
    },
  };
}

const UID = 'owner_bloque30_001';
const PHONE = '+541199990001';

describe('T304 -- E2E Bloque 30: onboarding completo + plan + subscription + payment', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setOBDb(mock.db);
    setPricingDb(mock.db);
    setSubDb(mock.db);
    setPayDb(mock.db);
    setInvDb(mock.db);
    invalidateCache();
  });

  // Paso 1: Iniciar onboarding

  test('Paso 1 -- onboarding record creado en not_started', () => {
    const rec = buildOnboardingRecord(UID, {
      businessInfo: { name: 'Estetica Luna', type: 'salud_belleza', phone: PHONE },
    });
    expect(rec.status).toBe('not_started');
    expect(rec.currentStep).toBe('welcome');
    expect(computeProgress(rec.completedSteps)).toBe(0);
  });

  // Paso 2: Mensaje de bienvenida

  test('Paso 2 -- mensaje de bienvenida con nombre del negocio', () => {
    const msg = buildWelcomeMessage('Estetica Luna');
    expect(msg).toContain('Estetica Luna');
    expect(msg).toContain('MIIA');
  });

  // Paso 3: Completar step welcome

  test('Paso 3 -- step welcome completado', async () => {
    const result = await advanceStep(UID, 'welcome', {});
    expect(result.step).toBe('welcome');
    expect(result.nextStep).toBe('business_info');
    expect(result.status).toBe('in_progress');
    expect(result.completedSteps).toContain('welcome');
  });

  // Paso 4: Completar business_info

  test('Paso 4 -- business_info completado con datos del negocio', async () => {
    await advanceStep(UID, 'welcome', {});
    const payload = buildStepPayload('business_info', {
      name: 'Estetica Luna',
      type: 'salud_belleza',
      phone: PHONE,
      timezone: 'America/Argentina/Buenos_Aires',
    });
    expect(validateStepCompletion('business_info', payload).valid).toBe(true);
    const result = await advanceStep(UID, 'business_info', payload);
    expect(result.nextStep).toBe('whatsapp_setup');
    expect(result.completedSteps).toContain('business_info');
  });

  // Paso 5: WhatsApp conectado

  test('Paso 5 -- whatsapp_setup completado con QR escaneado', async () => {
    const payload = buildStepPayload('whatsapp_setup', { connected: true, qrScanned: true });
    expect(validateStepCompletion('whatsapp_setup', payload).valid).toBe(true);
    const result = await advanceStep(UID, 'whatsapp_setup', payload);
    expect(result.nextStep).toBe('catalog_setup');
  });

  // Paso 6: Seleccion de plan por uso proyectado

  test('Paso 6 -- recomienda plan starter para negocio estetica (200 msgs/dia)', async () => {
    const plan = recommendPlan({ avgMessagesPerDay: 200, totalContacts: 150 });
    expect(plan).toBe('starter'); // 200>50 y 150>100 → starter

    const price = await getPlanPrice('starter', 'AR');
    expect(price.currency).toBe('ARS');
    expect(price.priceUSD).toBe(19);
    expect(price.features.messagesPerDay).toBe(500);
  });

  // Paso 7: Suscripcion al plan starter

  test('Paso 7 -- suscripcion mensual starter creada', () => {
    let sub = buildSubscriptionRecord(UID, {
      name: 'MIIA Starter',
      type: 'plan',
      billingCycle: 'monthly',
      price: 19,
      currency: 'USD',
      contactPhone: PHONE,
    });
    expect(sub.status).toBe('active');
    expect(computeSubscriptionPrice(sub)).toBe(19);
    sub = recordBilling(sub, true);
    expect(sub.billingCount).toBe(1);
  });

  // Paso 8: Pago y factura primer mes

  test('Paso 8 -- pago 19 USD + factura emitida', () => {
    let pago = buildPaymentRecord(UID, {
      amount: 19, method: 'card_credit', currency: 'USD', contactPhone: PHONE,
    });
    pago = markProcessing(pago);
    pago = processPayment(pago, { success: true, amountReceived: 19 });
    expect(pago.status).toBe('completed');

    const lineItems = [buildLineItem({ description: 'MIIA Starter mes 1', quantity: 1, unitPrice: 19, taxRate: 0 })];
    let invoice = buildInvoiceRecord(UID, { clientPhone: PHONE, currency: 'USD', lineItems, globalDiscountAmount: 0 });
    invoice = applyPayment(invoice, 19);
    expect(invoice.status).toBe('paid');
    expect(invoice.total).toBe(19);
  });

  // Paso 9: Catalogo y personalidad configurados

  test('Paso 9 -- catalog_setup y personality_config completados', async () => {
    const catResult = await advanceStep(UID, 'catalog_setup', { productCount: 12, skipped: false });
    expect(catResult.nextStep).toBe('personality_config');

    const persPayload = buildStepPayload('personality_config', { tone: 'amigable', language: 'es' });
    const persResult = await advanceStep(UID, 'personality_config', persPayload);
    expect(persResult.nextStep).toBe('test_conversation');
  });

  // Paso 10: Test conversation y go_live

  test('Paso 10 -- test_conversation aprobado → go_live → negocio activo', async () => {
    // Test conversation
    const testPayload = buildStepPayload('test_conversation', { passed: true, notes: 'Todo OK' });
    expect(validateStepCompletion('test_conversation', testPayload).valid).toBe(true);
    const testResult = await advanceStep(UID, 'test_conversation', testPayload);
    expect(testResult.nextStep).toBe('go_live');

    // Go live
    const liveResult = await advanceStep(UID, 'go_live', { channel: 'whatsapp' });
    expect(liveResult.status).toBe('completed');
    expect(liveResult.nextStep).toBeNull();
  });

  // Pipeline completo integrado

  test('Pipeline completo -- onboarding 7 pasos + plan + sub + payment + live', async () => {
    // A. Record inicial
    const rec = buildOnboardingRecord(UID, {
      businessInfo: { name: 'Estetica Luna', type: 'salud_belleza', phone: PHONE },
    });
    await saveOnboarding(UID, rec);
    expect((await getOnboarding(UID)).status).toBe('not_started');

    // B. Bienvenida
    const welcome = buildWelcomeMessage('Estetica Luna');
    expect(welcome).toContain('MIIA');

    // C. Completar todos los pasos
    await advanceStep(UID, 'welcome', {});
    await advanceStep(UID, 'business_info', { name: 'Estetica Luna', type: 'salud_belleza', phone: PHONE, timezone: 'America/Argentina/Buenos_Aires' });
    await advanceStep(UID, 'whatsapp_setup', { connected: true, qrScanned: true });
    await advanceStep(UID, 'catalog_setup', { productCount: 8, skipped: false });
    await advanceStep(UID, 'personality_config', { tone: 'amigable', language: 'es', customInstructions: '' });
    await advanceStep(UID, 'test_conversation', { passed: true, notes: 'Flujo correcto' });
    const liveResult = await advanceStep(UID, 'go_live', { channel: 'whatsapp' });
    expect(liveResult.status).toBe('completed');
    expect(liveResult.completedSteps.length).toBe(7);

    // D. Verificar progreso final desde Firestore
    const stored = mock.store[UID]['onboarding'];
    const onboardingId = UID.slice(0, 8) + '_onboarding';
    const finalState = stored[onboardingId];
    expect(finalState.status).toBe('completed');
    expect(finalState.completedSteps.length).toBe(7);

    // E. Plan recommendation y pricing
    const plan = recommendPlan({ avgMessagesPerDay: 200, totalContacts: 150 });
    expect(plan).toBe('starter');
    const price = await getPlanPrice('starter', 'AR');
    expect(price.priceUSD).toBe(19);

    // F. Comparar con upgrade path
    const diff = comparePlans('starter', 'pro');
    expect(diff.upgradeRecommended).toBe(true);

    // G. Suscripcion creada
    let sub = buildSubscriptionRecord(UID, {
      name: 'MIIA Starter', type: 'plan', billingCycle: 'monthly', price: 19, currency: 'USD', contactPhone: PHONE,
    });
    sub = recordBilling(sub, true);
    expect(sub.billingCount).toBe(1);

    // H. Pago completado
    let pago = buildPaymentRecord(UID, { amount: 19, method: 'transfer', currency: 'USD', contactPhone: PHONE });
    pago = markProcessing(pago);
    pago = processPayment(pago, { success: true, amountReceived: 19 });
    expect(pago.status).toBe('completed');

    // I. Factura
    const items = [buildLineItem({ description: 'Starter mes 1', quantity: 1, unitPrice: 19, taxRate: 0 })];
    let invoice = buildInvoiceRecord(UID, { clientPhone: PHONE, currency: 'USD', lineItems: items, globalDiscountAmount: 0 });
    invoice = applyPayment(invoice, 19);
    expect(invoice.status).toBe('paid');

    // J. Texto onboarding final
    const finalRec = {
      status: 'completed',
      currentStep: 'go_live',
      completedSteps: [...ONBOARDING_STEPS],
      businessInfo: { name: 'Estetica Luna', type: 'salud_belleza' },
      whatsappConnected: true,
      catalogSetup: true,
      testConversationDone: true,
    };
    const text = buildOnboardingText(finalRec);
    expect(text).toContain('100%');
    expect(text).toContain('completed');
  });
});
