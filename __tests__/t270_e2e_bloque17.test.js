'use strict';

// T270 E2E Bloque 17: analytics_engine + integration_hub + payment_processor + inventory_tracker
const {
  buildMetricRecord, buildReportRecord, aggregateMetrics, computeKPIs,
  buildInsights, saveMetric, saveReport, getReport, listMetrics, buildReportText,
  __setFirestoreForTests: setAnalytics,
} = require('../core/analytics_engine');

const {
  buildIntegrationRecord, buildWebhookPayload, validateWebhookPayload,
  filterEventsForIntegration, buildEventRecord, saveIntegration, getIntegration,
  updateIntegrationStatus, listIntegrations, saveEvent, listPendingEvents,
  buildIntegrationSummaryText,
  __setFirestoreForTests: setIntegration,
} = require('../core/integration_hub');

const {
  buildPaymentRecord, validatePaymentData, computePaymentTotal,
  savePayment, getPayment, updatePaymentStatus, computePaymentSummary,
  buildPaymentText,
  __setFirestoreForTests: setPayment,
} = require('../core/payment_processor');

const {
  buildInventoryRecord, buildMovementRecord, applyMovement,
  computeAvailableQuantity, checkStockAlerts,
  saveInventory, getInventory, updateInventoryQuantity,
  buildInventoryText,
  __setFirestoreForTests: setInventory,
} = require('../core/inventory_tracker');

const UID = 'bloque17Uid';
const NOW = Date.now();

function makeMockDb({ stored = {}, metStored = {}, evtStored = {}, movStored = {}, throwGet = false, throwSet = false } = {}) {
  const dbs = { stored, metStored, evtStored, movStored };
  function getStore(subCol) {
    if (subCol === 'metrics') return dbs.metStored;
    if (subCol === 'integration_events') return dbs.evtStored;
    if (subCol === 'inventory_movements') return dbs.movStored;
    return dbs.stored;
  }
  return {
    collection: () => ({
      doc: () => ({
        collection: (subCol) => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              const s = getStore(subCol);
              s[id] = opts && opts.merge ? { ...(s[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              const s = getStore(subCol);
              return { exists: !!s[id], data: () => s[id] };
            },
          }),
          where: (field, op, val) => ({
            where: (f2, o2, v2) => ({
              get: async () => {
                if (throwGet) throw new Error('get error');
                const s = getStore(subCol);
                const entries = Object.values(s).filter(d => {
                  if (!d) return false;
                  let ok = d[field] === val;
                  if (ok) ok = ok && d[f2] === v2;
                  return ok;
                });
                return { empty: entries.length === 0, forEach: fn => entries.forEach(d => fn({ data: () => d })) };
              },
            }),
            get: async () => {
              if (throwGet) throw new Error('get error');
              const s = getStore(subCol);
              const entries = Object.values(s).filter(d => d && d[field] === val);
              return { empty: entries.length === 0, forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            const s = getStore(subCol);
            return { empty: Object.keys(s).length === 0, forEach: fn => Object.values(s).forEach(d => fn({ data: () => d })) };
          },
        }),
      }),
    }),
  };
}

function setAll(db) {
  setAnalytics(db);
  setIntegration(db);
  setPayment(db);
  setInventory(db);
}

beforeEach(() => setAll(null));
afterEach(() => setAll(null));

// ─── ANALYTICS ENGINE ─────────────────────────────────────────────────────────
describe('analytics_engine — bloque 17', () => {
  test('buildMetricRecord crea metrica valida con date y period', () => {
    const m = buildMetricRecord(UID, 'payments_received', 5, { date: '2026-05-01', period: 'day' });
    expect(m.uid).toBe(UID);
    expect(m.metricType).toBe('payments_received');
    expect(m.value).toBe(5);
    expect(m.date).toBe('2026-05-01');
    expect(m.period).toBe('day');
    expect(m.metricId).toContain('metric_');
  });

  test('saveMetric + listMetrics round-trip', async () => {
    const db = makeMockDb();
    setAll(db);
    const m1 = buildMetricRecord(UID, 'leads_created', 10, { date: '2026-05-01' });
    const m2 = buildMetricRecord(UID, 'leads_created', 7, { date: '2026-05-02' });
    await saveMetric(UID, m1);
    await saveMetric(UID, m2);
    setAll(db);
    const results = await listMetrics(UID, { metricType: 'leads_created' });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test('aggregateMetrics computa sum avg min max', () => {
    const metrics = [
      buildMetricRecord(UID, 'revenue_total', 1000),
      buildMetricRecord(UID, 'revenue_total', 2000),
      buildMetricRecord(UID, 'revenue_total', 500),
    ];
    const agg = aggregateMetrics(metrics, { type: 'revenue_total' });
    expect(agg.sum).toBe(3500);
    expect(agg.min).toBe(500);
    expect(agg.max).toBe(2000);
    expect(agg.count).toBe(3);
    expect(agg.avg).toBeCloseTo(1166.67, 1);
  });

  test('computeKPIs calcula conversionRate y revenuePerLead', () => {
    const kpis = computeKPIs({ leads: 100, converted: 25, revenue: 50000, messages: 300, appointments: 40 });
    expect(kpis.conversionRate).toBe(25);
    expect(kpis.revenuePerLead).toBe(500);
    expect(kpis.revenuePerConversion).toBe(2000);
    expect(kpis.messagesPerLead).toBe(3);
  });

  test('buildInsights genera warning si conversionRate baja', () => {
    const kpis = computeKPIs({ leads: 100, converted: 5, revenue: 1000 });
    const insights = buildInsights(kpis, { minConversionRate: 10 });
    expect(insights.some(i => i.type === 'warning' && i.message.includes('baja'))).toBe(true);
  });

  test('buildReportRecord + saveReport + getReport round-trip', async () => {
    const db = makeMockDb();
    setAll(db);
    const r = buildReportRecord(UID, 'monthly', {
      date: '2026-05-01',
      title: 'Reporte Mayo 2026',
      summary: { leads: 50, converted: 12, revenue: 30000, conversionRate: 24 },
      insights: [{ type: 'positive', message: 'Mes excelente' }],
    });
    await saveReport(UID, r);
    setAll(db);
    const loaded = await getReport(UID, r.reportId);
    expect(loaded).not.toBeNull();
    expect(loaded.title).toBe('Reporte Mayo 2026');
    expect(loaded.summary.revenue).toBe(30000);
  });

  test('buildReportText incluye insights', () => {
    const r = buildReportRecord(UID, 'daily', {
      date: '2026-05-01',
      summary: { leads: 10, converted: 3, revenue: 5000, conversionRate: 30 },
      insights: [{ type: 'positive', message: 'Conversion excelente' }],
    });
    const text = buildReportText(r);
    expect(text).toContain('daily');
    expect(text).toContain('Insights');
    expect(text).toContain('Conversion excelente');
  });
});

// ─── INTEGRATION HUB ─────────────────────────────────────────────────────────
describe('integration_hub — bloque 17', () => {
  test('buildIntegrationRecord defaults correctos', () => {
    const integ = buildIntegrationRecord(UID, { type: 'webhook', name: 'Mi Webhook', webhookUrl: 'https://example.com/hook' });
    expect(integ.uid).toBe(UID);
    expect(integ.type).toBe('webhook');
    expect(integ.status).toBe('inactive');
    expect(integ.webhookMethod).toBe('POST');
    expect(integ.retryAttempts).toBe(0);
  });

  test('saveIntegration + getIntegration round-trip', async () => {
    const db = makeMockDb();
    setAll(db);
    const integ = buildIntegrationRecord(UID, { type: 'mercadopago', name: 'MP Pagos', status: 'active' });
    await saveIntegration(UID, integ);
    setAll(db);
    const loaded = await getIntegration(UID, integ.integrationId);
    expect(loaded).not.toBeNull();
    expect(loaded.type).toBe('mercadopago');
    expect(loaded.name).toBe('MP Pagos');
  });

  test('updateIntegrationStatus cambia a error con lastErrorAt', async () => {
    const db = makeMockDb();
    setAll(db);
    const integ = buildIntegrationRecord(UID, { type: 'stripe', name: 'Stripe', status: 'active' });
    await saveIntegration(UID, integ);
    setAll(db);
    await updateIntegrationStatus(UID, integ.integrationId, 'error', { lastError: 'Connection refused' });
    setAll(db);
    const loaded = await getIntegration(UID, integ.integrationId);
    expect(loaded.status).toBe('error');
    expect(loaded.lastErrorAt).toBeDefined();
    expect(loaded.lastError).toBe('Connection refused');
  });

  test('buildWebhookPayload + validateWebhookPayload valido', () => {
    const payload = buildWebhookPayload('payment_confirmed', { amount: 1000, currency: 'ARS' }, { uid: UID });
    const result = validateWebhookPayload(payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('filterEventsForIntegration filtra por subscribedEvents', () => {
    const integ = buildIntegrationRecord(UID, { subscribedEvents: ['payment_confirmed', 'lead_created'] });
    const events = [
      { event: 'payment_confirmed', data: {} },
      { event: 'appointment_booked', data: {} },
      { event: 'lead_created', data: {} },
    ];
    const filtered = filterEventsForIntegration(integ, events);
    expect(filtered.length).toBe(2);
    expect(filtered.map(e => e.event)).toContain('payment_confirmed');
    expect(filtered.map(e => e.event)).toContain('lead_created');
  });

  test('saveEvent + listPendingEvents', async () => {
    const db = makeMockDb();
    setAll(db);
    const evt = buildEventRecord(UID, 'payment_confirmed', { amount: 500 }, { integrationIds: ['integ_001'] });
    await saveEvent(UID, evt);
    setAll(db);
    const pending = await listPendingEvents(UID);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending[0].type).toBe('payment_confirmed');
    expect(pending[0].dispatched).toBe(false);
  });

  test('buildIntegrationSummaryText incluye nombre y estado', () => {
    const integ = buildIntegrationRecord(UID, {
      type: 'webhook', name: 'Webhook Zapier', status: 'active',
      webhookUrl: 'https://hooks.zapier.com/1234',
      subscribedEvents: ['payment_confirmed', 'lead_created'],
    });
    const text = buildIntegrationSummaryText(integ);
    expect(text).toContain('Webhook Zapier');
    expect(text).toContain('active');
  });
});

// ─── PAYMENT PROCESSOR ────────────────────────────────────────────────────────
describe('payment_processor — bloque 17', () => {
  test('computePaymentTotal con tax y discount', () => {
    const p = buildPaymentRecord(UID, { amount: 1000, taxAmount: 100, discountAmount: 200 });
    expect(computePaymentTotal(p)).toBe(900);
  });

  test('validatePaymentData acepta ARS y USD', () => {
    expect(validatePaymentData({ amount: 100, currency: 'ARS' }).valid).toBe(true);
    expect(validatePaymentData({ amount: 100, currency: 'USD' }).valid).toBe(true);
  });

  test('listPayments filtra por status', async () => {
    const db = makeMockDb();
    setAll(db);
    const p1 = buildPaymentRecord(UID, { amount: 500, status: 'confirmed', paymentId: 'pay_a' });
    const p2 = buildPaymentRecord(UID, { amount: 200, status: 'pending', paymentId: 'pay_b' });
    await savePayment(UID, p1);
    await savePayment(UID, p2);
    setAll(db);
    const { listPayments } = require('../core/payment_processor');
    const confirmed = await listPayments(UID, { status: 'confirmed' });
    const hasConfirmed = confirmed.some(p => p.paymentId === 'pay_a');
    expect(hasConfirmed).toBe(true);
  });

  test('computePaymentSummary multiplePayments', () => {
    const payments = [
      buildPaymentRecord(UID, { amount: 1000, status: 'confirmed' }),
      buildPaymentRecord(UID, { amount: 2000, status: 'confirmed' }),
      buildPaymentRecord(UID, { amount: 500, status: 'failed' }),
      buildPaymentRecord(UID, { amount: 300, status: 'pending' }),
    ];
    const s = computePaymentSummary(payments);
    expect(s.total).toBe(3000);
    expect(s.confirmed).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.pending).toBe(1);
  });
});

// ─── INVENTORY TRACKER ────────────────────────────────────────────────────────
describe('inventory_tracker — bloque 17', () => {
  test('applyMovement adjustment establece cantidad absoluta', () => {
    const inv = buildInventoryRecord(UID, 'prod_x', { quantity: 30 });
    const m = buildMovementRecord(UID, 'prod_x', 'adjustment', 15);
    const updated = applyMovement(inv, m);
    expect(updated.quantity).toBe(15);
  });

  test('computeAvailableQuantity descuenta reservedQuantity', () => {
    const inv = buildInventoryRecord(UID, 'prod_x', { quantity: 30, reservedQuantity: 5 });
    expect(computeAvailableQuantity(inv)).toBe(25);
  });

  test('checkStockAlerts detecta out_of_stock', () => {
    const inv = buildInventoryRecord(UID, 'prod_x', { quantity: 0, lowStockThreshold: 5 });
    const alerts = checkStockAlerts(inv);
    expect(alerts.some(a => a.type === 'out_of_stock')).toBe(true);
  });

  test('buildInventoryText stock OK no alerta', () => {
    const inv = buildInventoryRecord(UID, 'prod_ok', { quantity: 100, productName: 'Producto OK', unit: 'unidades' });
    const text = buildInventoryText(inv);
    expect(text).toContain('Producto OK');
    expect(text).toContain('100');
    expect(text).toContain('OK');
  });
});

// ─── PIPELINE INTEGRADO: PISO 4 COMPLETO ─────────────────────────────────────
describe('Pipeline P5: analytics + integrations + payments + inventory (Piso 4 completo)', () => {
  test('flujo Piso 4 — pago confirmado dispara evento webhook y actualiza metricas', async () => {
    const db = makeMockDb();
    setAll(db);

    // 1. Crear integracion webhook activa suscrita a payment_confirmed
    const integration = buildIntegrationRecord(UID, {
      type: 'webhook',
      name: 'ERP Externo',
      status: 'active',
      webhookUrl: 'https://erp.example.com/webhook',
      subscribedEvents: ['payment_confirmed', 'inventory_low'],
    });
    await saveIntegration(UID, integration);

    // 2. Crear inventario del producto
    const inventory = buildInventoryRecord(UID, 'prod_serv', {
      quantity: 10, productName: 'Turno Premium', unit: 'turno',
    });
    setAll(db);
    await saveInventory(UID, inventory);

    // 3. Registrar pago
    const payment = buildPaymentRecord(UID, {
      amount: 1500, currency: 'ARS', method: 'transfer',
      contactPhone: '+5491155550001', contactName: 'Laura',
      paymentId: 'pay_piso4_001',
    });
    const validation = validatePaymentData({ amount: payment.amount, currency: payment.currency });
    expect(validation.valid).toBe(true);
    setAll(db);
    await savePayment(UID, payment);

    // 4. Confirmar pago
    setAll(db);
    await updatePaymentStatus(UID, 'pay_piso4_001', 'confirmed');
    setAll(db);
    const confirmedPayment = await getPayment(UID, 'pay_piso4_001');
    expect(confirmedPayment.status).toBe('confirmed');
    expect(confirmedPayment.confirmedAt).toBeDefined();

    // 5. Construir payload webhook y validarlo
    const webhookPayload = buildWebhookPayload('payment_confirmed', {
      paymentId: confirmedPayment.paymentId,
      amount: confirmedPayment.amount,
      currency: confirmedPayment.currency,
    }, { uid: UID });
    const webhookValidation = validateWebhookPayload(webhookPayload);
    expect(webhookValidation.valid).toBe(true);

    // 6. Filtrar integraciones suscritas al evento
    setAll(db);
    const integrations = await listIntegrations(UID, { status: 'active' });
    const eligible = integrations.filter(i =>
      i.subscribedEvents && i.subscribedEvents.includes('payment_confirmed')
    );
    expect(eligible.length).toBe(1);
    expect(eligible[0].name).toBe('ERP Externo');

    // 7. Guardar evento de integracion
    const eventRecord = buildEventRecord(UID, 'payment_confirmed', webhookPayload, {
      integrationIds: eligible.map(i => i.integrationId),
    });
    setAll(db);
    await saveEvent(UID, eventRecord);

    // 8. Verificar eventos pendientes de despacho
    setAll(db);
    const pending = await listPendingEvents(UID);
    expect(pending.some(e => e.type === 'payment_confirmed')).toBe(true);

    // 9. Descontar inventario (out)
    setAll(db);
    const currentInv = await getInventory(UID, 'prod_serv');
    const outMov = buildMovementRecord(UID, 'prod_serv', 'out', 1, { referenceId: 'pay_piso4_001' });
    const updatedInv = applyMovement(currentInv, outMov);
    expect(updatedInv.quantity).toBe(9);
    setAll(db);
    await updateInventoryQuantity(UID, 'prod_serv', updatedInv.quantity);

    // 10. Verificar stock final y alertas
    setAll(db);
    const finalInv = await getInventory(UID, 'prod_serv');
    expect(finalInv.quantity).toBe(9);
    const alerts = checkStockAlerts(finalInv);
    expect(alerts).toHaveLength(0);

    // 11. Registrar metricas del evento
    const metricPayment = buildMetricRecord(UID, 'payments_received', 1, { date: '2026-05-01' });
    const metricRevenue = buildMetricRecord(UID, 'revenue_total', confirmedPayment.amount, { date: '2026-05-01' });
    setAll(db);
    await saveMetric(UID, metricPayment);
    await saveMetric(UID, metricRevenue);

    // 12. Generar reporte diario con KPIs
    const kpis = computeKPIs({ leads: 20, converted: 5, revenue: 1500, messages: 60, appointments: 8 });
    expect(kpis.conversionRate).toBe(25);
    expect(kpis.revenuePerLead).toBe(75);

    const insights = buildInsights(kpis, { minConversionRate: 10, minRevenuePerLead: 100 });
    expect(insights.length).toBeGreaterThanOrEqual(1);

    const report = buildReportRecord(UID, 'daily', {
      date: '2026-05-01',
      title: 'Reporte Piso 4 — 2026-05-01',
      summary: { leads: kpis.leads, converted: kpis.converted, revenue: kpis.revenue, conversionRate: kpis.conversionRate },
      insights,
    });
    setAll(db);
    await saveReport(UID, report);
    setAll(db);
    const loadedReport = await getReport(UID, report.reportId);
    expect(loadedReport).not.toBeNull();
    expect(loadedReport.summary.conversionRate).toBe(25);

    // 13. Texto final del reporte
    const reportText = buildReportText(loadedReport);
    expect(reportText).toContain('Piso 4');
    expect(reportText).toContain('25');

    // 14. Texto del pago confirmado
    const payText = buildPaymentText(confirmedPayment);
    expect(payText).toContain('1500');
    expect(payText).toContain('Laura');

    // 15. Texto del inventario final
    const invText = buildInventoryText(finalInv);
    expect(invText).toContain('9');
    expect(invText).toContain('OK');

    // 16. Resumen de la integracion
    const integText = buildIntegrationSummaryText(integration);
    expect(integText).toContain('ERP Externo');
    expect(integText).toContain('active');
  });
});
