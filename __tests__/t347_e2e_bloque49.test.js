'use strict';

/**
 * T347 -- E2E Bloque 49
 * Pipeline: contact_spam_detector -> growth_tracker -> webhook_dispatcher
 */

const {
  analyzeContact, buildSpamAlertMessage, detectKeywords,
  __setFirestoreForTests: setSpamDb,
} = require('../core/contact_spam_detector');

const {
  recordGrowthEvent, getGrowthPeriod, calculateConversionRate,
  __setFirestoreForTests: setGrowthDb,
} = require('../core/growth_tracker');

const {
  buildDispatchRecord, buildDispatchResult, shouldRetry, computeBackoffMs,
  MAX_RETRY_ATTEMPTS,
} = require('../core/webhook_dispatcher');

const UID = 'owner_bloque49_001';
const PHONE = '+5711112222';

function makeDb() {
  const store = {};
  return {
    collection: (col) => ({
      doc: (uid) => ({
        collection: (subCol) => ({
          doc: (docId) => ({
            set: async (data, opts) => {
              const key = `${col}/${uid}/${subCol}/${docId}`;
              if (opts && opts.merge) store[key] = { ...(store[key] || {}), ...data };
              else store[key] = { ...data };
            },
            get: async () => {
              const key = `${col}/${uid}/${subCol}/${docId}`;
              const d = store[key];
              return { exists: !!d, data: () => d };
            },
          }),
        }),
      }),
    }),
  };
}

describe('T347 -- E2E Bloque 49: contact_spam_detector + growth_tracker + webhook_dispatcher', () => {

  beforeEach(() => {
    const db = makeDb();
    setSpamDb(db);
    setGrowthDb(db);
  });

  test('Paso 1 -- contacto limpio detectado como low severity', () => {
    const r = analyzeContact(PHONE, [
      { text: 'Hola quiero saber sobre sus productos', timestamp: new Date().toISOString() },
    ], {});
    expect(r.severity).toBe('low');
    expect(r.isSpam).toBe(false);
  });

  test('Paso 2 -- contacto con keywords spam detectado', () => {
    const msgs = [{ text: 'ganaste premio gratis click aqui urgente', timestamp: new Date().toISOString() }];
    const r = analyzeContact(PHONE, msgs, {});
    expect(r.signals).toContain('keyword_match');
  });

  test('Paso 3 -- alerta de spam generada con formato correcto', () => {
    const analysis = { severity: 'medium', reasons: ['Keywords spam detectadas: ganaste, premio'] };
    const alert = buildSpamAlertMessage(PHONE, analysis);
    expect(alert).toContain(PHONE);
    expect(alert).toContain('AVISO');
  });

  test('Paso 4 -- registrar nuevo lead en growth tracker', async () => {
    await recordGrowthEvent(UID, 'new_leads', 1, 'daily');
    // No error = exito
  });

  test('Paso 5 -- tasa de conversion calculada', () => {
    const rate = calculateConversionRate(50, 12);
    expect(rate).toBe(24.0);
  });

  test('Paso 6 -- webhook dispatch configurado correctamente', () => {
    const record = buildDispatchRecord('integration_crm', 'event_lead_001', {
      webhookUrl: 'https://crm.example.com/webhook',
      payload: { phone: PHONE, event: 'new_lead' },
    });
    expect(record.status).toBe('pending');
    expect(record.attempts).toBe(0);
    expect(record.maxAttempts).toBe(MAX_RETRY_ATTEMPTS);
    expect(shouldRetry(record)).toBe(true);
  });

  test('Pipeline completo -- spam detection + growth + webhook', async () => {
    // A: Analizar contacto entrante
    const msgs = [
      { text: 'Hola quiero informacion sobre sus servicios', timestamp: new Date().toISOString() },
    ];
    const analysis = analyzeContact(PHONE, msgs, { isUnknown: true });
    expect(analysis.signals).toContain('unknown_number');

    // B: Registrar como nuevo lead en growth tracker
    await recordGrowthEvent(UID, 'new_leads', 1, 'daily');

    // C: Calcular tasa de conversion semanal
    const rate = calculateConversionRate(20, 5);
    expect(rate).toBe(25.0);

    // D: Configurar webhook para notificar CRM externo
    const record = buildDispatchRecord('crm_integration', 'new_lead_' + Date.now().toString(36), {
      webhookUrl: 'https://crm.example.com/hooks/leads',
      payload: { phone: PHONE, source: 'whatsapp', event: 'new_lead' },
    });
    expect(record.status).toBe('pending');

    // E: Simular fallo de webhook, verificar backoff
    const failResult = buildDispatchResult(false, 500, null, 'Server error');
    expect(failResult.ok).toBe(false);
    record.attempts = 1;
    expect(shouldRetry(record)).toBe(true);
    const backoff = computeBackoffMs(1);
    expect(backoff).toBe(2000);

    // F: Segundo intento exitoso
    const okResult = buildDispatchResult(true, 200, '{"received":true}', null);
    expect(okResult.ok).toBe(true);
  });
});
