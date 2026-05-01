'use strict';

/**
 * T280 — E2E Bloque 19
 * Pipeline: referido llega por codigo → template bienvenida renderizado →
 * conexion e-commerce WooCommerce → orden externa mapeada →
 * factura emitida por la orden → pago completo → referido premiado por first_purchase
 */

const {
  buildReferralProgramRecord,
  buildReferralRecord,
  qualifyReferral,
  rewardReferral,
  isProgramActive,
  computeConversionRate,
  __setFirestoreForTests: setRefDb,
} = require('../core/referral_engine');

const {
  buildTemplateRecord,
  renderTemplate,
  buildDefaultTemplates,
  __setFirestoreForTests: setTplDb,
} = require('../core/template_engine');

const {
  buildEcommerceConnection,
  buildExternalProduct,
  buildExternalOrder,
  mapProductToInternal,
  computeSyncStats,
  buildSyncRecord,
  __setFirestoreForTests: setEcomDb,
} = require('../core/ecommerce_bridge');

const {
  buildInvoiceRecord,
  buildLineItem,
  applyPayment,
  buildInvoiceText,
  checkOverdue,
  __setFirestoreForTests: setInvDb,
} = require('../core/invoice_engine');

// ─── Mock DB compartido ──────────────────────────────────────────────────────

function makeMockDb(label) {
  const store = {};
  return {
    store,
    db: {
      collection: () => ({
        doc: (uid) => ({
          collection: (subCol) => ({
            doc: (id) => ({
              set: async (data) => {
                if (!store[uid]) store[uid] = {};
                if (!store[uid][subCol]) store[uid][subCol] = {};
                store[uid][subCol][id] = { ...data };
              },
              get: async () => {
                const rec = store[uid] && store[uid][subCol] && store[uid][subCol][id];
                return { exists: !!rec, data: () => rec };
              },
              update: async (data) => {
                if (!store[uid]) store[uid] = {};
                if (!store[uid][subCol]) store[uid][subCol] = {};
                store[uid][subCol][id] = { ...(store[uid][subCol][id] || {}), ...data };
              },
            }),
            where: (field, op, val) => ({
              get: async () => {
                const all = Object.values((store[uid] || {})[subCol] || {});
                const filtered = all.filter(r => op === '==' ? r[field] === val : true);
                return {
                  empty: filtered.length === 0,
                  forEach: (fn) => filtered.forEach(d => fn({ data: () => d })),
                };
              },
            }),
            get: async () => {
              const all = Object.values((store[uid] || {})[subCol] || {});
              return {
                empty: all.length === 0,
                forEach: (fn) => all.forEach(d => fn({ data: () => d })),
              };
            },
          }),
        }),
      }),
    },
  };
}

const UID_REFERRER = 'owner_referrer_001';
const UID_REFERRED = 'owner_referred_002';

describe('T280 — E2E Bloque 19: referido → template → ecommerce → factura → reward', () => {
  let refMock, tplMock, ecomMock, invMock;

  beforeEach(() => {
    refMock = makeMockDb('ref');
    tplMock = makeMockDb('tpl');
    ecomMock = makeMockDb('ecom');
    invMock = makeMockDb('inv');

    setRefDb(refMock.db);
    setTplDb(tplMock.db);
    setEcomDb(ecomMock.db);
    setInvDb(invMock.db);
  });

  // ─── Paso 1: Programa de referidos activo ────────────────────────────────

  test('Paso 1 — programa de referidos creado y activo', () => {
    const program = buildReferralProgramRecord(UID_REFERRER, {
      name: 'Promo Amigos',
      referrerRewardAmount: 200,
      referredRewardAmount: 100,
      rewardTrigger: 'first_purchase',
      maxReferrals: 50,
    });

    expect(program.uid).toBe(UID_REFERRER);
    expect(program.rewardTrigger).toBe('first_purchase');
    expect(program.referrerRewardAmount).toBe(200);
    expect(program.referredRewardAmount).toBe(100);
    expect(isProgramActive(program)).toBe(true);
  });

  // ─── Paso 2: Referido llega, califica y se premia ────────────────────────

  test('Paso 2 — referido llega → califica → se premia', () => {
    const program = buildReferralProgramRecord(UID_REFERRER, {
      rewardTrigger: 'first_purchase',
      referrerRewardAmount: 200,
      referredRewardAmount: 100,
    });

    const referral = buildReferralRecord(UID_REFERRER, '+573054169969', '+541155550001', {
      referredName: 'Juan Nuevo',
      channel: 'whatsapp',
    });

    expect(referral.status).toBe('pending');

    // Califica por primera compra
    const qualified = qualifyReferral(referral);
    expect(qualified.status).toBe('qualified');
    expect(qualified.qualifiedAt).toBeGreaterThan(0);

    // Premio entregado
    const rewarded = rewardReferral(qualified);
    expect(rewarded.status).toBe('rewarded');
    expect(rewarded.referrerRewarded).toBe(true);
    expect(rewarded.referredRewarded).toBe(true);
    expect(rewarded.rewardedAt).toBeGreaterThan(0);
  });

  // ─── Paso 3: Template de bienvenida renderizado ──────────────────────────

  test('Paso 3 — template de bienvenida renderizado con datos del referido', () => {
    const templates = buildDefaultTemplates(UID_REFERRER);
    const welcome = templates.find(t => t.type === 'welcome');
    expect(welcome).toBeDefined();

    const rendered = renderTemplate(welcome, {
      nombre: 'Juan Nuevo',
      negocio: 'Tienda Demo',
    });

    expect(rendered.rendered).toContain('Juan Nuevo');
    expect(rendered.rendered).toContain('Tienda Demo');
    expect(rendered.complete).toBe(true);
    expect(rendered.missing.length).toBe(0);
  });

  // ─── Paso 4: Template con variable faltante ──────────────────────────────

  test('Paso 4 — template con variable faltante reporta missing', () => {
    const tpl = buildTemplateRecord(UID_REFERRER, {
      name: 'Turno con link',
      type: 'appointment_reminder',
      body: 'Hola {{nombre_cliente}}, tu turno es el {{fecha_turno}} — link: {{link_confirmacion}}',
      channel: 'whatsapp',
    });

    const rendered = renderTemplate(tpl, { nombre_cliente: 'Juan' });
    expect(rendered.complete).toBe(false);
    expect(rendered.missing).toContain('fecha_turno');
    expect(rendered.missing).toContain('link_confirmacion');
    expect(rendered.rendered).toContain('Juan');
  });

  // ─── Paso 5: Conexion e-commerce WooCommerce ─────────────────────────────

  test('Paso 5 — conexion WooCommerce creada correctamente', () => {
    const conn = buildEcommerceConnection(UID_REFERRED, 'woocommerce', {
      storeUrl: 'https://mi-tienda.com',
      storeName: 'Tienda Demo',
      apiKey: 'wc_key_abc123',
      apiSecret: 'wc_secret_xyz',
      syncProducts: true,
      syncOrders: true,
    });

    expect(conn.platform).toBe('woocommerce');
    expect(conn.storeName).toBe('Tienda Demo');
    expect(conn.apiSecret).toBe('***'); // nunca en texto plano
    expect(conn.syncProducts).toBe(true);
    expect(conn.direction).toBe('bidirectional');
  });

  // ─── Paso 6: Producto externo WooCommerce mapeado a interno ──────────────

  test('Paso 6 — producto externo WooCommerce mapeado a producto interno', () => {
    const extProduct = buildExternalProduct({
      externalId: 'wc_prod_555',
      externalSku: 'SKU-001',
      name: 'Camiseta Premium',
      price: 3500,
      stock: 25,
      currency: 'ars',
      category: 'ropa',
      active: true,
      platform: 'woocommerce',
    });

    expect(extProduct.currency).toBe('ARS'); // normalizado
    expect(extProduct.price).toBe(3500);
    expect(extProduct.active).toBe(true);

    const internal = mapProductToInternal(extProduct, UID_REFERRED);
    expect(internal.uid).toBe(UID_REFERRED);
    expect(internal.name).toBe('Camiseta Premium');
    expect(internal.status).toBe('available');
    expect(internal.externalPlatform).toBe('woocommerce');
    expect(internal.externalId).toBe('wc_prod_555');
  });

  // ─── Paso 7: Orden externa WooCommerce ───────────────────────────────────

  test('Paso 7 — orden externa WooCommerce procesada correctamente', () => {
    const order = buildExternalOrder({
      externalId: 'wc_order_9001',
      externalNumber: '#9001',
      status: 'processing',
      total: 7000,
      subtotal: 6000,
      shippingCost: 1000,
      currency: 'ars',
      customerName: 'Juan Nuevo',
      customerEmail: 'juan@example.com',
      customerPhone: '+541155550001',
      items: [
        { productId: 'wc_prod_555', name: 'Camiseta Premium', quantity: 2, price: 3500 },
      ],
      platform: 'woocommerce',
    });

    expect(order.externalId).toBe('wc_order_9001');
    expect(order.status).toBe('processing');
    expect(order.total).toBe(7000);
    expect(order.currency).toBe('ARS');
    expect(order.itemCount).toBe(1);
    expect(order.customerPhone).toBe('+541155550001');
  });

  // ─── Paso 8: Sync record con stats ───────────────────────────────────────

  test('Paso 8 — sync record y computeSyncStats coherentes', () => {
    const conn = buildEcommerceConnection(UID_REFERRED, 'woocommerce', {});
    const syncRec = buildSyncRecord(UID_REFERRED, conn.connectionId, { direction: 'import', type: 'incremental' });

    const now = Date.now();
    const completedSyncRec = {
      ...syncRec,
      status: 'synced',
      productCount: 12,
      orderCount: 3,
      errorCount: 0,
      startedAt: now - 5000,
      completedAt: now,
    };

    const stats = computeSyncStats(completedSyncRec);
    expect(stats.success).toBe(true);
    expect(stats.productCount).toBe(12);
    expect(stats.orderCount).toBe(3);
    expect(stats.duration).toBeGreaterThan(0);
    expect(stats.errorCount).toBe(0);
  });

  // ─── Paso 9: Factura emitida por la orden ────────────────────────────────

  test('Paso 9 — factura emitida por la orden WooCommerce', () => {
    const inv = buildInvoiceRecord(UID_REFERRED, {
      clientName: 'Juan Nuevo',
      clientEmail: 'juan@example.com',
      clientPhone: '+541155550001',
      currency: 'ARS',
      type: 'invoice',
      status: 'issued',
      lineItems: [
        { description: 'Camiseta Premium x2', quantity: 2, unitPrice: 3500, taxRate: 0.21 },
        { description: 'Envio', quantity: 1, unitPrice: 1000, type: 'shipping' },
      ],
    });

    expect(inv.lineItems.length).toBe(2);
    expect(inv.subtotal).toBeCloseTo(8000, 0);
    expect(inv.taxTotal).toBeGreaterThan(0);
    expect(inv.total).toBeGreaterThan(inv.subtotal); // total incluye IVA
    expect(inv.amountDue).toBe(inv.total);
    expect(inv.status).toBe('issued');
    expect(checkOverdue(inv)).toBe(false); // dueDate futuro
  });

  // ─── Paso 10: Pago completo de la factura ────────────────────────────────

  test('Paso 10 — pago completo de la factura cambia status a paid', () => {
    const inv = buildInvoiceRecord(UID_REFERRED, {
      status: 'issued',
      lineItems: [{ quantity: 2, unitPrice: 3500 }],
    });

    expect(inv.amountDue).toBeGreaterThan(0);

    const paid = applyPayment(inv, inv.total);
    expect(paid.status).toBe('paid');
    expect(paid.amountPaid).toBeCloseTo(inv.total);
    expect(paid.amountDue).toBe(0);
    expect(paid.paidAt).toBeGreaterThan(0);
  });

  // ─── Paso 11: Texto de factura legible ───────────────────────────────────

  test('Paso 11 — buildInvoiceText genera resumen legible post-pago', () => {
    const inv = buildInvoiceRecord(UID_REFERRED, {
      clientName: 'Juan Nuevo',
      invoiceNumber: 'OWN2-00042',
      lineItems: [{ description: 'Camiseta Premium x2', quantity: 2, unitPrice: 3500 }],
    });
    const paid = applyPayment(inv, inv.total);
    const text = buildInvoiceText({ ...paid, status: 'paid', invoiceNumber: 'OWN2-00042' });

    expect(text).toContain('OWN2-00042');
    expect(text).toContain('Juan Nuevo');
    expect(text).toContain('paid');
    expect(text).not.toContain('Saldo pendiente'); // pagado completo
  });

  // ─── Pipeline completo integrado ─────────────────────────────────────────

  test('Pipeline completo — referido califica + template + ecom + factura pagada', () => {
    // A. Programa referidos
    const program = buildReferralProgramRecord(UID_REFERRER, {
      rewardTrigger: 'first_purchase',
      referrerRewardAmount: 200,
      referredRewardAmount: 100,
    });
    expect(isProgramActive(program)).toBe(true);

    // B. Referido llega
    const referral = buildReferralRecord(UID_REFERRER, '+573054169969', '+541155550001', {
      referredName: 'Juan Nuevo',
    });
    const qualified = qualifyReferral(referral);
    expect(qualified.status).toBe('qualified');

    // C. Template de bienvenida
    const templates = buildDefaultTemplates(UID_REFERRER);
    const welcome = templates.find(t => t.type === 'welcome');
    const { rendered, complete } = renderTemplate(welcome, {
      nombre: 'Juan Nuevo',
      negocio: 'Tienda Demo',
    });
    expect(complete).toBe(true);
    expect(rendered).toContain('Juan Nuevo');

    // D. Conexion e-commerce
    const conn = buildEcommerceConnection(UID_REFERRED, 'woocommerce', {
      storeUrl: 'https://mi-tienda.com',
      syncOrders: true,
    });
    expect(conn.syncOrders).toBe(true);

    // E. Orden externa
    const order = buildExternalOrder({
      externalId: 'wc_order_9001',
      status: 'processing',
      total: 7000,
      currency: 'ars',
      customerPhone: '+541155550001',
      items: [{ productId: 'wc_prod_555', quantity: 2 }],
    });
    expect(order.itemCount).toBe(1);

    // F. Factura por la orden
    const inv = buildInvoiceRecord(UID_REFERRED, {
      status: 'issued',
      clientName: 'Juan Nuevo',
      clientPhone: order.customerPhone,
      currency: 'ARS',
      lineItems: [{ description: 'Camiseta x2', quantity: 2, unitPrice: 3500 }],
    });
    expect(inv.total).toBeGreaterThan(0);

    // G. Pago completo
    const paid = applyPayment(inv, inv.total);
    expect(paid.status).toBe('paid');
    expect(paid.amountDue).toBe(0);

    // H. Referido premiado por first_purchase
    const rewarded = rewardReferral(qualified);
    expect(rewarded.status).toBe('rewarded');
    expect(rewarded.referrerRewarded).toBe(true);

    // I. Tasa de conversion del programa
    const updatedProgram = {
      ...program,
      referredCount: 10,
      qualifiedCount: 7,
    };
    const rate = computeConversionRate(updatedProgram);
    expect(rate).toBe(70);
  });
});
