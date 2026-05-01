'use strict';

/**
 * T353 -- E2E Bloque 52
 * Pipeline: intent_classifier -> lead_scorer -> dynamic_pricing_engine
 */

const { classifyIntent, classifyBatch } = require('../core/intent_classifier');
const {
  computeLeadScore, buildScoreRecord, getScoreLabel,
  computeScoreTrend,
} = require('../core/lead_scorer');
const {
  getPlanPrice, recommendPlan, comparePlans,
  getCurrencyForCountry, isValidPlan, invalidateCache,
  DEFAULT_PLANS,
  __setFirestoreForTests: setPricingDb,
} = require('../core/dynamic_pricing_engine');

const UID = 'owner_bloque52_001';
const PHONE = '+5714445555';

function makePricingDb() {
  return {
    collection: () => ({
      get: async () => ({
        forEach: () => {},
      }),
      doc: () => ({ set: async () => {} }),
    }),
  };
}

describe('T353 -- E2E Bloque 52: intent_classifier + lead_scorer + dynamic_pricing_engine', () => {

  test('Paso 1 -- lead pregunta precio -> intent=price', () => {
    const r = classifyIntent('cuanto vale el servicio mensual');
    expect(r.intent).toBe('price');
  });

  test('Paso 2 -- lead pide turno -> intent=booking', () => {
    const r = classifyIntent('quiero agendar una cita para manana');
    expect(r.intent).toBe('booking');
  });

  test('Paso 3 -- computeLeadScore con price_inquired -> score > base', () => {
    const score = computeLeadScore({ price_inquired: true, message_count: 5 });
    expect(score).toBeGreaterThan(10);
    expect(score).toBeLessThanOrEqual(100);
  });

  test('Paso 4 -- buildScoreRecord para lead caliente', () => {
    const score = computeLeadScore({ price_inquired: true, appointment_requested: true, message_count: 10 });
    const rec = buildScoreRecord(UID, PHONE, score, { price_inquired: true }, {});
    expect(rec.uid).toBe(UID);
    expect(rec.score).toBe(score);
    const label = getScoreLabel(score);
    expect(label).not.toBeNull();
  });

  test('Paso 5 -- recommendPlan segun uso del lead', () => {
    const plan = recommendPlan({ avgMessagesPerDay: 80, totalContacts: 200 });
    expect(plan).toBe('starter');
    expect(isValidPlan(plan)).toBe(true);
  });

  test('Paso 6 -- currency para Colombia es COP', () => {
    expect(getCurrencyForCountry('CO')).toBe('COP');
  });

  test('Pipeline completo -- intent + score + pricing', async () => {
    invalidateCache();
    setPricingDb(makePricingDb());

    // A: Lead dice "hola cuanto cuesta y puedo agendar?"
    const msg = classifyIntent('hola cuanto cuesta y puedo agendar?');
    expect(['price', 'complaint', 'booking', 'greeting']).toContain(msg.intent);

    // B: Batch de mensajes del lead
    const batch = classifyBatch([
      'cuanto cuesta?',
      'quiero agendar un turno',
      'que servicios tienen?',
    ]);
    expect(batch.results.length).toBe(3);

    // C: Calcular score del lead basado en comportamiento
    const score = computeLeadScore({
      price_inquired: true,
      question_asked: true,
      appointment_requested: true,
      message_count: 7,
    });
    expect(score).toBeGreaterThan(50);

    // D: Tendencia del score
    const trend = computeScoreTrend(score, 30);
    expect(['rising', 'stable']).toContain(trend);

    // E: Recomendar plan para el lead
    const plan = recommendPlan({ avgMessagesPerDay: 60, totalContacts: 150 });
    expect(plan).toBe('starter');

    // F: Obtener precio del plan recomendado
    const pricing = await getPlanPrice(plan, 'CO');
    expect(pricing.plan).toBe('starter');
    expect(pricing.priceUSD).toBe(DEFAULT_PLANS.starter.priceUSD);
    expect(pricing.currency).toBe('COP');

    // G: Comparar con plan superior
    const comparison = comparePlans('starter', 'pro');
    expect(comparison.upgradeRecommended).toBe(true);
    expect(comparison.priceDiffUSD).toBeGreaterThan(0);
  });
});
