'use strict';

/**
 * T283 — E2E Bloque 20
 * Pipeline: reporte mensual ventas → KPI summary → notificacion resumen al owner →
 * suscripcion vence → notificacion email renovacion →
 * loyalty tier upgrade → notificacion WhatsApp al cliente →
 * batch de notificaciones broadcast
 */

const {
  buildReportRecord,
  buildSalesReport,
  computeKpiSummary,
  applyReportData,
  buildReportText,
  __setFirestoreForTests: setRepDb,
} = require('../core/report_engine');

const {
  buildNotificationRecord,
  buildBatchNotifications,
  applyDispatchResult,
  markDelivered,
  cancelNotification,
  buildNotificationSummaryText,
  __setFirestoreForTests: setNotifDb,
} = require('../core/notification_center');

const {
  buildSubscriptionRecord,
  recordBilling,
  isInGracePeriod,
  computeSubscriptionPrice,
  __setFirestoreForTests: setSubDb,
} = require('../core/subscription_engine');

const {
  buildLoyaltyAccount,
  earnPoints,
  buildLoyaltySummaryText,
  computeTier,
  __setFirestoreForTests: setLoyDb,
} = require('../core/loyalty_engine');

// ─── Mock DB compartido ──────────────────────────────────────────────────────

function makeMockDb() {
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
            }),
            where: (field, op, val) => {
              const chain = { filters: [[field, op, val]] };
              chain.where = (f2, op2, v2) => { chain.filters.push([f2, op2, v2]); return chain; };
              chain.get = async () => {
                const all = Object.values((store[uid] || {})[subCol] || {});
                const filtered = all.filter(r => chain.filters.every(([f, o, v]) => {
                  if (o === '==') return r[f] === v;
                  if (o === '<=') return r[f] <= v;
                  return true;
                }));
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
      }),
    },
  };
}

const UID = 'owner_bloque20_001';
const PHONE_OWNER = '+573163937365';
const PHONE_CLIENT = '+541155550001';

describe('T283 — E2E Bloque 20: reporte + notificaciones + suscripcion + loyalty', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setRepDb(mock.db);
    setNotifDb(mock.db);
    setSubDb(mock.db);
    setLoyDb(mock.db);
  });

  // ─── Paso 1: Reporte mensual de ventas ───────────────────────────────────

  test('Paso 1 — reporte mensual de ventas generado', () => {
    const report = buildReportRecord(UID, {
      type: 'sales',
      period: 'monthly',
      title: 'Ventas Mayo 2026',
      currency: 'ARS',
    });

    const transactions = [
      { amount: 5000, productName: 'Camiseta', quantity: 2, date: '2026-05-01' },
      { amount: 3000, productName: 'Pantalon', quantity: 1, date: '2026-05-05' },
      { amount: 7500, productName: 'Camiseta', quantity: 3, date: '2026-05-10' },
    ];

    const salesData = buildSalesReport(transactions);
    const ready = applyReportData(report, salesData, transactions.length);

    expect(ready.status).toBe('ready');
    expect(ready.data.totalRevenue).toBeCloseTo(15500);
    expect(ready.data.totalTransactions).toBe(3);
    expect(ready.data.avgTicket).toBeCloseTo(15500 / 3, 0);
    expect(ready.data.topProducts[0].name).toBe('Camiseta'); // mas vendida
    expect(ready.rowCount).toBe(3);
  });

  // ─── Paso 2: KPI summary calculado ───────────────────────────────────────

  test('Paso 2 — KPI summary con crecimiento positivo', () => {
    const kpi = computeKpiSummary({
      revenue: 15500,
      prevRevenue: 12000,
      leads: 80,
      conversions: 24,
      appointments: 45,
      completedAppointments: 38,
      activeSubscriptions: 12,
      newCustomers: 8,
    });

    expect(kpi.revenueGrowth).toBe(29); // ~29.16 → redondeado a 29
    expect(kpi.conversionRate).toBe(30);
    expect(kpi.appointmentRate).toBe(84); // 38/45
    expect(kpi.activeSubscriptions).toBe(12);
    expect(kpi.newCustomers).toBe(8);
  });

  // ─── Paso 3: Notificacion push al owner con resumen ──────────────────────

  test('Paso 3 — notificacion push al owner con reporte KPI', () => {
    const kpi = computeKpiSummary({ revenue: 15500, prevRevenue: 12000, leads: 80, conversions: 24 });
    const notif = buildNotificationRecord(UID, {
      channel: 'push',
      type: 'custom',
      priority: 'high',
      recipientPhone: PHONE_OWNER,
      subject: 'Resumen semanal MIIA',
      body: 'Revenue: ARS 15.500 | Crecimiento: +29% | Leads: 80 | Conversion: 30%',
      templateVars: { revenue: kpi.revenue, growth: kpi.revenueGrowth },
    });

    expect(notif.channel).toBe('push');
    expect(notif.priority).toBe('high');
    expect(notif.subject).toBe('Resumen semanal MIIA');
    expect(notif.templateVars.revenue).toBe(15500);

    // Simular envio exitoso
    const sent = applyDispatchResult(notif, { success: true });
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).toBeGreaterThan(0);

    // Marcar como entregada
    const delivered = markDelivered(sent);
    expect(delivered.status).toBe('delivered');
    expect(delivered.deliveredAt).toBeGreaterThan(0);
  });

  // ─── Paso 4: Suscripcion con billing fallido → grace period ──────────────

  test('Paso 4 — suscripcion con 3 fallos entra en grace period', () => {
    let sub = buildSubscriptionRecord(UID, {
      name: 'Plan Profesional',
      price: 8500,
      billingCycle: 'monthly',
      nextBillingAt: 1000, // pasado
    });

    // 3 fallos de billing → expired
    sub = recordBilling(sub, false);
    sub = recordBilling(sub, false);
    sub = recordBilling(sub, false);
    expect(sub.status).toBe('expired');
    expect(sub.failedBillingCount).toBe(3);

    // Grace period activo (updatedAt justo ahora, dentro de 3 dias)
    expect(isInGracePeriod(sub)).toBe(true);
  });

  // ─── Paso 5: Notificacion email de renovacion ────────────────────────────

  test('Paso 5 — notificacion email renovacion suscripcion', () => {
    let sub = buildSubscriptionRecord(UID, { name: 'Plan Pro', price: 8500, billingCycle: 'monthly' });
    const price = computeSubscriptionPrice(sub);

    const notif = buildNotificationRecord(UID, {
      channel: 'email',
      type: 'payment_overdue',
      priority: 'urgent',
      recipientEmail: 'cliente@example.com',
      recipientName: 'Carlos Garcia',
      subject: 'Renovacion pendiente — Plan Pro',
      body: 'Tu suscripcion Plan Pro requiere renovacion. Monto: ARS ' + price,
    });

    expect(notif.channel).toBe('email');
    expect(notif.priority).toBe('urgent');
    expect(notif.recipientEmail).toBe('cliente@example.com');
    expect(notif.body).toContain(String(price));

    // Fallo primer intento → retry
    const failed1 = applyDispatchResult(notif, { success: false, error: 'SMTP timeout' });
    expect(failed1.status).toBe('pending');
    expect(failed1.attempts).toBe(1);

    // Segundo intento exitoso
    const sent = applyDispatchResult(failed1, { success: true });
    expect(sent.status).toBe('sent');
    expect(sent.attempts).toBe(2);
  });

  // ─── Paso 6: Loyalty tier upgrade + notificacion ─────────────────────────

  test('Paso 6 — loyalty earn → tier upgrade → notificacion WhatsApp', () => {
    // Cuenta en bronze (0 puntos)
    let account = buildLoyaltyAccount(UID, PHONE_CLIENT, { contactName: 'Maria Perez' });
    expect(account.tier).toBe('bronze');

    // Compra que da muchos puntos → upgrade a silver (500+)
    const result = earnPoints(account, 600, { source: 'purchase', orderId: 'order_555' });
    account = result.account;

    expect(account.points).toBe(600);
    expect(account.tier).toBe('silver');
    expect(computeTier(account.totalEarned)).toBe('silver');

    // Notificacion de upgrade
    const notif = buildNotificationRecord(UID, {
      channel: 'whatsapp',
      type: 'custom',
      priority: 'normal',
      recipientPhone: PHONE_CLIENT,
      recipientName: 'Maria Perez',
      body: 'Felicitaciones Maria! Subiste a nivel SILVER. Tenes 600 puntos acumulados.',
      templateVars: { tier: account.tier, points: account.points },
    });

    expect(notif.body).toContain('SILVER');
    expect(notif.templateVars.tier).toBe('silver');

    // Texto del loyalty summary
    const loyaltyText = buildLoyaltySummaryText(account);
    expect(loyaltyText).toContain('GOLD'); // proximo nivel
    expect(loyaltyText).toContain('600');
  });

  // ─── Paso 7: Batch de notificaciones broadcast ───────────────────────────

  test('Paso 7 — batch broadcast a multiples clientes', () => {
    const clients = [
      { phone: '+541155550001', name: 'Maria' },
      { phone: '+541155550002', name: 'Carlos' },
      { phone: '+541155550003', name: 'Ana' },
      { phone: '+541155550004', name: 'Luis' },
      { phone: '+541155550005', name: 'Marta' },
    ];

    const batch = buildBatchNotifications(UID, clients, {
      channel: 'whatsapp',
      type: 'coupon',
      priority: 'normal',
      body: 'Hola {{nombre}}! Tenes un 20% OFF en tu proxima compra.',
      templateVars: { descuento: 20, negocio: 'Tienda Demo' },
    });

    expect(batch.length).toBe(5);
    expect(batch[0].recipientPhone).toBe('+541155550001');
    expect(batch[0].recipientName).toBe('Maria');
    expect(batch[4].recipientName).toBe('Marta');
    expect(batch.every(n => n.channel === 'whatsapp')).toBe(true);
    expect(batch.every(n => n.status === 'pending')).toBe(true);
    // IDs unicos
    const ids = batch.map(n => n.notificationId);
    expect(new Set(ids).size).toBe(5);
  });

  // ─── Paso 8: Summary text de notificacion ────────────────────────────────

  test('Paso 8 — buildNotificationSummaryText legible post-envio', () => {
    const notif = buildNotificationRecord(UID, {
      channel: 'whatsapp',
      type: 'appointment_reminder',
      priority: 'high',
      recipientName: 'Juan Lopez',
      recipientPhone: PHONE_CLIENT,
      body: 'Tu turno es manana a las 10hs.',
    });
    const sent = applyDispatchResult(notif, { success: true });
    const delivered = markDelivered(sent);
    const text = buildNotificationSummaryText(delivered);

    expect(text).toContain('WHATSAPP');
    expect(text).toContain('Juan Lopez');
    expect(text).toContain('delivered');
    expect(text).toContain('appointment_reminder');
  });

  // ─── Pipeline completo integrado ─────────────────────────────────────────

  test('Pipeline completo — reporte + KPI + notif + suscripcion + loyalty + batch', () => {
    // A. Reporte de ventas
    const salesData = buildSalesReport([
      { amount: 10000, productName: 'X', date: '2026-05-01' },
      { amount: 5500, productName: 'Y', date: '2026-05-15' },
    ]);
    expect(salesData.totalRevenue).toBeCloseTo(15500);

    // B. KPI
    const kpi = computeKpiSummary({ revenue: 15500, prevRevenue: 10000, leads: 50, conversions: 15 });
    expect(kpi.revenueGrowth).toBe(55);
    expect(kpi.conversionRate).toBe(30);

    // C. Notificacion push al owner
    const ownerNotif = buildNotificationRecord(UID, {
      channel: 'push',
      priority: 'high',
      recipientPhone: PHONE_OWNER,
      body: 'KPI: revenue +55%',
    });
    const ownerSent = applyDispatchResult(ownerNotif, { success: true });
    expect(ownerSent.status).toBe('sent');

    // D. Suscripcion activa
    const sub = buildSubscriptionRecord(UID, { name: 'Pro', price: 8500, billingCycle: 'monthly' });
    expect(sub.status).toBe('active');
    const price = computeSubscriptionPrice(sub);
    expect(price).toBe(8500);

    // E. Loyalty earn
    let account = buildLoyaltyAccount(UID, PHONE_CLIENT, {});
    const earned = earnPoints(account, 2100, { source: 'purchase' });
    account = earned.account;
    expect(account.tier).toBe('gold'); // 2100 > 2000 threshold gold

    // F. Notificacion tier upgrade
    const tierNotif = buildNotificationRecord(UID, {
      channel: 'whatsapp',
      priority: 'normal',
      recipientPhone: PHONE_CLIENT,
      body: 'Subiste a GOLD!',
    });
    expect(tierNotif.status).toBe('pending');

    // G. Batch broadcast
    const batch = buildBatchNotifications(UID, [
      { phone: PHONE_CLIENT, name: 'Client 1' },
      { phone: '+541155550099', name: 'Client 2' },
    ], { channel: 'email', type: 'broadcast', priority: 'low' });
    expect(batch.length).toBe(2);
    expect(batch.every(n => n.channel === 'email')).toBe(true);

    // H. Reporte text
    const report = buildReportRecord(UID, { type: 'kpi_summary', period: 'monthly' });
    const reportReady = applyReportData(report, kpi, 0);
    const text = buildReportText(reportReady);
    expect(text).toContain('kpi_summary');
    expect(text).toContain('+55%');
  });
});
