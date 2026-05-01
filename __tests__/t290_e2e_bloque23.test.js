'use strict';

/**
 * T290 — E2E Bloque 23
 * Pipeline: lead WhatsApp → CRM pipeline avanzado → won → NPS survey →
 * promoter score 10 → cupon recompensa → loyalty points → drip campaign →
 * CRM tag promoter + follow-up → stats CRM + NPS aggregados
 */

const {
  buildCrmContact,
  updatePipelineStage,
  addTag,
  setFollowUp,
  computeLeadScore,
  buildActivityRecord,
  recordActivity,
  computeCrmStats,
  buildCrmSummaryText,
  __setFirestoreForTests: setCrmDb,
} = require('../core/crm_engine');

const {
  buildSurveyRecord,
  buildResponseRecord,
  submitResponse,
  computeSurveyAggregates,
  applySurveyAggregates,
  classifyNps,
  __setFirestoreForTests: setFbDb,
} = require('../core/feedback_engine');

const {
  buildCouponRecord,
  validateCoupon,
  computeDiscount,
  applyRedemption,
  __setFirestoreForTests: setCoupDb,
} = require('../core/coupon_engine');

const {
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

const UID = 'owner_bloque23_001';
const PHONE_CLIENT = '+541155551001';

describe('T290 — E2E Bloque 23: CRM + feedback + coupon + campaign + loyalty', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setCrmDb(mock.db);
    setFbDb(mock.db);
    setCoupDb(mock.db);
    setCampDb(mock.db);
    setLoyDb(mock.db);
  });

  // ─── Paso 1: Lead entra por WhatsApp → CRM ───────────────────────────────

  test('Paso 1 — lead creado en CRM desde WhatsApp', () => {
    const contact = buildCrmContact(UID, {
      phone: PHONE_CLIENT,
      name: 'Carolina Vega',
      source: 'whatsapp',
      stage: 'lead',
      dealValue: 25000,
    });

    expect(contact.stage).toBe('lead');
    expect(contact.source).toBe('whatsapp');
    expect(contact.phone).toBe(PHONE_CLIENT);
    expect(contact.activityCount).toBe(0);
    expect(computeLeadScore(contact)).toBeGreaterThan(0);
  });

  // ─── Paso 2: Pipeline CRM avanza lead → won ──────────────────────────────

  test('Paso 2 — pipeline CRM: lead → prospect → qualified → proposal → won', () => {
    let c = buildCrmContact(UID, {
      phone: PHONE_CLIENT,
      name: 'Carolina Vega',
      stage: 'lead',
      dealValue: 25000,
      email: 'carolina@ejemplo.com',
      company: 'Salon Vega',
    });

    c = updatePipelineStage(c, 'prospect');
    expect(c.stage).toBe('prospect');

    c = updatePipelineStage(c, 'qualified');
    expect(c.stage).toBe('qualified');

    c = updatePipelineStage(c, 'proposal');
    expect(c.stage).toBe('proposal');

    // Registrar actividad de demo
    const demo = buildActivityRecord(UID, c.contactId, {
      type: 'meeting',
      body: 'Demo de producto realizada. Muy interesada.',
    });
    c = recordActivity(c, demo);
    expect(c.activityCount).toBe(1);

    c = updatePipelineStage(c, 'negotiation');
    c = updatePipelineStage(c, 'won');
    expect(c.stage).toBe('won');

    const score = computeLeadScore(c);
    expect(score).toBeGreaterThan(80); // won stage + deal + email + company
  });

  // ─── Paso 3: NPS post-servicio ────────────────────────────────────────────

  test('Paso 3 — encuesta NPS post-servicio creada', () => {
    const survey = buildSurveyRecord(UID, {
      type: 'nps',
      title: 'Como te fue con MIIA?',
      triggerEvent: 'appointment_completed',
      status: 'active',
    });

    expect(survey.type).toBe('nps');
    expect(survey.triggerEvent).toBe('appointment_completed');
    expect(survey.responseCount).toBe(0);
  });

  // ─── Paso 4: Cliente promoter score 10 ───────────────────────────────────

  test('Paso 4 — Carolina responde NPS 10 → promoter', () => {
    const survey = buildSurveyRecord(UID, { type: 'nps' });
    const response = buildResponseRecord(UID, survey.surveyId, {
      contactPhone: PHONE_CLIENT,
      contactName: 'Carolina Vega',
    });

    const submitted = submitResponse(response, [], {
      score: 10,
      openText: 'Increible! Me cambio el negocio completamente.',
    });

    expect(submitted.npsCategory).toBe('promoter');
    expect(classifyNps(10)).toBe('promoter');
    expect(submitted.score).toBe(10);
    expect(submitted.openText).toContain('Increible');
  });

  // ─── Paso 5: Cupon recompensa 20% para promoter ──────────────────────────

  test('Paso 5 — cupon 20% generado para promoter', () => {
    const coupon = buildCouponRecord(UID, {
      code: 'PROMO20NPS',
      type: 'percent',
      discountPercent: 20,
      name: 'Regalo por ser Promoter NPS',
      maxUses: 1,
      minOrderAmount: 1000,
    });

    expect(coupon.code).toBe('PROMO20NPS');
    expect(coupon.discountPercent).toBe(20);
    expect(coupon.status).toBe('active');
    expect(coupon.maxUses).toBe(1);

    // Validar en orden de 8000 ARS
    const validation = validateCoupon(coupon, 8000);
    expect(validation.valid).toBe(true);

    const discount = computeDiscount(coupon, 8000);
    expect(discount).toBe(1600); // 20% de 8000

    const redeemed = applyRedemption(coupon);
    expect(redeemed.status).toBe('exhausted');
    expect(redeemed.currentUses).toBe(1);
  });

  // ─── Paso 6: Loyalty points por la compra ────────────────────────────────

  test('Paso 6 — loyalty points por compra post-cupon (6400 ARS final)', () => {
    // Compra 8000, descuento 1600, final 6400
    let account = buildLoyaltyAccount(UID, PHONE_CLIENT, { contactName: 'Carolina Vega' });
    expect(account.tier).toBe('bronze');

    const result = earnPoints(account, 6400, {
      source: 'purchase',
      orderId: 'order_bloque23_001',
    });
    account = result.account;

    expect(account.points).toBe(6400);
    expect(computeTier(6400)).toBe('platinum'); // >5000 = platinum
    expect(account.tier).toBe('platinum');
    expect(result.transaction.type).toBe('earn');
  });

  // ─── Paso 7: CRM — tag promoter + follow-up ──────────────────────────────

  test('Paso 7 — CRM: tag promoter + follow-up en 7 dias', () => {
    let contact = buildCrmContact(UID, {
      phone: PHONE_CLIENT,
      name: 'Carolina Vega',
      stage: 'won',
      dealValue: 25000,
    });

    // Tag por ser promoter NPS
    contact = addTag(contact, 'promoter_nps');
    contact = addTag(contact, 'platinum_loyalty');
    expect(contact.tags).toContain('promoter_nps');
    expect(contact.tags).toContain('platinum_loyalty');

    // Follow-up en 7 días
    const followUpDate = Date.now() + 7 * 24 * 3600 * 1000;
    contact = setFollowUp(contact, followUpDate);
    expect(contact.followUpAt).toBe(followUpDate);

    // Score sube con tags
    const score = computeLeadScore(contact);
    expect(score).toBeGreaterThan(85);
  });

  // ─── Paso 8: Campana drip para promotores ────────────────────────────────

  test('Paso 8 — campana drip activada para promotores loyalty_tier_up', () => {
    const campaign = buildCampaignWithDripSteps(UID, {
      name: 'Promotores Platinum',
      channel: 'whatsapp',
      triggerEvent: 'loyalty_tier_up',
    }, [
      { delayMs: 3600000, body: 'Llegaste a Platinum! Aqui tu bono exclusivo.' },
      { delayMs: 86400000, body: 'Como vas con tu cupon? Ya lo usaste?' },
      { delayMs: 604800000, body: 'Gracias por tu fidelidad! Ya se viene algo especial.' },
    ]);

    expect(campaign.steps.length).toBe(3);
    expect(campaign.triggerEvent).toBe('loyalty_tier_up');

    const started = startCampaign(campaign, 50);
    expect(started.status).toBe('active');
    expect(started.audienceSize).toBe(50);

    // 15 envios exitosos
    let active = started;
    for (let i = 0; i < 15; i++) {
      active = recordSend(active, { delivered: true });
    }
    const stats = computeCampaignStats(active);
    expect(stats.deliveryRate).toBe(100);
    expect(active.sentCount).toBe(15);
  });

  // ─── Paso 9: Agregados NPS multi-respuesta ───────────────────────────────

  test('Paso 9 — NPS aggregados: 15 promotores, 3 pasivos, 2 detractores', () => {
    const survey = buildSurveyRecord(UID, { type: 'nps' });
    const responses = [];

    for (let i = 0; i < 15; i++) {
      const r = buildResponseRecord(UID, survey.surveyId, { contactPhone: '+5411' + (5000 + i) });
      responses.push(submitResponse(r, [], { score: i % 2 === 0 ? 10 : 9 }));
    }
    for (let i = 0; i < 3; i++) {
      const r = buildResponseRecord(UID, survey.surveyId, { contactPhone: '+5411' + (6000 + i) });
      responses.push(submitResponse(r, [], { score: 8 }));
    }
    for (let i = 0; i < 2; i++) {
      const r = buildResponseRecord(UID, survey.surveyId, { contactPhone: '+5411' + (7000 + i) });
      responses.push(submitResponse(r, [], { score: 3 }));
    }

    const agg = computeSurveyAggregates(responses);
    expect(agg.responseCount).toBe(20);
    expect(agg.promoterCount).toBe(15);
    expect(agg.passiveCount).toBe(3);
    expect(agg.detractorCount).toBe(2);
    // NPS = (15-2)/20 * 100 = 65
    expect(agg.npsScore).toBe(65);

    const updated = applySurveyAggregates(survey, agg);
    expect(updated.npsScore).toBe(65);
  });

  // ─── Paso 10: CRM stats pipeline completo ────────────────────────────────

  test('Paso 10 — CRM stats: pipeline 10 contactos, 4 won, 2 lost', () => {
    const contacts = [
      buildCrmContact(UID, { phone: '+1', stage: 'lead' }),
      buildCrmContact(UID, { phone: '+2', stage: 'prospect' }),
      buildCrmContact(UID, { phone: '+3', stage: 'qualified' }),
      buildCrmContact(UID, { phone: '+4', stage: 'won', dealValue: 25000 }),
      buildCrmContact(UID, { phone: '+5', stage: 'won', dealValue: 30000 }),
      buildCrmContact(UID, { phone: '+6', stage: 'won', dealValue: 15000 }),
      buildCrmContact(UID, { phone: '+7', stage: 'won', dealValue: 50000 }),
      buildCrmContact(UID, { phone: '+8', stage: 'lost' }),
      buildCrmContact(UID, { phone: '+9', stage: 'lost' }),
      buildCrmContact(UID, { phone: '+10', stage: 'negotiation', dealValue: 20000 }),
    ];

    const stats = computeCrmStats(contacts);
    expect(stats.total).toBe(10);
    expect(stats.wonCount).toBe(4);
    expect(stats.lostCount).toBe(2);
    // conversion: 4/(4+2) = 66.67%
    expect(stats.conversionRate).toBeCloseTo(66.67, 1);
    // avgDealValue: (25000+30000+15000+50000)/4 = 30000
    expect(stats.avgDealValue).toBe(30000);
  });

  // ─── Pipeline completo integrado ─────────────────────────────────────────

  test('Pipeline completo — CRM + NPS + cupon + loyalty + campaign', () => {
    // A. Lead en CRM
    let contact = buildCrmContact(UID, {
      phone: PHONE_CLIENT,
      name: 'Sofia Torres',
      source: 'referral',
      stage: 'lead',
      dealValue: 40000,
      company: 'Clinica Torres',
    });

    // B. Avanzar a won
    contact = updatePipelineStage(contact, 'prospect');
    contact = updatePipelineStage(contact, 'qualified');
    contact = updatePipelineStage(contact, 'proposal');
    contact = updatePipelineStage(contact, 'negotiation');
    contact = updatePipelineStage(contact, 'won');
    expect(contact.stage).toBe('won');

    // C. NPS 10
    const survey = buildSurveyRecord(UID, { type: 'nps', status: 'active' });
    const resp = buildResponseRecord(UID, survey.surveyId, { contactPhone: PHONE_CLIENT });
    const submitted = submitResponse(resp, [], { score: 10 });
    expect(submitted.npsCategory).toBe('promoter');

    // D. Cupon 25% como recompensa
    const coupon = buildCouponRecord(UID, {
      code: 'VIP25SOFIA',
      type: 'percent',
      discountPercent: 25,
      maxUses: 1,
    });
    expect(validateCoupon(coupon, 5000).valid).toBe(true);
    expect(computeDiscount(coupon, 5000)).toBe(1250);

    // E. Loyalty: 5000 - 1250 = 3750 puntos
    let account = buildLoyaltyAccount(UID, PHONE_CLIENT, {});
    const earned = earnPoints(account, 3750, { source: 'purchase' });
    account = earned.account;
    expect(account.tier).toBe('gold'); // 3750 > 2000

    // F. CRM: tag vip + follow-up
    contact = addTag(contact, 'vip');
    contact = addTag(contact, 'promoter_nps');
    contact = setFollowUp(contact, Date.now() + 14 * 86400000);
    expect(contact.tags).toContain('vip');
    expect(contact.followUpAt).toBeGreaterThan(Date.now());

    // G. Score CRM elevado
    const score = computeLeadScore(contact);
    expect(score).toBeGreaterThan(90);

    // H. Drip 2 pasos
    const drip = buildCampaignWithDripSteps(UID, { name: 'VIP Follow-up' }, [
      { delayMs: 3600000, body: 'Gracias Sofia!' },
      { delayMs: 604800000, body: 'Como estas con MIIA?' },
    ]);
    const dripStarted = startCampaign(drip, 1);
    expect(dripStarted.status).toBe('active');

    // I. NPS final
    const agg = computeSurveyAggregates([submitted]);
    expect(agg.npsScore).toBe(100);
    expect(agg.promoterCount).toBe(1);

    // J. CRM summary
    const text = buildCrmSummaryText(contact);
    expect(text).toContain('Sofia Torres');
    expect(text).toContain('WON');
    expect(text).toContain('vip');
  });
});
