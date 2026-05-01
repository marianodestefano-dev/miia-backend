'use strict';

/**
 * T308 -- E2E Bloque 32
 * Pipeline: owner recibe 3 leads -> CRM -> automation -> quick actions
 * (send_template) -> CRM avanza lead->prospect -> stats finales.
 */

const {
  enqueueAction,
  updateActionStatus,
  getQueuedActions,
  summarizeQueue,
  isActionExpired,
  ACTION_TYPES,
  __setFirestoreForTests: setQADb,
} = require('../core/quick_actions_engine');

const {
  buildCrmContact,
  updatePipelineStage,
  addTag,
  computeCrmStats,
  computeLeadScore,
  __setFirestoreForTests: setCrmDb,
} = require('../core/crm_engine');

const {
  buildAutomationRule,
  shouldTrigger,
  recordExecution,
  __setFirestoreForTests: setAutoDb,
} = require('../core/automation_engine');

function makeMockDb() {
  const store = {};
  return {
    store,
    db: {
      collection: () => ({
        doc: (uid) => ({
          collection: (subCol) => ({
            doc: (id) => ({
              set: async (data, opts) => {
                if (!store[uid]) store[uid] = {};
                if (!store[uid][subCol]) store[uid][subCol] = {};
                if (opts && opts.merge) {
                  store[uid][subCol][id] = { ...(store[uid][subCol][id] || {}), ...data };
                } else {
                  store[uid][subCol][id] = { ...data };
                }
              },
              get: async () => {
                const rec = store[uid] && store[uid][subCol] && store[uid][subCol][id];
                return { exists: !!rec, data: () => rec };
              },
            }),
            where: (field, op, val) => ({
              get: async () => {
                const all = Object.entries((store[uid] || {})[subCol] || {});
                const filtered = all.filter(([, r]) => op === '==' ? r[field] === val : true);
                return {
                  empty: filtered.length === 0,
                  forEach: (fn) => filtered.forEach(([docId, d]) => fn({ id: docId, data: () => d })),
                };
              },
            }),
            get: async () => {
              const all = Object.entries((store[uid] || {})[subCol] || {});
              return {
                empty: all.length === 0,
                forEach: (fn) => all.forEach(([docId, d]) => fn({ id: docId, data: () => d })),
              };
            },
          }),
        }),
      }),
    },
  };
}

const UID = 'owner_bloque32_001';

describe('T308 -- E2E Bloque 32: quick_actions + CRM + automation', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setQADb(mock.db);
    setCrmDb(mock.db);
    setAutoDb(mock.db);
  });

  // Paso 1: Verificar que send_template es accion valida

  test('Paso 1 -- send_template y block_contact son acciones validas', () => {
    expect(ACTION_TYPES).toContain('send_template');
    expect(ACTION_TYPES).toContain('block_contact');
    expect(ACTION_TYPES).toContain('pause_miia');
  });

  // Paso 2: 3 leads creados en CRM

  test('Paso 2 -- 3 leads nuevos ingresados al CRM', () => {
    const contacts = [
      buildCrmContact(UID, { phone: '+5711234567', name: 'Ana Gomez', stage: 'lead', tags: ['colombia'] }),
      buildCrmContact(UID, { phone: '+5412345678', name: 'Carlos Ruiz', stage: 'lead', tags: ['argentina'] }),
      buildCrmContact(UID, { phone: '+5212345678', name: 'Maria Lopez', stage: 'lead', tags: ['mexico'] }),
    ];
    const stats = computeCrmStats(contacts);
    expect(stats.total).toBe(3);
    expect(stats.byStage.lead).toBe(3);
    contacts.forEach(c => expect(c.leadScore).toBeGreaterThanOrEqual(0));
  });

  // Paso 3: Automation rule lead_received para cada lead

  test('Paso 3 -- automation rule lead_received dispara para leads nuevos', () => {
    const rule = buildAutomationRule(UID, {
      name: 'Bienvenida Lead',
      triggerType: 'lead_received',
      actions: [{ type: 'send_whatsapp', template: 'bienvenida_lead' }],
    });
    expect(rule.status).toBe('active');

    // Dispara 3 veces (una por lead)
    let updatedRule = rule;
    for (let i = 0; i < 3; i++) {
      const fires = shouldTrigger(updatedRule, 'lead_received', {}, null);
      expect(fires).toBe(true);
      updatedRule = recordExecution(updatedRule);
    }
    expect(updatedRule.executionCount).toBe(3);
  });

  // Paso 4: Owner encola send_template para los 3 leads

  test('Paso 4 -- owner encola send_template x3 para leads', async () => {
    const phones = ['+5711234567', '+5412345678', '+5212345678'];
    const actionIds = [];

    for (const phone of phones) {
      const { actionId, record } = await enqueueAction(UID, 'send_template', {
        template: 'bienvenida', phone, planType: 'starter',
      });
      expect(record.status).toBe('queued');
      actionIds.push(actionId);
    }
    expect(actionIds.length).toBe(3);

    const queued = await getQueuedActions(UID);
    expect(queued.length).toBe(3);
  });

  // Paso 5: Templates enviados -> acciones marcadas como done

  test('Paso 5 -- templates enviados, acciones marcadas como done', async () => {
    const { actionId: id1 } = await enqueueAction(UID, 'send_template', { phone: '+5711234567' });
    const { actionId: id2 } = await enqueueAction(UID, 'send_template', { phone: '+5412345678' });
    const { actionId: id3 } = await enqueueAction(UID, 'send_template', { phone: '+5212345678' });

    await updateActionStatus(UID, id1, 'done', { sent: true }, null);
    await updateActionStatus(UID, id2, 'done', { sent: true }, null);
    await updateActionStatus(UID, id3, 'done', { sent: true }, null);

    // No quedan acciones en cola
    const queued = await getQueuedActions(UID);
    expect(queued.length).toBe(0);
  });

  // Paso 6: Lead Ana avanza de lead a prospect en CRM

  test('Paso 6 -- lead Ana responde y avanza a prospect en CRM', () => {
    let ana = buildCrmContact(UID, { phone: '+5711234567', name: 'Ana Gomez', stage: 'lead' });
    ana = updatePipelineStage(ana, 'prospect');
    ana = addTag(ana, 'respondio_template');
    expect(ana.stage).toBe('prospect');
    expect(ana.tags).toContain('respondio_template');
    expect(ana.stageChangedAt).toBeGreaterThan(0);
  });

  // Paso 7: Score de lead avanzado

  test('Paso 7 -- score de Ana (prospect) mayor al score base', () => {
    let ana = buildCrmContact(UID, { phone: '+5711234567', name: 'Ana Gomez', stage: 'lead' });
    const scoreLead = computeLeadScore(ana);
    ana = updatePipelineStage(ana, 'prospect');
    const scoreProspect = computeLeadScore(ana);
    expect(scoreProspect).toBeGreaterThan(scoreLead);
  });

  // Paso 8: Accion no expirada y expirada

  test('Paso 8 -- isActionExpired correcto para acciones nuevas y viejas', () => {
    const fresh = { createdAt: new Date().toISOString() };
    const old = { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
    expect(isActionExpired(fresh)).toBe(false);
    expect(isActionExpired(old)).toBe(true);
  });

  // Paso 9: Resumen de cola de acciones

  test('Paso 9 -- summarizeQueue refleja estado correcto', () => {
    const actions = [
      { type: 'send_template', status: 'done' },
      { type: 'send_template', status: 'done' },
      { type: 'send_template', status: 'done' },
      { type: 'pause_miia', status: 'queued' },
    ];
    const summary = summarizeQueue(actions);
    expect(summary.total).toBe(4);
    expect(summary.byType['send_template']).toBe(3);
    expect(summary.byStatus['done']).toBe(3);
    expect(summary.byStatus['queued']).toBe(1);
    expect(summary.hasPendingActions).toBe(true);
  });

  // Pipeline completo integrado

  test('Pipeline completo -- leads CRM + automation + quick_actions + advance', async () => {
    // A. 3 leads en CRM
    const contacts = [
      buildCrmContact(UID, { phone: '+5711111111', name: 'Lead A', stage: 'lead', tags: ['outreach'] }),
      buildCrmContact(UID, { phone: '+5422222222', name: 'Lead B', stage: 'lead', tags: ['outreach'] }),
      buildCrmContact(UID, { phone: '+5233333333', name: 'Lead C', stage: 'lead', tags: ['outreach'] }),
    ];
    const statsInicial = computeCrmStats(contacts);
    expect(statsInicial.byStage.lead).toBe(3);

    // B. Automation dispara para cada lead
    const rule = buildAutomationRule(UID, {
      name: 'Outreach welcome',
      triggerType: 'lead_received',
      actions: [{ type: 'send_whatsapp', template: 'welcome' }],
    });
    let updatedRule = rule;
    for (let i = 0; i < 3; i++) {
      expect(shouldTrigger(updatedRule, 'lead_received', {}, null)).toBe(true);
      updatedRule = recordExecution(updatedRule);
    }
    expect(updatedRule.executionCount).toBe(3);

    // C. Owner encola send_template para cada lead
    const enqueuedIds = [];
    for (const c of contacts) {
      const { actionId } = await enqueueAction(UID, 'send_template', {
        phone: c.phone, template: 'bienvenida', planType: 'free',
      });
      enqueuedIds.push(actionId);
    }
    const queued = await getQueuedActions(UID);
    expect(queued.length).toBe(3);

    // D. Marcar todas como done
    for (const id of enqueuedIds) {
      await updateActionStatus(UID, id, 'done', { sent: true }, null);
    }
    const afterDone = await getQueuedActions(UID);
    expect(afterDone.length).toBe(0);

    // E. Lead A responde -> prospect
    let leadA = contacts[0];
    leadA = updatePipelineStage(leadA, 'prospect');
    leadA = addTag(leadA, 'respondio');
    expect(leadA.stage).toBe('prospect');
    expect(leadA.tags).toContain('respondio');

    // F. Stats finales
    const allContacts = [leadA, contacts[1], contacts[2]];
    const statsFinal = computeCrmStats(allContacts);
    expect(statsFinal.total).toBe(3);
    expect(statsFinal.byStage.prospect).toBe(1);
    expect(statsFinal.byStage.lead).toBe(2);

    // G. Score de Lead A (prospect) mayor que Lead B/C (lead)
    const scoreA = computeLeadScore(leadA);
    const scoreB = computeLeadScore(contacts[1]);
    expect(scoreA).toBeGreaterThan(scoreB);

    // H. Resumen final de acciones en memoria
    const summary = summarizeQueue([
      { type: 'send_template', status: 'done' },
      { type: 'send_template', status: 'done' },
      { type: 'send_template', status: 'done' },
    ]);
    expect(summary.total).toBe(3);
    expect(summary.hasPendingActions).toBe(false);
  });
});
