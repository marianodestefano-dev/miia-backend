'use strict';

/**
 * T288 — E2E Bloque 22
 * Pipeline: turno completado → encuesta NPS → promoter recibe cupon 30% →
 * cupon validado en orden → redencion registrada → loyalty points por compra →
 * campana drip trigger → agregados encuesta → NPS score calculado
 */

const {
  buildSurveyRecord,
  buildResponseRecord,
  submitResponse,
  computeSurveyAggregates,
  applySurveyAggregates,
  classifyNps,
  buildFeedbackSummaryText,
  __setFirestoreForTests: setFbDb,
} = require('../core/feedback_engine');

const {
  buildCouponRecord,
  validateCoupon,
  computeDiscount,
  applyRedemption,
  buildRedemptionRecord,
  buildCouponSummaryText,
  __setFirestoreForTests: setCoupDb,
} = require('../core/coupon_engine');

const {
  buildCampaignRecord,
  buildCampaignWithDripSteps,
  startCampaign,
  recordSend,
  computeCampaignStats,
  __setFirestoreForTests: setCampDb,
} = require('../core/campaign_engine');

const {
  buildLoyaltyAccount,
  earnPoints,
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

const UID = 'owner_bloque22_001';
const PHONE_CLIENT = '+541155550001';

describe('T288 — E2E Bloque 22: feedback + coupon + campaign + loyalty', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setFbDb(mock.db);
    setCoupDb(mock.db);
    setCampDb(mock.db);
    setLoyDb(mock.db);
  });

  // ─── Paso 1: Encuesta NPS post-turno ─────────────────────────────────────

  test('Paso 1 — encuesta NPS creada y activada', () => {
    const survey = buildSurveyRecord(UID, {
      type: 'nps',
      title: 'Como fue tu turno?',
      triggerEvent: 'appointment_completed',
      status: 'active',
    });

    expect(survey.type).toBe('nps');
    expect(survey.status).toBe('active');
    expect(survey.triggerEvent).toBe('appointment_completed');
    expect(survey.responseCount).toBe(0);
  });

  // ─── Paso 2: Cliente responde NPS 9 (promoter) ───────────────────────────

  test('Paso 2 — cliente responde NPS 9 → clasificado promoter', () => {
    const survey = buildSurveyRecord(UID, { type: 'nps' });
    const response = buildResponseRecord(UID, survey.surveyId, {
      contactPhone: PHONE_CLIENT,
      contactName: 'Maria Garcia',
    });

    const submitted = submitResponse(response, [], {
      score: 9,
      openText: 'Excelente atencion! Volvere pronto.',
    });

    expect(submitted.status).toBe('submitted');
    expect(submitted.score).toBe(9);
    expect(submitted.npsCategory).toBe('promoter');
    expect(classifyNps(9)).toBe('promoter');
    expect(submitted.openText).toContain('Excelente');
  });

  // ─── Paso 3: Cupon 30% para promoter ─────────────────────────────────────

  test('Paso 3 — cupon 30% generado para promoter NPS', () => {
    const coupon = buildCouponRecord(UID, {
      code: 'PROMO30',
      type: 'percent',
      discountPercent: 30,
      name: 'Premio Promotor NPS',
      maxUses: 1,
      usesPerContact: 1,
      minOrderAmount: 500,
    });

    expect(coupon.code).toBe('PROMO30');
    expect(coupon.discountPercent).toBe(30);
    expect(coupon.maxUses).toBe(1);
    expect(coupon.status).toBe('active');
  });

  // ─── Paso 4: Cupon validado y aplicado en orden ───────────────────────────

  test('Paso 4 — cupon validado y aplicado en orden de 5000 ARS', () => {
    const coupon = buildCouponRecord(UID, {
      code: 'PROMO30',
      type: 'percent',
      discountPercent: 30,
      minOrderAmount: 500,
      maxUses: 10,
    });

    // Validar
    const validation = validateCoupon(coupon, 5000);
    expect(validation.valid).toBe(true);
    expect(validation.errors.length).toBe(0);

    // Calcular descuento
    const discount = computeDiscount(coupon, 5000);
    expect(discount).toBe(1500); // 30% de 5000

    // Aplicar redencion
    const updated = applyRedemption(coupon);
    expect(updated.currentUses).toBe(1);
    expect(updated.status).toBe('active'); // aun tiene uses disponibles

    // Registro de redencion
    const redemption = buildRedemptionRecord(UID, coupon.couponId, {
      contactPhone: PHONE_CLIENT,
      orderId: 'order_nps_reward_001',
      orderAmount: 5000,
      discountApplied: discount,
      finalAmount: 5000 - discount,
    });

    expect(redemption.discountApplied).toBe(1500);
    expect(redemption.finalAmount).toBe(3500);
    expect(redemption.status).toBe('applied');
  });

  // ─── Paso 5: Cupon agotado tras maxUses ───────────────────────────────────

  test('Paso 5 — cupon de 1 uso se agota tras la primera redencion', () => {
    const coupon = buildCouponRecord(UID, {
      code: 'ONESHOT',
      type: 'fixed',
      discountAmount: 200,
      maxUses: 1,
    });

    const exhausted = applyRedemption(coupon);
    expect(exhausted.currentUses).toBe(1);
    expect(exhausted.status).toBe('exhausted');

    // Validacion falla para segundo uso
    const validation = validateCoupon(exhausted, 1000);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('coupon_exhausted');
  });

  // ─── Paso 6: Loyalty points por la compra ────────────────────────────────

  test('Paso 6 — loyalty points acumulados por la compra post-cupon', () => {
    let account = buildLoyaltyAccount(UID, PHONE_CLIENT, { contactName: 'Maria Garcia' });
    expect(account.tier).toBe('bronze');

    // Compra de 3500 (precio final despues del cupon) → 3500 puntos
    const result = earnPoints(account, 3500, {
      source: 'purchase',
      orderId: 'order_nps_reward_001',
    });
    account = result.account;

    expect(account.points).toBe(3500);
    expect(account.tier).toBe('gold'); // 3500 > 2000 gold threshold
    expect(computeTier(3500)).toBe('gold');
    expect(result.transaction.type).toBe('earn');
  });

  // ─── Paso 7: Campana drip de seguimiento activada ────────────────────────

  test('Paso 7 — campana drip activada por trigger NPS promoter', () => {
    const campaign = buildCampaignWithDripSteps(UID, {
      name: 'Follow-up Promotores NPS',
      channel: 'whatsapp',
      triggerEvent: 'loyalty_tier_up',
    }, [
      { delayMs: 3600000, body: 'Gracias por tu 9! Aqui va tu cupon de regalo.' },
      { delayMs: 86400000, body: 'Como te fue con tu cupon? Ya lo usaste?' },
      { delayMs: 604800000, body: 'Volvemos a verte pronto? Agendamos tu proximo turno.' },
    ]);

    expect(campaign.steps.length).toBe(3);
    expect(campaign.triggerEvent).toBe('loyalty_tier_up');

    const started = startCampaign(campaign, 25);
    expect(started.status).toBe('active');
    expect(started.audienceSize).toBe(25);

    // Registrar 10 envios exitosos
    let active = started;
    for (let i = 0; i < 10; i++) {
      active = recordSend(active, { delivered: true });
    }
    expect(active.sentCount).toBe(10);
    expect(active.deliveredCount).toBe(10);

    const stats = computeCampaignStats(active);
    expect(stats.deliveryRate).toBe(100);
  });

  // ─── Paso 8: Agregados NPS con multiples respuestas ──────────────────────

  test('Paso 8 — agregados NPS calculados con 20 respuestas', () => {
    const survey = buildSurveyRecord(UID, { type: 'nps' });
    const responses = [];

    // 12 promotores (score 9-10)
    for (let i = 0; i < 12; i++) {
      const r = buildResponseRecord(UID, survey.surveyId, { contactPhone: '+5411555' + i });
      responses.push(submitResponse(r, [], { score: i < 6 ? 10 : 9 }));
    }
    // 4 pasivos (score 7-8)
    for (let i = 0; i < 4; i++) {
      const r = buildResponseRecord(UID, survey.surveyId, { contactPhone: '+5411666' + i });
      responses.push(submitResponse(r, [], { score: 7 }));
    }
    // 4 detractores (score 3-6)
    for (let i = 0; i < 4; i++) {
      const r = buildResponseRecord(UID, survey.surveyId, { contactPhone: '+5411777' + i });
      responses.push(submitResponse(r, [], { score: 4 }));
    }

    const agg = computeSurveyAggregates(responses);
    expect(agg.responseCount).toBe(20);
    expect(agg.promoterCount).toBe(12);
    expect(agg.passiveCount).toBe(4);
    expect(agg.detractorCount).toBe(4);
    // NPS = (12-4)/20 * 100 = 40
    expect(agg.npsScore).toBe(40);

    const updated = applySurveyAggregates(survey, agg);
    expect(updated.npsScore).toBe(40);
    const text = buildFeedbackSummaryText(updated);
    expect(text).toContain('NPS: 40');
    expect(text).toContain('Promotores: 12');
  });

  // ─── Pipeline completo integrado ─────────────────────────────────────────

  test('Pipeline completo — NPS promoter + cupon + loyalty + campana drip', () => {
    // A. Encuesta NPS
    const survey = buildSurveyRecord(UID, { type: 'nps', title: 'NPS Post-Turno', status: 'active' });

    // B. Respuesta promoter
    const resp = buildResponseRecord(UID, survey.surveyId, { contactPhone: PHONE_CLIENT });
    const submitted = submitResponse(resp, [], { score: 10 });
    expect(submitted.npsCategory).toBe('promoter');

    // C. Cupon de recompensa
    const coupon = buildCouponRecord(UID, {
      code: 'NPS10REWARD',
      type: 'percent',
      discountPercent: 25,
      maxUses: 1,
    });
    const validation = validateCoupon(coupon, 3000);
    expect(validation.valid).toBe(true);

    const discount = computeDiscount(coupon, 3000);
    expect(discount).toBe(750); // 25% de 3000

    const redeemedCoupon = applyRedemption(coupon);
    expect(redeemedCoupon.status).toBe('exhausted'); // maxUses=1

    // D. Loyalty
    let account = buildLoyaltyAccount(UID, PHONE_CLIENT, {});
    const earned = earnPoints(account, 2250, { source: 'purchase' }); // 3000 - 750
    account = earned.account;
    expect(account.tier).toBe('gold'); // >2000

    // E. Campana drip
    const drip = buildCampaignWithDripSteps(UID, { name: 'NPS Follow-up' }, [
      { delayMs: 3600000, body: 'Gracias!' },
      { delayMs: 86400000, body: 'Como estas?' },
    ]);
    const dripStarted = startCampaign(drip, 1);
    expect(dripStarted.status).toBe('active');

    // F. Agregados encuesta con 1 respuesta
    const agg = computeSurveyAggregates([submitted]);
    expect(agg.promoterCount).toBe(1);
    expect(agg.npsScore).toBe(100); // (1-0)/1 * 100

    // G. Summary text
    const summaryText = buildCouponSummaryText(redeemedCoupon);
    expect(summaryText).toContain('NPS10REWARD');
    expect(summaryText).toContain('exhausted');
  });
});
