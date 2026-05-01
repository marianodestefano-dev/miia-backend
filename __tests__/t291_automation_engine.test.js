'use strict';

/**
 * T291 — automation_engine tests
 * Reglas de automatizacion: trigger+conditions+actions, cooldown,
 * maxExecutions, evaluacion logica AND/OR, lifecycle, stats, CRUD mock
 */

const {
  buildAutomationRule,
  buildCondition,
  buildActionRecord,
  evaluateCondition,
  evaluateConditions,
  shouldTrigger,
  recordExecution,
  pauseRule,
  activateRule,
  archiveRule,
  buildExecutionLog,
  computeAutomationStats,
  buildAutomationSummaryText,
  saveAutomationRule,
  getAutomationRule,
  updateAutomationRule,
  saveExecutionLog,
  listActiveRules,
  listRulesByTrigger,
  listExecutionLogs,
  TRIGGER_TYPES,
  ACTION_TYPES,
  CONDITION_OPERATORS,
  MAX_CONDITIONS,
  MAX_ACTIONS,
  COOLDOWN_MS_DEFAULT,
  __setFirestoreForTests: setAutoDb,
} = require('../core/automation_engine');

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

const UID = 'owner_auto_001';

describe('T291 — automation_engine: reglas trigger+conditions+actions', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setAutoDb(mock.db);
  });

  // ─── Constantes ──────────────────────────────────────────────────────────

  test('constantes exportadas correctas', () => {
    expect(TRIGGER_TYPES).toContain('lead_received');
    expect(TRIGGER_TYPES).toContain('appointment_completed');
    expect(TRIGGER_TYPES).toContain('loyalty_tier_up');
    expect(ACTION_TYPES).toContain('send_whatsapp');
    expect(ACTION_TYPES).toContain('start_campaign');
    expect(ACTION_TYPES).toContain('send_coupon');
    expect(CONDITION_OPERATORS).toContain('==');
    expect(CONDITION_OPERATORS).toContain('contains');
    expect(MAX_CONDITIONS).toBeGreaterThanOrEqual(5);
    expect(MAX_ACTIONS).toBeGreaterThanOrEqual(3);
    expect(COOLDOWN_MS_DEFAULT).toBeGreaterThan(0);
  });

  // ─── buildCondition ──────────────────────────────────────────────────────

  test('buildCondition valores correctos', () => {
    const c = buildCondition({ field: 'score', operator: '>=', value: 9 });
    expect(c.field).toBe('score');
    expect(c.operator).toBe('>=');
    expect(c.value).toBe(9);
  });

  test('buildCondition operator invalido cae a ==', () => {
    const c = buildCondition({ field: 'x', operator: 'ninja', value: 1 });
    expect(c.operator).toBe('==');
  });

  // ─── buildActionRecord ───────────────────────────────────────────────────

  test('buildActionRecord valores correctos', () => {
    const a = buildActionRecord({ type: 'send_coupon', params: { code: 'PROMO10' }, delayMs: 3600000 });
    expect(a.type).toBe('send_coupon');
    expect(a.params.code).toBe('PROMO10');
    expect(a.delayMs).toBe(3600000);
  });

  test('buildActionRecord tipo invalido cae a send_notification', () => {
    const a = buildActionRecord({ type: 'telepata' });
    expect(a.type).toBe('send_notification');
  });

  test('buildActionRecord delayMs negativo se clampea a 0', () => {
    const a = buildActionRecord({ type: 'send_whatsapp', delayMs: -100 });
    expect(a.delayMs).toBe(0);
  });

  // ─── buildAutomationRule ─────────────────────────────────────────────────

  test('buildAutomationRule valores por defecto', () => {
    const rule = buildAutomationRule(UID, {
      name: 'Regla NPS Promoter',
      triggerType: 'survey_submitted',
    });
    expect(rule.uid).toBe(UID);
    expect(rule.name).toBe('Regla NPS Promoter');
    expect(rule.triggerType).toBe('survey_submitted');
    expect(rule.status).toBe('active');
    expect(rule.conditionLogic).toBe('AND');
    expect(rule.conditions).toEqual([]);
    expect(rule.actions).toEqual([]);
    expect(rule.executionCount).toBe(0);
    expect(rule.cooldownMs).toBe(COOLDOWN_MS_DEFAULT);
    expect(rule.maxExecutions).toBe(0);
    expect(typeof rule.ruleId).toBe('string');
  });

  test('buildAutomationRule con condiciones y acciones', () => {
    const rule = buildAutomationRule(UID, {
      name: 'Promoter Reward',
      triggerType: 'survey_submitted',
      conditionLogic: 'OR',
      conditions: [
        { field: 'npsCategory', operator: '==', value: 'promoter' },
        { field: 'score', operator: '>=', value: 9 },
      ],
      actions: [
        { type: 'send_coupon', params: { code: 'PROMO30' } },
        { type: 'add_crm_tag', params: { tag: 'promoter' } },
      ],
      maxExecutions: 1,
      cooldownMs: 86400000,
    });
    expect(rule.conditions.length).toBe(2);
    expect(rule.actions.length).toBe(2);
    expect(rule.conditionLogic).toBe('OR');
    expect(rule.maxExecutions).toBe(1);
    expect(rule.cooldownMs).toBe(86400000);
  });

  test('buildAutomationRule trigger invalido cae a custom', () => {
    const rule = buildAutomationRule(UID, { triggerType: 'telepata' });
    expect(rule.triggerType).toBe('custom');
  });

  test('buildAutomationRule conditions capped a MAX_CONDITIONS', () => {
    const manyConds = Array.from({ length: MAX_CONDITIONS + 5 }, (_, i) => ({
      field: 'f' + i, operator: '==', value: i,
    }));
    const rule = buildAutomationRule(UID, { conditions: manyConds });
    expect(rule.conditions.length).toBe(MAX_CONDITIONS);
  });

  // ─── evaluateCondition ───────────────────────────────────────────────────

  test('evaluateCondition == true y false', () => {
    const c = buildCondition({ field: 'stage', operator: '==', value: 'promoter' });
    expect(evaluateCondition(c, { stage: 'promoter' })).toBe(true);
    expect(evaluateCondition(c, { stage: 'detractor' })).toBe(false);
  });

  test('evaluateCondition != ', () => {
    const c = buildCondition({ field: 'status', operator: '!=', value: 'inactive' });
    expect(evaluateCondition(c, { status: 'active' })).toBe(true);
    expect(evaluateCondition(c, { status: 'inactive' })).toBe(false);
  });

  test('evaluateCondition > < >= <=', () => {
    const gt = buildCondition({ field: 'score', operator: '>', value: 8 });
    expect(evaluateCondition(gt, { score: 9 })).toBe(true);
    expect(evaluateCondition(gt, { score: 8 })).toBe(false);

    const lte = buildCondition({ field: 'score', operator: '<=', value: 6 });
    expect(evaluateCondition(lte, { score: 6 })).toBe(true);
    expect(evaluateCondition(lte, { score: 7 })).toBe(false);
  });

  test('evaluateCondition contains string y array', () => {
    const cs = buildCondition({ field: 'text', operator: 'contains', value: 'promo' });
    expect(evaluateCondition(cs, { text: 'codigo promo especial' })).toBe(true);
    expect(evaluateCondition(cs, { text: 'sin coincidencia' })).toBe(false);

    const ca = buildCondition({ field: 'tags', operator: 'contains', value: 'vip' });
    expect(evaluateCondition(ca, { tags: ['vip', 'cliente'] })).toBe(true);
    expect(evaluateCondition(ca, { tags: ['normal'] })).toBe(false);
  });

  test('evaluateCondition in y not_in', () => {
    const cin = buildCondition({ field: 'tier', operator: 'in', value: ['gold', 'platinum'] });
    expect(evaluateCondition(cin, { tier: 'gold' })).toBe(true);
    expect(evaluateCondition(cin, { tier: 'bronze' })).toBe(false);

    const nin = buildCondition({ field: 'stage', operator: 'not_in', value: ['lost', 'churned'] });
    expect(evaluateCondition(nin, { stage: 'won' })).toBe(true);
    expect(evaluateCondition(nin, { stage: 'lost' })).toBe(false);
  });

  test('evaluateCondition campo inexistente: false', () => {
    const c = buildCondition({ field: 'inexistente', operator: '==', value: 'x' });
    expect(evaluateCondition(c, { otro: 'campo' })).toBe(false);
  });

  // ─── evaluateConditions ──────────────────────────────────────────────────

  test('evaluateConditions AND: todas deben ser true', () => {
    const conds = [
      buildCondition({ field: 'score', operator: '>=', value: 9 }),
      buildCondition({ field: 'npsCategory', operator: '==', value: 'promoter' }),
    ];
    const ctx = { score: 10, npsCategory: 'promoter' };
    expect(evaluateConditions(conds, ctx, 'AND')).toBe(true);

    const ctx2 = { score: 10, npsCategory: 'passive' };
    expect(evaluateConditions(conds, ctx2, 'AND')).toBe(false);
  });

  test('evaluateConditions OR: basta una true', () => {
    const conds = [
      buildCondition({ field: 'score', operator: '>=', value: 9 }),
      buildCondition({ field: 'tier', operator: '==', value: 'platinum' }),
    ];
    const ctx = { score: 7, tier: 'platinum' };
    expect(evaluateConditions(conds, ctx, 'OR')).toBe(true);

    const ctxNone = { score: 5, tier: 'bronze' };
    expect(evaluateConditions(conds, ctxNone, 'OR')).toBe(false);
  });

  test('evaluateConditions sin condiciones: siempre true', () => {
    expect(evaluateConditions([], {}, 'AND')).toBe(true);
    expect(evaluateConditions([], {}, 'OR')).toBe(true);
  });

  // ─── shouldTrigger ───────────────────────────────────────────────────────

  test('shouldTrigger regla activa sin condiciones: dispara', () => {
    const rule = buildAutomationRule(UID, {
      name: 'Simple',
      triggerType: 'lead_received',
    });
    expect(shouldTrigger(rule, 'lead_received', {}, null)).toBe(true);
  });

  test('shouldTrigger regla inactiva: no dispara', () => {
    const rule = buildAutomationRule(UID, { triggerType: 'lead_received', status: 'paused' });
    expect(shouldTrigger(rule, 'lead_received', {}, null)).toBe(false);
  });

  test('shouldTrigger trigger diferente: no dispara', () => {
    const rule = buildAutomationRule(UID, { triggerType: 'lead_received' });
    expect(shouldTrigger(rule, 'payment_received', {}, null)).toBe(false);
  });

  test('shouldTrigger maxExecutions alcanzado: no dispara', () => {
    let rule = buildAutomationRule(UID, { triggerType: 'lead_received', maxExecutions: 1 });
    rule = recordExecution(rule);
    expect(shouldTrigger(rule, 'lead_received', {}, null)).toBe(false);
  });

  test('shouldTrigger en cooldown: no dispara', () => {
    const rule = buildAutomationRule(UID, {
      triggerType: 'lead_received',
      cooldownMs: 3600000,
    });
    const recentExecution = Date.now() - 1000; // 1 segundo atrás
    expect(shouldTrigger(rule, 'lead_received', {}, recentExecution)).toBe(false);
  });

  test('shouldTrigger cooldown expirado: dispara', () => {
    const rule = buildAutomationRule(UID, {
      triggerType: 'lead_received',
      cooldownMs: 1000, // 1 segundo
    });
    const oldExecution = Date.now() - 5000; // 5 segundos atrás
    expect(shouldTrigger(rule, 'lead_received', {}, oldExecution)).toBe(true);
  });

  test('shouldTrigger condicion no cumplida: no dispara', () => {
    const rule = buildAutomationRule(UID, {
      triggerType: 'survey_submitted',
      conditions: [buildCondition({ field: 'npsCategory', operator: '==', value: 'promoter' })],
    });
    expect(shouldTrigger(rule, 'survey_submitted', { npsCategory: 'detractor' }, null)).toBe(false);
    expect(shouldTrigger(rule, 'survey_submitted', { npsCategory: 'promoter' }, null)).toBe(true);
  });

  // ─── recordExecution + lifecycle ─────────────────────────────────────────

  test('recordExecution incrementa contador', () => {
    let rule = buildAutomationRule(UID, { triggerType: 'lead_received' });
    rule = recordExecution(rule);
    expect(rule.executionCount).toBe(1);
    expect(rule.lastExecutedAt).toBeGreaterThan(0);
    rule = recordExecution(rule);
    expect(rule.executionCount).toBe(2);
  });

  test('pauseRule y activateRule', () => {
    let rule = buildAutomationRule(UID, { triggerType: 'lead_received' });
    rule = pauseRule(rule);
    expect(rule.status).toBe('paused');
    rule = activateRule(rule);
    expect(rule.status).toBe('active');
  });

  test('archiveRule bloquea pause y activate', () => {
    let rule = buildAutomationRule(UID, { triggerType: 'lead_received' });
    rule = archiveRule(rule);
    expect(rule.status).toBe('archived');
    expect(() => pauseRule(rule)).toThrow('cannot_pause_archived');
    expect(() => activateRule(rule)).toThrow('cannot_activate_archived');
  });

  // ─── buildExecutionLog ───────────────────────────────────────────────────

  test('buildExecutionLog valores correctos', () => {
    const log = buildExecutionLog(UID, 'rule_001', {
      triggerType: 'survey_submitted',
      contactPhone: '+541155550001',
      triggerContext: { score: 10, npsCategory: 'promoter' },
      actionsExecuted: ['send_coupon', 'add_crm_tag'],
      success: true,
      durationMs: 150,
    });
    expect(log.uid).toBe(UID);
    expect(log.ruleId).toBe('rule_001');
    expect(log.triggerType).toBe('survey_submitted');
    expect(log.success).toBe(true);
    expect(log.actionsExecuted.length).toBe(2);
    expect(log.durationMs).toBe(150);
    expect(typeof log.logId).toBe('string');
  });

  test('buildExecutionLog fallido con mensaje de error', () => {
    const log = buildExecutionLog(UID, 'rule_001', {
      success: false,
      errorMessage: 'Timeout al enviar WhatsApp',
    });
    expect(log.success).toBe(false);
    expect(log.errorMessage).toContain('Timeout');
  });

  // ─── computeAutomationStats ──────────────────────────────────────────────

  test('computeAutomationStats lista vacia', () => {
    const stats = computeAutomationStats([]);
    expect(stats.total).toBe(0);
    expect(stats.successRate).toBe(0);
  });

  test('computeAutomationStats con logs variados', () => {
    const logs = [
      buildExecutionLog(UID, 'r1', { triggerType: 'lead_received', success: true, durationMs: 100 }),
      buildExecutionLog(UID, 'r1', { triggerType: 'lead_received', success: true, durationMs: 200 }),
      buildExecutionLog(UID, 'r2', { triggerType: 'survey_submitted', success: false, durationMs: 300 }),
      buildExecutionLog(UID, 'r2', { triggerType: 'survey_submitted', success: true, durationMs: 150 }),
    ];
    const stats = computeAutomationStats(logs);
    expect(stats.total).toBe(4);
    expect(stats.successCount).toBe(3);
    expect(stats.failureCount).toBe(1);
    expect(stats.successRate).toBe(75);
    expect(stats.byTrigger.lead_received).toBe(2);
    expect(stats.byTrigger.survey_submitted).toBe(2);
    expect(stats.avgDurationMs).toBe(188); // Math.round(750/4) = Math.round(187.5) = 188
  });

  // ─── buildAutomationSummaryText ──────────────────────────────────────────

  test('buildAutomationSummaryText null', () => {
    expect(buildAutomationSummaryText(null)).toContain('no encontrada');
  });

  test('buildAutomationSummaryText regla completa', () => {
    const rule = buildAutomationRule(UID, {
      name: 'Bienvenida Lead',
      triggerType: 'lead_received',
      conditions: [buildCondition({ field: 'source', operator: '==', value: 'whatsapp' })],
      actions: [buildActionRecord({ type: 'send_whatsapp' }), buildActionRecord({ type: 'add_crm_tag' })],
    });
    const text = buildAutomationSummaryText(rule);
    expect(text).toContain('Bienvenida Lead');
    expect(text).toContain('lead_received');
    expect(text).toContain('send_whatsapp');
  });

  // ─── CRUD Firestore mock ─────────────────────────────────────────────────

  test('saveAutomationRule y getAutomationRule round-trip', async () => {
    const rule = buildAutomationRule(UID, {
      name: 'Test Rule',
      triggerType: 'loyalty_tier_up',
      actions: [buildActionRecord({ type: 'send_coupon', params: { code: 'PROMO' } })],
    });
    const id = await saveAutomationRule(UID, rule);
    expect(id).toBe(rule.ruleId);

    const retrieved = await getAutomationRule(UID, rule.ruleId);
    expect(retrieved).not.toBeNull();
    expect(retrieved.name).toBe('Test Rule');
    expect(retrieved.triggerType).toBe('loyalty_tier_up');
  });

  test('getAutomationRule inexistente retorna null', async () => {
    const result = await getAutomationRule(UID, 'no_existe_9999');
    expect(result).toBeNull();
  });

  test('updateAutomationRule modifica status', async () => {
    const rule = buildAutomationRule(UID, { name: 'Rule A', triggerType: 'lead_received' });
    await saveAutomationRule(UID, rule);
    await updateAutomationRule(UID, rule.ruleId, { status: 'paused' });
    const updated = await getAutomationRule(UID, rule.ruleId);
    expect(updated.status).toBe('paused');
  });

  test('saveExecutionLog y listExecutionLogs', async () => {
    const rule = buildAutomationRule(UID, { triggerType: 'lead_received' });
    const log1 = buildExecutionLog(UID, rule.ruleId, { triggerType: 'lead_received', success: true });
    const log2 = buildExecutionLog(UID, rule.ruleId, { triggerType: 'lead_received', success: false });
    await saveExecutionLog(UID, log1);
    await saveExecutionLog(UID, log2);

    const logs = await listExecutionLogs(UID, rule.ruleId);
    expect(logs.length).toBe(2);
  });

  test('listActiveRules solo devuelve activas', async () => {
    const r1 = buildAutomationRule(UID, { name: 'R1', triggerType: 'lead_received', status: 'active' });
    const r2 = buildAutomationRule(UID, { name: 'R2', triggerType: 'payment_received', status: 'paused' });
    const r3 = buildAutomationRule(UID, { name: 'R3', triggerType: 'survey_submitted', status: 'active' });
    await saveAutomationRule(UID, r1);
    await saveAutomationRule(UID, r2);
    await saveAutomationRule(UID, r3);

    const active = await listActiveRules(UID);
    expect(active.length).toBe(2);
    expect(active.map(r => r.status).every(s => s === 'active')).toBe(true);
  });

  test('listRulesByTrigger filtra por triggerType', async () => {
    const r1 = buildAutomationRule(UID, { triggerType: 'lead_received' });
    const r2 = buildAutomationRule(UID, { triggerType: 'lead_received' });
    const r3 = buildAutomationRule(UID, { triggerType: 'survey_submitted' });
    await saveAutomationRule(UID, r1);
    await saveAutomationRule(UID, r2);
    await saveAutomationRule(UID, r3);

    const leads = await listRulesByTrigger(UID, 'lead_received');
    expect(leads.length).toBe(2);
    const surveys = await listRulesByTrigger(UID, 'survey_submitted');
    expect(surveys.length).toBe(1);
  });

  // ─── Pipeline E2E ─────────────────────────────────────────────────────────

  test('Pipeline completo — regla NPS promoter → cupon + tag CRM', async () => {
    // 1. Crear regla: si NPS es promoter → enviar cupon + agregar tag
    const rule = buildAutomationRule(UID, {
      name: 'Recompensa Promoter NPS',
      triggerType: 'survey_submitted',
      conditionLogic: 'AND',
      conditions: [
        buildCondition({ field: 'npsCategory', operator: '==', value: 'promoter' }),
        buildCondition({ field: 'score', operator: '>=', value: 9 }),
      ],
      actions: [
        buildActionRecord({ type: 'send_coupon', params: { code: 'PROMO20', discountPercent: 20 } }),
        buildActionRecord({ type: 'add_crm_tag', params: { tag: 'promoter_nps' } }),
        buildActionRecord({ type: 'send_whatsapp', params: { body: 'Gracias por tu 10!' } }),
      ],
      maxExecutions: 1,
      cooldownMs: 86400000,
    });

    expect(rule.conditions.length).toBe(2);
    expect(rule.actions.length).toBe(3);

    // 2. Evento: NPS score 10, promoter
    const ctx = { npsCategory: 'promoter', score: 10, contactPhone: '+541155550001' };
    expect(shouldTrigger(rule, 'survey_submitted', ctx, null)).toBe(true);

    // 3. Ejecutar regla
    let updatedRule = recordExecution(rule);
    expect(updatedRule.executionCount).toBe(1);

    // 4. No dispara segunda vez (maxExecutions=1)
    expect(shouldTrigger(updatedRule, 'survey_submitted', ctx, null)).toBe(false);

    // 5. Registrar log
    const log = buildExecutionLog(UID, rule.ruleId, {
      triggerType: 'survey_submitted',
      contactPhone: '+541155550001',
      triggerContext: ctx,
      actionsExecuted: ['send_coupon', 'add_crm_tag', 'send_whatsapp'],
      success: true,
      durationMs: 220,
    });
    expect(log.success).toBe(true);
    expect(log.actionsExecuted.length).toBe(3);

    // 6. Guardar en Firestore
    await saveAutomationRule(UID, updatedRule);
    await saveExecutionLog(UID, log);

    // 7. Stats
    const logs = [log];
    const stats = computeAutomationStats(logs);
    expect(stats.successRate).toBe(100);
    expect(stats.byTrigger.survey_submitted).toBe(1);

    // 8. Summary text
    const text = buildAutomationSummaryText(updatedRule);
    expect(text).toContain('Recompensa Promoter NPS');
    expect(text).toContain('survey_submitted');
    expect(text).toContain('send_coupon');
  });
});
