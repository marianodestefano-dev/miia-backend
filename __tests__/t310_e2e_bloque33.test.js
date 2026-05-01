'use strict';

/**
 * T310 -- E2E Bloque 33
 * Pipeline: MIIA detecta promesa rota ("te agendé X") -> auto-repair
 * tag AGENDAR_EVENTO -> integrity stats -> CRM lead avanza -> automation
 * rule appointment_set -> quick action queued -> stats finales.
 */

const {
  attemptAutoRepair,
  getIntegrityStats,
  PROMISE_PATTERNS,
  PREFERENCE_PATTERNS,
} = require('../core/integrity_engine');

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

const {
  enqueueAction,
  updateActionStatus,
  getQueuedActions,
  summarizeQueue,
  __setFirestoreForTests: setQADb,
} = require('../core/quick_actions_engine');

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

const UID = 'owner_bloque33_001';

describe('T310 -- E2E Bloque 33: integrity + CRM + automation + quick_actions', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setCrmDb(mock.db);
    setAutoDb(mock.db);
    setQADb(mock.db);
  });

  // Paso 1: Detectar promesa rota en mensaje de MIIA

  test('Paso 1 -- detectar promesa de agenda en mensaje de MIIA', () => {
    const miiaMsg = 'te agendé la reunion con Ana para el 15 de julio';
    const match = PROMISE_PATTERNS.some(p => p.pattern.test(miiaMsg));
    expect(match).toBe(true);
    const pattern = PROMISE_PATTERNS.find(p => p.pattern.test(miiaMsg));
    expect(pattern.action).toBe('agendar');
    expect(pattern.tag).toBe('AGENDAR_EVENTO');
  });

  // Paso 2: Auto-repair genera tag AGENDAR_EVENTO

  test('Paso 2 -- auto-repair genera tag AGENDAR_EVENTO desde mensaje roto', () => {
    const miiaMsg = 'te agendé la reunion para el 15 de julio a las 10';
    const tag = attemptAutoRepair(miiaMsg, 'agendar', '+5411234567', 'Ana Martinez');
    expect(tag).not.toBeNull();
    expect(tag).toContain('[AGENDAR_EVENTO:');
    expect(tag).toContain('+5411234567');
    expect(tag).toMatch(/\d{4}-07-15T10:00:00/);
  });

  // Paso 3: Detectar preferencia del lead (aprendizaje vivo)

  test('Paso 3 -- detectar preferencia de deporte del lead', () => {
    const leadMsg = 'soy hincha de Boca Juniors y me encanta el futbol';
    const match = PREFERENCE_PATTERNS.some(p => p.pattern.test(leadMsg));
    expect(match).toBe(true);
    const pref = PREFERENCE_PATTERNS.find(p => p.pattern.test(leadMsg));
    expect(pref.type).toBe('gusto');
    expect(pref.category).toBe('deporte_o_general');
  });

  // Paso 4: CRM contact creado y avanzado

  test('Paso 4 -- lead Ana creado en CRM y avanzado a qualified tras turno', () => {
    let ana = buildCrmContact(UID, {
      phone: '+5411234567',
      name: 'Ana Martinez',
      stage: 'lead',
      tags: ['outreach'],
    });
    expect(ana.stage).toBe('lead');

    ana = updatePipelineStage(ana, 'prospect');
    ana = updatePipelineStage(ana, 'qualified');
    ana = addTag(ana, 'turno_agendado');
    expect(ana.stage).toBe('qualified');
    expect(ana.tags).toContain('turno_agendado');
  });

  // Paso 5: Automation rule appointment_set dispara

  test('Paso 5 -- automation rule appointment_set dispara al agendar turno', () => {
    const rule = buildAutomationRule(UID, {
      name: 'Notificar turno agendado',
      triggerType: 'appointment_set',
      actions: [{ type: 'send_whatsapp', template: 'turno_confirmado' }],
      conditions: [{ field: 'stage', operator: '==', value: 'qualified' }],
    });

    const context = { stage: 'qualified' };
    const fires = shouldTrigger(rule, 'appointment_set', context, null);
    expect(fires).toBe(true);

    const updated = recordExecution(rule);
    expect(updated.executionCount).toBe(1);
    expect(updated.lastExecutedAt).not.toBeNull();
  });

  // Paso 6: Quick action send_template encolada post-turno

  test('Paso 6 -- quick action send_template encolada para confirmacion de turno', async () => {
    const { actionId, record } = await enqueueAction(UID, 'send_template', {
      template: 'turno_confirmado',
      phone: '+5411234567',
      params: { fecha: '2026-07-15', hora: '10:00' },
    });
    expect(record.type).toBe('send_template');
    expect(record.status).toBe('queued');
    expect(actionId).toMatch(/^qa_/);

    await updateActionStatus(UID, actionId, 'done', { sent: true }, null);
    const queued = await getQueuedActions(UID);
    expect(queued.length).toBe(0);
  });

  // Paso 7: Integrity stats sin isRunning

  test('Paso 7 -- integrity stats disponibles sin iniciar engine', () => {
    const stats = getIntegrityStats();
    expect(stats.isRunning).toBe(false);
    expect(typeof stats.promisesDetected).toBe('number');
  });

  // Paso 8: Score del lead avanzado (qualified) es mayor que lead base

  test('Paso 8 -- score de lead qualified mayor que lead base', () => {
    const baseLead = buildCrmContact(UID, { phone: '+5411111111', name: 'Base', stage: 'lead' });
    let qualLead = buildCrmContact(UID, { phone: '+5422222222', name: 'Qualified', stage: 'lead' });
    qualLead = updatePipelineStage(qualLead, 'prospect');
    qualLead = updatePipelineStage(qualLead, 'qualified');

    const baseScore = computeLeadScore(baseLead);
    const qualScore = computeLeadScore(qualLead);
    expect(qualScore).toBeGreaterThan(baseScore);
  });

  // Pipeline completo integrado

  test('Pipeline completo -- promesa rota + auto-repair + CRM + automation + quick_action', async () => {
    // A. Mensaje de MIIA con promesa de agenda
    const miiaMsg = 'te agendé la reunion para el 20 de agosto a las 14';
    const detected = PROMISE_PATTERNS.some(p => p.pattern.test(miiaMsg));
    expect(detected).toBe(true);

    // B. Auto-repair genera tag
    const tag = attemptAutoRepair(miiaMsg, 'agendar', '+5411234567', 'Ana');
    expect(tag).not.toBeNull();
    expect(tag).toContain('[AGENDAR_EVENTO:');

    // C. Lead en CRM avanza tras turno agendado
    let ana = buildCrmContact(UID, {
      phone: '+5411234567', name: 'Ana Martinez', stage: 'lead', tags: ['outreach'],
    });
    ana = updatePipelineStage(ana, 'prospect');
    ana = updatePipelineStage(ana, 'qualified');
    ana = addTag(ana, 'turno_agendado');
    expect(ana.stage).toBe('qualified');

    // D. Automation appointment_set dispara
    const rule = buildAutomationRule(UID, {
      name: 'Confirmacion turno',
      triggerType: 'appointment_set',
      actions: [{ type: 'send_whatsapp', template: 'turno_ok' }],
    });
    const fires = shouldTrigger(rule, 'appointment_set', {}, null);
    expect(fires).toBe(true);
    const ruleUpdated = recordExecution(rule);
    expect(ruleUpdated.executionCount).toBe(1);

    // E. Quick action send_template para confirmacion
    const { actionId } = await enqueueAction(UID, 'send_template', {
      template: 'turno_confirmado', phone: '+5411234567',
    });
    await updateActionStatus(UID, actionId, 'done', { sent: true }, null);
    const queued = await getQueuedActions(UID);
    expect(queued.length).toBe(0);

    // F. Deteccion de preferencias del lead
    const prefMsg = 'vivo en Mendoza y soy médico';
    const prefs = PREFERENCE_PATTERNS.filter(p => p.pattern.test(prefMsg));
    expect(prefs.length).toBeGreaterThanOrEqual(1);

    // G. CRM stats finales
    const allContacts = [ana];
    const stats = computeCrmStats(allContacts);
    expect(stats.total).toBe(1);
    expect(stats.byStage.qualified).toBe(1);

    // H. Score final alto (qualified + tags)
    const score = computeLeadScore(ana);
    expect(score).toBeGreaterThan(20);

    // I. Resumen quick actions
    const summary = summarizeQueue([{ type: 'send_template', status: 'done' }]);
    expect(summary.hasPendingActions).toBe(false);
  });
});
