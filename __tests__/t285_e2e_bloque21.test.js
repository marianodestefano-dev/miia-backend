'use strict';

/**
 * T285 — E2E Bloque 21
 * Pipeline: template renderizado → campana broadcast Black Friday → batch notificaciones →
 * recordSend metricas → campana drip onboarding 3 pasos → reporte campanas → summary texts
 */

const {
  buildCampaignRecord,
  buildCampaignWithDripSteps,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  completeCampaign,
  recordSend,
  computeCampaignStats,
  buildCampaignSummaryText,
  __setFirestoreForTests: setCampDb,
} = require('../core/campaign_engine');

const {
  buildNotificationRecord,
  buildBatchNotifications,
  applyDispatchResult,
  buildNotificationSummaryText,
  __setFirestoreForTests: setNotifDb,
} = require('../core/notification_center');

const {
  buildTemplateRecord,
  renderTemplate,
  buildDefaultTemplates,
  __setFirestoreForTests: setTplDb,
} = require('../core/template_engine');

const {
  buildReportRecord,
  buildSalesReport,
  applyReportData,
  buildReportText,
  __setFirestoreForTests: setRepDb,
} = require('../core/report_engine');

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

const UID = 'owner_bloque21_001';

describe('T285 — E2E Bloque 21: campaign + notif + template + report', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setCampDb(mock.db);
    setNotifDb(mock.db);
    setTplDb(mock.db);
    setRepDb(mock.db);
  });

  // ─── Paso 1: Template Black Friday renderizado ────────────────────────────

  test('Paso 1 — template cupon renderizado para campana Black Friday', () => {
    const templates = buildDefaultTemplates(UID);
    const couponTpl = templates.find(t => t.type === 'coupon');
    expect(couponTpl).toBeDefined();

    const rendered = renderTemplate(couponTpl, {
      nombre: 'Maria',
      descuento: 30,
      negocio: 'Tienda Demo',
      codigo: 'BF30',
      vencimiento: '2026-11-30',
    });

    expect(rendered.complete).toBe(true);
    expect(rendered.rendered).toContain('Maria');
    expect(rendered.rendered).toContain('30');
    expect(rendered.rendered).toContain('BF30');
    expect(rendered.rendered).toContain('Tienda Demo');
    expect(rendered.missing.length).toBe(0);
  });

  // ─── Paso 2: Template con variables faltantes ─────────────────────────────

  test('Paso 2 — template con variables parciales detecta missing', () => {
    const tpl = buildTemplateRecord(UID, {
      name: 'Promo especial',
      type: 'promotional',
      body: 'Hola {{nombre}}! Tu descuento es {{descuento}}% con codigo {{codigo}} hasta {{fecha}}.',
      channel: 'whatsapp',
    });

    const rendered = renderTemplate(tpl, { nombre: 'Luis', codigo: 'PROMO10' });
    expect(rendered.complete).toBe(false);
    expect(rendered.missing).toContain('descuento');
    expect(rendered.missing).toContain('fecha');
    expect(rendered.rendered).toContain('Luis');
    expect(rendered.rendered).toContain('PROMO10');
  });

  // ─── Paso 3: Campana broadcast Black Friday ───────────────────────────────

  test('Paso 3 — campana broadcast creada y lanzada', () => {
    const campaign = buildCampaignRecord(UID, {
      name: 'Black Friday 2026',
      type: 'broadcast',
      channel: 'whatsapp',
      tags: ['black-friday', 'promo'],
    });

    expect(campaign.status).toBe('draft');
    expect(campaign.type).toBe('broadcast');

    // Lanzar con audiencia de 1500
    const active = startCampaign(campaign, 1500);
    expect(active.status).toBe('active');
    expect(active.audienceSize).toBe(1500);
    expect(active.startedAt).toBeGreaterThan(0);
  });

  // ─── Paso 4: Batch de notificaciones para la campana ─────────────────────

  test('Paso 4 — batch de 5 notificaciones whatsapp generadas', () => {
    const recipients = [
      { phone: '+541155550001', name: 'Ana Garcia' },
      { phone: '+541155550002', name: 'Luis Martinez' },
      { phone: '+541155550003', name: 'Marta Lopez' },
      { phone: '+541155550004', name: 'Pedro Gomez' },
      { phone: '+541155550005', name: 'Sofia Ruiz' },
    ];

    const batch = buildBatchNotifications(UID, recipients, {
      channel: 'whatsapp',
      type: 'coupon',
      priority: 'normal',
      body: 'Hola! 30% OFF Black Friday. Codigo: BF30.',
    });

    expect(batch.length).toBe(5);
    expect(batch[0].recipientPhone).toBe('+541155550001');
    expect(batch[4].recipientName).toBe('Sofia Ruiz');
    expect(batch.every(n => n.status === 'pending')).toBe(true);

    // Simular envio exitoso de todos
    const sent = batch.map(n => applyDispatchResult(n, { success: true }));
    expect(sent.every(n => n.status === 'sent')).toBe(true);
    expect(sent.every(n => n.sentAt > 0)).toBe(true);
  });

  // ─── Paso 5: Registrar envios en la campana ───────────────────────────────

  test('Paso 5 — recordSend acumula metricas de campana', () => {
    let c = startCampaign(buildCampaignRecord(UID, { type: 'broadcast' }), 1500);

    // Simular 1000 envios: 900 entregados, 50 errores
    for (let i = 0; i < 950; i++) {
      c = recordSend(c, { delivered: i < 900 });
    }
    for (let i = 0; i < 50; i++) {
      c = recordSend(c, { error: true, delivered: false });
    }

    expect(c.sentCount).toBe(1000);
    expect(c.deliveredCount).toBe(900);
    expect(c.errorCount).toBe(50);

    const stats = computeCampaignStats(c);
    expect(stats.sentRate).toBe(67); // 1000/1500
    expect(stats.deliveryRate).toBe(90); // 900/1000
    expect(stats.errorRate).toBe(5); // 50/1000
  });

  // ─── Paso 6: Campana drip de onboarding ──────────────────────────────────

  test('Paso 6 — campana drip de 3 pasos para onboarding', () => {
    const campaign = buildCampaignWithDripSteps(UID, {
      name: 'Onboarding nuevos clientes',
      channel: 'whatsapp',
    }, [
      { delayMs: 3600000, body: 'Bienvenido! Aqui te contamos como empezar.' },
      { delayMs: 86400000, body: 'Dia 2: Tips para aprovechar al maximo MIIA.' },
      { delayMs: 259200000, body: 'Dia 4: Ya llevamos juntos 4 dias. Como te fue?' },
    ]);

    expect(campaign.type).toBe('drip');
    expect(campaign.steps.length).toBe(3);
    expect(campaign.steps[0].delayMs).toBe(3600000);
    expect(campaign.steps[1].body).toContain('Tips');
    expect(campaign.steps[2].stepIndex).toBe(2);

    const started = startCampaign(campaign, 80);
    expect(started.status).toBe('active');
    expect(started.steps.length).toBe(3);

    // Pausa y reanuda
    const paused = pauseCampaign(started);
    expect(paused.status).toBe('paused');
    const resumed = resumeCampaign(paused);
    expect(resumed.status).toBe('active');

    // Completa
    const completed = completeCampaign(resumed);
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBeGreaterThan(0);
  });

  // ─── Paso 7: Reporte de ventas de la campana ─────────────────────────────

  test('Paso 7 — reporte de ventas generado post-campana', () => {
    const report = buildReportRecord(UID, {
      type: 'sales',
      period: 'custom',
      from: Date.now() - 86400000,
      to: Date.now(),
      title: 'Ventas Black Friday',
      currency: 'ARS',
    });

    const salesData = buildSalesReport([
      { amount: 15000, productName: 'Camiseta BF', quantity: 3, date: '2026-05-01' },
      { amount: 8000, productName: 'Pantalon BF', quantity: 2, date: '2026-05-01' },
      { amount: 22000, productName: 'Camiseta BF', quantity: 4, date: '2026-05-01' },
    ]);

    const ready = applyReportData(report, salesData, 3);
    expect(ready.status).toBe('ready');
    expect(ready.data.totalRevenue).toBeCloseTo(45000);
    expect(ready.data.totalTransactions).toBe(3);
    expect(ready.data.topProducts[0].name).toBe('Camiseta BF');

    const text = buildReportText(ready);
    expect(text).toContain('Ventas Black Friday');
    expect(text).toContain('Transacciones: 3');
  });

  // ─── Paso 8: Summary texts ────────────────────────────────────────────────

  test('Paso 8 — summary texts de campana y notificacion', () => {
    // Campaign summary
    let campaign = buildCampaignRecord(UID, { name: 'BF 2026', type: 'broadcast', channel: 'email' });
    campaign = startCampaign(campaign, 2000);
    campaign = recordSend(campaign, { delivered: true });
    campaign = recordSend(campaign, { delivered: true });

    const campText = buildCampaignSummaryText(campaign);
    expect(campText).toContain('BF 2026');
    expect(campText).toContain('broadcast');
    expect(campText).toContain('2000');

    // Notification summary
    const notif = buildNotificationRecord(UID, {
      channel: 'email',
      type: 'coupon',
      priority: 'high',
      recipientName: 'Carlos Lopez',
      recipientEmail: 'carlos@example.com',
      subject: 'Tu cupon Black Friday',
    });
    const sent = applyDispatchResult(notif, { success: true });
    const notifText = buildNotificationSummaryText(sent);
    expect(notifText).toContain('EMAIL');
    expect(notifText).toContain('Carlos Lopez');
    expect(notifText).toContain('sent');
  });

  // ─── Pipeline completo integrado ─────────────────────────────────────────

  test('Pipeline completo — template + broadcast + drip + notif batch + reporte', () => {
    // A. Template cupon
    const templates = buildDefaultTemplates(UID);
    const couponTpl = templates.find(t => t.type === 'coupon');
    const { rendered, complete } = renderTemplate(couponTpl, {
      nombre: 'Cliente X',
      descuento: 25,
      negocio: 'Demo Store',
      codigo: 'X25',
      vencimiento: '2026-12-31',
    });
    expect(complete).toBe(true);
    expect(rendered).toContain('25');

    // B. Campana broadcast
    let campaign = buildCampaignRecord(UID, {
      name: 'Flash Sale',
      type: 'broadcast',
      channel: 'whatsapp',
    });
    campaign = startCampaign(campaign, 300);
    expect(campaign.audienceSize).toBe(300);

    // C. Batch notificaciones
    const batch = buildBatchNotifications(UID, [
      { phone: '+541155550001', name: 'A' },
      { phone: '+541155550002', name: 'B' },
      { phone: '+541155550003', name: 'C' },
    ], { channel: 'whatsapp', type: 'coupon', body: rendered });
    expect(batch.length).toBe(3);

    // D. Registrar envios
    const batchSent = batch.map(n => applyDispatchResult(n, { success: true }));
    batchSent.forEach(() => { campaign = recordSend(campaign, { delivered: true }); });
    expect(campaign.sentCount).toBe(3);
    expect(campaign.deliveredCount).toBe(3);

    // E. Campana drip onboarding en paralelo
    const drip = buildCampaignWithDripSteps(UID, { name: 'Onboarding' }, [
      { delayMs: 3600000, body: 'Paso 1' },
      { delayMs: 86400000, body: 'Paso 2' },
    ]);
    const dripStarted = startCampaign(drip, 50);
    expect(dripStarted.steps.length).toBe(2);

    // F. Reporte final
    const report = buildReportRecord(UID, { type: 'sales', period: 'daily' });
    const salesData = buildSalesReport([{ amount: 5000, date: '2026-05-01' }]);
    const ready = applyReportData(report, salesData, 1);
    expect(ready.data.totalRevenue).toBe(5000);

    const stats = computeCampaignStats(campaign);
    expect(stats.sentRate).toBe(1); // 3/300 (solo 3 enviados del batch de demo)
    expect(stats.deliveryRate).toBe(100); // 3/3
  });
});
