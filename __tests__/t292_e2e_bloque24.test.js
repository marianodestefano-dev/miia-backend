'use strict';

/**
 * T292 — E2E Bloque 24
 * Pipeline: automation rules + CRM pipeline + NPS feedback + coupon reward +
 * ejecucion log + stats + campana drip triggereada por automation
 */

const {
  buildAutomationRule,
  buildCondition,
  buildActionRecord,
  evaluateConditions,
  shouldTrigger,
  recordExecution,
  buildExecutionLog,
  computeAutomationStats,
  buildAutomationSummaryText,
  __setFirestoreForTests: setAutoDb,
} = require('../core/automation_engine');

const {
  buildCrmContact,
  updatePipelineStage,
  addTag,
  computeLeadScore,
  computeCrmStats,
  __setFirestoreForTests: setCrmDb,
} = require('../core/crm_engine');

const {
  buildSurveyRecord,
  buildResponseRecord,
  submitResponse,
  computeSurveyAggregates,
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

// ─── Mock DB ─────────────────────────────────────────────────────────────────

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

const UID = 'owner_bloque24_001';
const PHONE_A = '+541155552001';
const PHONE_B = '+541155552002';

describe('T292 — E2E Bloque 24: automation + CRM + feedback + coupon + campaign', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setAutoDb(mock.db);
    setCrmDb(mock.db);
    setFbDb(mock.db);
    setCoupDb(mock.db);
    setCampDb(mock.db);
  });

  // ─── Paso 1: Reglas de automatizacion configuradas ────────────────────────

  test('Paso 1 — reglas de automation configuradas por el owner', () => {
    // Regla A: bienvenida cuando llega nuevo lead
    const ruleWelcome = buildAutomationRule(UID, {
      name: 'Bienvenida Lead Nuevo',
      triggerType: 'lead_received',
      conditions: [],
      actions: [
        buildActionRecord({ type: 'send_whatsapp', params: { body: 'Hola! Gracias por contactarnos.' } }),
        buildActionRecord({ type: 'update_crm_stage', params: { stage: 'prospect' } }),
      ],
      cooldownMs: 0,
    });

    expect(ruleWelcome.triggerType).toBe('lead_received');
    expect(ruleWelcome.actions.length).toBe(2);
    expect(ruleWelcome.status).toBe('active');

    // Regla B: recompensa cuando NPS promoter
    const ruleReward = buildAutomationRule(UID, {
      name: 'Recompensa Promoter',
      triggerType: 'survey_submitted',
      conditions: [
        buildCondition({ field: 'npsCategory', operator: '==', value: 'promoter' }),
      ],
      actions: [
        buildActionRecord({ type: 'send_coupon', params: { code: 'PROMO15' } }),
        buildActionRecord({ type: 'add_crm_tag', params: { tag: 'promoter_nps' } }),
        buildActionRecord({ type: 'start_campaign', params: { campaignName: 'Follow-up Promotor' } }),
      ],
      maxExecutions: 1,
    });

    expect(ruleReward.conditions.length).toBe(1);
    expect(ruleReward.actions.length).toBe(3);
    expect(ruleReward.maxExecutions).toBe(1);
  });

  // ─── Paso 2: Lead recibido → automation dispara bienvenida ───────────────

  test('Paso 2 — lead recibido → automation dispara y crea contacto CRM', () => {
    const ruleWelcome = buildAutomationRule(UID, {
      name: 'Bienvenida',
      triggerType: 'lead_received',
      actions: [buildActionRecord({ type: 'send_whatsapp' })],
      cooldownMs: 0,
    });

    // Lead llega por WhatsApp
    const ctx = { contactPhone: PHONE_A, source: 'whatsapp', timestamp: Date.now() };
    expect(shouldTrigger(ruleWelcome, 'lead_received', ctx, null)).toBe(true);

    const executed = recordExecution(ruleWelcome);
    expect(executed.executionCount).toBe(1);

    // CRM contact creado
    const contact = buildCrmContact(UID, {
      phone: PHONE_A,
      name: 'Pedro Gomez',
      source: 'whatsapp',
      stage: 'lead',
    });
    expect(contact.stage).toBe('lead');
  });

  // ─── Paso 3: CRM pipeline avanza por automation ──────────────────────────

  test('Paso 3 — CRM pipeline lead → qualified por interacciones', () => {
    let c = buildCrmContact(UID, { phone: PHONE_A, name: 'Pedro Gomez', stage: 'lead' });

    // Automation actualiza stage a prospect en bienvenida
    c = updatePipelineStage(c, 'prospect');
    expect(c.stage).toBe('prospect');

    // Demo → qualified
    c = updatePipelineStage(c, 'qualified');
    expect(c.stage).toBe('qualified');

    // Score sube
    const score = computeLeadScore(c);
    expect(score).toBeGreaterThan(10); // qualified stage agrega puntos
  });

  // ─── Paso 4: NPS post-turno ───────────────────────────────────────────────

  test('Paso 4 — NPS 10 → promoter → automation rule dispara', () => {
    // Survey
    const survey = buildSurveyRecord(UID, { type: 'nps', status: 'active' });
    const resp = buildResponseRecord(UID, survey.surveyId, { contactPhone: PHONE_A });
    const submitted = submitResponse(resp, [], { score: 10 });

    expect(submitted.npsCategory).toBe('promoter');
    expect(classifyNps(10)).toBe('promoter');

    // Regla de recompensa
    const ruleReward = buildAutomationRule(UID, {
      name: 'Recompensa Promoter',
      triggerType: 'survey_submitted',
      conditions: [buildCondition({ field: 'npsCategory', operator: '==', value: 'promoter' })],
      actions: [buildActionRecord({ type: 'send_coupon' })],
      maxExecutions: 1,
    });

    const ctx = { npsCategory: 'promoter', score: 10, contactPhone: PHONE_A };
    expect(shouldTrigger(ruleReward, 'survey_submitted', ctx, null)).toBe(true);

    // Segunda respuesta del mismo contacto con cooldown activo
    const now = Date.now();
    const ruleWithCooldown = { ...ruleReward, cooldownMs: 3600000 };
    expect(shouldTrigger(ruleWithCooldown, 'survey_submitted', ctx, now - 100)).toBe(false);
  });

  // ─── Paso 5: Coupon recompensa por automation ─────────────────────────────

  test('Paso 5 — cupon PROMO15 validado y aplicado por automation', () => {
    const coupon = buildCouponRecord(UID, {
      code: 'PROMO15',
      type: 'percent',
      discountPercent: 15,
      maxUses: 1,
    });

    expect(validateCoupon(coupon, 3000).valid).toBe(true);
    const discount = computeDiscount(coupon, 3000);
    expect(discount).toBe(450); // 15% de 3000

    const redeemed = applyRedemption(coupon);
    expect(redeemed.status).toBe('exhausted');
    expect(redeemed.currentUses).toBe(1);
  });

  // ─── Paso 6: CRM tag aggregado por automation ─────────────────────────────

  test('Paso 6 — automation agrega tag promoter_nps al contacto CRM', () => {
    let c = buildCrmContact(UID, { phone: PHONE_A, name: 'Pedro', stage: 'qualified' });

    // Automation action: add_crm_tag
    c = addTag(c, 'promoter_nps');
    c = addTag(c, 'nps_10');
    expect(c.tags).toContain('promoter_nps');
    expect(c.tags).toContain('nps_10');

    const score = computeLeadScore(c);
    expect(score).toBeGreaterThan(20); // tags + stage
  });

  // ─── Paso 7: Campana drip triggereada por automation ─────────────────────

  test('Paso 7 — automation inicia campana drip post-promoter', () => {
    const campaign = buildCampaignWithDripSteps(UID, {
      name: 'Follow-up Promotor',
      triggerEvent: 'survey_submitted',
      channel: 'whatsapp',
    }, [
      { delayMs: 3600000, body: 'Gracias por tu 10! Aca tu cupon PROMO15.' },
      { delayMs: 86400000, body: 'Lo usaste? Hay algo mas que podamos mejorar?' },
    ]);

    expect(campaign.steps.length).toBe(2);
    const started = startCampaign(campaign, 1);
    expect(started.status).toBe('active');

    let active = started;
    active = recordSend(active, { delivered: true });
    expect(computeCampaignStats(active).deliveryRate).toBe(100);
  });

  // ─── Paso 8: Logs de ejecucion y stats ───────────────────────────────────

  test('Paso 8 — logs de ejecucion y stats de automation', () => {
    const ruleId = 'rule_bloque24_recompensa';

    const logs = [];
    // 8 ejecuciones exitosas
    for (let i = 0; i < 8; i++) {
      logs.push(buildExecutionLog(UID, ruleId, {
        triggerType: 'survey_submitted',
        contactPhone: '+5411555' + i,
        actionsExecuted: ['send_coupon', 'add_crm_tag'],
        success: true,
        durationMs: 100 + i * 20,
      }));
    }
    // 2 fallidas
    for (let i = 0; i < 2; i++) {
      logs.push(buildExecutionLog(UID, ruleId, {
        triggerType: 'survey_submitted',
        success: false,
        errorMessage: 'Timeout WhatsApp',
        durationMs: 5000,
      }));
    }

    const stats = computeAutomationStats(logs);
    expect(stats.total).toBe(10);
    expect(stats.successCount).toBe(8);
    expect(stats.failureCount).toBe(2);
    expect(stats.successRate).toBe(80);
    expect(stats.byTrigger.survey_submitted).toBe(10);
  });

  // ─── Paso 9: NPS con multiples respuestas ────────────────────────────────

  test('Paso 9 — NPS aggregados: detractores activan automation diferente', () => {
    const survey = buildSurveyRecord(UID, { type: 'nps' });
    const responses = [];

    // 5 promotores
    for (let i = 0; i < 5; i++) {
      const r = buildResponseRecord(UID, survey.surveyId, { contactPhone: '+54115' + i });
      responses.push(submitResponse(r, [], { score: 10 }));
    }
    // 3 detractores
    for (let i = 0; i < 3; i++) {
      const r = buildResponseRecord(UID, survey.surveyId, { contactPhone: '+54116' + i });
      responses.push(submitResponse(r, [], { score: 2 }));
    }

    const agg = computeSurveyAggregates(responses);
    expect(agg.promoterCount).toBe(5);
    expect(agg.detractorCount).toBe(3);
    // NPS = (5-3)/8 * 100 = 25
    expect(agg.npsScore).toBe(25);

    // Regla para detractores
    const ruleDetractor = buildAutomationRule(UID, {
      name: 'Recuperar Detractor',
      triggerType: 'survey_submitted',
      conditions: [
        buildCondition({ field: 'npsCategory', operator: '==', value: 'detractor' }),
      ],
      actions: [
        buildActionRecord({ type: 'create_task', params: { task: 'Llamar urgente', priority: 'high' } }),
        buildActionRecord({ type: 'add_crm_tag', params: { tag: 'at_risk' } }),
      ],
    });

    const ctxDetractor = { npsCategory: 'detractor', score: 2 };
    const ctxPromoter = { npsCategory: 'promoter', score: 10 };
    expect(shouldTrigger(ruleDetractor, 'survey_submitted', ctxDetractor, null)).toBe(true);
    expect(shouldTrigger(ruleDetractor, 'survey_submitted', ctxPromoter, null)).toBe(false);
  });

  // ─── Paso 10: CRM stats pipeline completo ────────────────────────────────

  test('Paso 10 — CRM stats: 8 contactos gestionados por automation', () => {
    const contacts = [
      buildCrmContact(UID, { phone: '+1', stage: 'won', dealValue: 15000 }),
      buildCrmContact(UID, { phone: '+2', stage: 'won', dealValue: 22000 }),
      buildCrmContact(UID, { phone: '+3', stage: 'won', dealValue: 8000 }),
      buildCrmContact(UID, { phone: '+4', stage: 'lost' }),
      buildCrmContact(UID, { phone: '+5', stage: 'qualified' }),
      buildCrmContact(UID, { phone: '+6', stage: 'prospect' }),
      buildCrmContact(UID, { phone: '+7', stage: 'lead' }),
      buildCrmContact(UID, { phone: '+8', stage: 'lead' }),
    ];

    const stats = computeCrmStats(contacts);
    expect(stats.total).toBe(8);
    expect(stats.wonCount).toBe(3);
    expect(stats.lostCount).toBe(1);
    // conversion: 3/(3+1) = 75%
    expect(stats.conversionRate).toBe(75);
    // avgDealValue: (15000+22000+8000)/3 = 15000
    expect(stats.avgDealValue).toBe(15000);
  });

  // ─── Pipeline completo integrado ─────────────────────────────────────────

  test('Pipeline completo — automation + CRM + NPS + coupon + campaign', () => {
    // A. Configurar reglas
    const ruleWelcome = buildAutomationRule(UID, {
      name: 'Bienvenida',
      triggerType: 'lead_received',
      actions: [buildActionRecord({ type: 'send_whatsapp' })],
      cooldownMs: 0,
    });

    const ruleReward = buildAutomationRule(UID, {
      name: 'Recompensa NPS',
      triggerType: 'survey_submitted',
      conditions: [buildCondition({ field: 'npsCategory', operator: '==', value: 'promoter' })],
      actions: [
        buildActionRecord({ type: 'send_coupon', params: { code: 'VIP20' } }),
        buildActionRecord({ type: 'add_crm_tag', params: { tag: 'promoter' } }),
      ],
      maxExecutions: 1,
    });

    // B. Lead llega → bienvenida dispara
    let contact = buildCrmContact(UID, { phone: PHONE_B, name: 'Laura Ruiz', source: 'referral', stage: 'lead' });
    const ctxLead = { contactPhone: PHONE_B, source: 'referral' };
    expect(shouldTrigger(ruleWelcome, 'lead_received', ctxLead, null)).toBe(true);
    const welcomeExecuted = recordExecution(ruleWelcome);
    expect(welcomeExecuted.executionCount).toBe(1);

    // C. CRM avanza
    contact = updatePipelineStage(contact, 'prospect');
    contact = updatePipelineStage(contact, 'qualified');
    contact = updatePipelineStage(contact, 'proposal');
    contact = updatePipelineStage(contact, 'negotiation');
    contact = updatePipelineStage(contact, 'won');
    expect(contact.stage).toBe('won');

    // D. NPS 9 → promoter
    const survey = buildSurveyRecord(UID, { type: 'nps', status: 'active' });
    const resp = buildResponseRecord(UID, survey.surveyId, { contactPhone: PHONE_B });
    const submitted = submitResponse(resp, [], { score: 9 });
    expect(submitted.npsCategory).toBe('promoter');

    // E. Automation recompensa dispara
    const ctxNps = { npsCategory: 'promoter', score: 9, contactPhone: PHONE_B };
    expect(shouldTrigger(ruleReward, 'survey_submitted', ctxNps, null)).toBe(true);
    const rewardExecuted = recordExecution(ruleReward);
    // No vuelve a disparar (maxExecutions=1)
    expect(shouldTrigger(rewardExecuted, 'survey_submitted', ctxNps, null)).toBe(false);

    // F. Cupon VIP20
    const coupon = buildCouponRecord(UID, {
      code: 'VIP20', type: 'percent', discountPercent: 20, maxUses: 1,
    });
    expect(computeDiscount(coupon, 5000)).toBe(1000);

    // G. CRM tag promoter
    contact = addTag(contact, 'promoter');
    expect(contact.tags).toContain('promoter');
    expect(computeLeadScore(contact)).toBeGreaterThan(80); // won + tag

    // H. Campana drip
    const drip = buildCampaignWithDripSteps(UID, { name: 'Promotores VIP' }, [
      { delayMs: 3600000, body: 'Gracias Laura! Tu cupon VIP20 ya esta listo.' },
    ]);
    const dripStarted = startCampaign(drip, 1);
    expect(dripStarted.status).toBe('active');

    // I. Execution logs
    const logWelcome = buildExecutionLog(UID, ruleWelcome.ruleId, {
      triggerType: 'lead_received', success: true, actionsExecuted: ['send_whatsapp'], durationMs: 80,
    });
    const logReward = buildExecutionLog(UID, ruleReward.ruleId, {
      triggerType: 'survey_submitted', success: true, actionsExecuted: ['send_coupon', 'add_crm_tag'], durationMs: 200,
    });

    const stats = computeAutomationStats([logWelcome, logReward]);
    expect(stats.total).toBe(2);
    expect(stats.successRate).toBe(100);
    expect(stats.byTrigger.lead_received).toBe(1);
    expect(stats.byTrigger.survey_submitted).toBe(1);

    // J. Summary
    const text = buildAutomationSummaryText(rewardExecuted);
    expect(text).toContain('Recompensa NPS');
    expect(text).toContain('survey_submitted');
  });
});
