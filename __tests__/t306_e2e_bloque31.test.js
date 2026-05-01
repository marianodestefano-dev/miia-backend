'use strict';

/**
 * T306 -- E2E Bloque 31
 * Pipeline: owner envia screenshot con leads (outreach) -> parseo imagen ->
 * 3 leads detectados (CO) -> cola creada -> leads a CRM -> automation rules
 * -> lead responde -> followup -> stats CRM + pipeline completo.
 */

const {
  isImageCommand,
  parseScreenshotResponse,
  detectCountry,
  cleanPhoneNumber,
  createOutreachQueue,
  getActiveQueue,
  markLeadResponded,
  getLeadsForFollowup,
  extractPlanTags,
  STRATEGY_BY_STATE,
} = require('../core/outreach_engine');

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
            where: (field, op, val) => {
              const chain = { filters: [[field, op, val]] };
              chain.where = (f2, op2, v2) => { chain.filters.push([f2, op2, v2]); return chain; };
              chain.get = async () => {
                const all = Object.values((store[uid] || {})[subCol] || {});
                const filtered = all.filter(r => chain.filters.every(([f, o, v]) => o === '==' ? r[f] === v : true));
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

const UID = 'owner_bloque31_001';

describe('T306 -- E2E Bloque 31: outreach + CRM + automation pipeline', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setCrmDb(mock.db);
    setAutoDb(mock.db);
  });

  // Paso 1: Detectar comando de outreach en self-chat

  test('Paso 1 -- owner envia imagen con "contactalos" detectado como outreach', () => {
    const r = isImageCommand('contactalos a estos leads', true);
    expect(r.isCommand).toBe(true);
    expect(r.type).toBe('outreach');

    // Sin imagen no es comando
    const r2 = isImageCommand('contactalos', false);
    expect(r2.isCommand).toBe(false);
  });

  // Paso 2: Parsear screenshot con 3 leads Colombia

  test('Paso 2 -- parsear screenshot retorna 3 leads Colombia', () => {
    const mockResponse = JSON.stringify({
      type: 'contacts_list',
      source: 'HubSpot',
      summary: '3 leads nuevos de Colombia',
      contacts: [
        { name: 'Carlos Ruiz', phone: '+573161234567', state: 'hql' },
        { name: 'Maria Torres', phone: '+573002345678', state: 'nuevo' },
        { name: 'Luis Gomez', phone: '+573113456789', state: 'llamar' },
      ],
      actionable: true,
      suggested_actions: ['contactalos', 'guardar en CRM'],
    });

    const result = parseScreenshotResponse(mockResponse);
    expect(result.type).toBe('contacts_list');
    expect(result.leads.length).toBe(3);
    expect(result.errors.length).toBe(0);

    // Todos de Colombia
    result.leads.forEach(l => {
      expect(l.country.code).toBe('CO');
    });
  });

  // Paso 3: Detectar pais por telefono

  test('Paso 3 -- detectar pais por prefijo telefonico', () => {
    const phones = ['+573161234567', '+573002345678', '+573113456789'];
    phones.forEach(p => {
      const clean = cleanPhoneNumber(p);
      const country = detectCountry(clean);
      expect(country.code).toBe('CO');
      expect(country.name).toBe('Colombia');
    });
  });

  // Paso 4: Crear cola de outreach con los 3 leads

  test('Paso 4 -- cola de outreach creada con 3 leads ordenados', () => {
    const leads = [
      { name: 'Carlos', phone: '573161234567', state: 'hql', strategy: STRATEGY_BY_STATE['hql'], status: 'pending', sentAt: null, followups: 0, responded: false },
      { name: 'Maria', phone: '573002345678', state: 'nuevo', strategy: STRATEGY_BY_STATE['nuevo'], status: 'pending', sentAt: null, followups: 0, responded: false },
      { name: 'Luis', phone: '573113456789', state: 'llamar', strategy: STRATEGY_BY_STATE['llamar'], status: 'pending', sentAt: null, followups: 0, responded: false },
    ];

    const queue = createOutreachQueue(UID + '_paso4', leads);
    expect(queue.stats.total).toBe(3);
    expect(queue.status).toBe('pending');
    expect(queue.leads.length).toBe(3);
  });

  // Paso 5: Leads ingresados a CRM

  test('Paso 5 -- 3 leads creados en CRM como lead stage', () => {
    const contacts = [
      buildCrmContact(UID, { phone: '+573161234567', name: 'Carlos Ruiz', stage: 'lead', tags: ['outreach', 'colombia'] }),
      buildCrmContact(UID, { phone: '+573002345678', name: 'Maria Torres', stage: 'lead', tags: ['outreach', 'colombia'] }),
      buildCrmContact(UID, { phone: '+573113456789', name: 'Luis Gomez', stage: 'lead', tags: ['outreach', 'colombia', 'hot'] }),
    ];

    contacts.forEach(c => {
      expect(c.stage).toBe('lead');
      expect(c.tags).toContain('outreach');
      expect(c.tags).toContain('colombia');
    });

    const stats = computeCrmStats(contacts);
    expect(stats.total).toBe(3);
    expect(stats.byStage.lead).toBe(3);
  });

  // Paso 6: Automation rule dispara al recibir lead de outreach

  test('Paso 6 -- automation rule lead_received dispara para outreach', () => {
    const rule = buildAutomationRule(UID, {
      name: 'Bienvenida Outreach CO',
      triggerType: 'lead_received',
      actions: [{ type: 'send_whatsapp', template: 'welcome_co' }],
      conditions: [{ field: 'country', operator: '==', value: 'CO' }],
    });

    const context = { country: 'CO' };
    const result = shouldTrigger(rule, 'lead_received', context, null);
    expect(result).toBe(true);

    const updated = recordExecution(rule);
    expect(updated.executionCount).toBe(1);
  });

  // Paso 7: Lead avanza en pipeline CRM

  test('Paso 7 -- lead Carlos avanza de lead a prospect', () => {
    let carlos = buildCrmContact(UID, {
      phone: '+573161234567',
      name: 'Carlos Ruiz',
      stage: 'lead',
    });

    carlos = updatePipelineStage(carlos, 'prospect');
    expect(carlos.stage).toBe('prospect');
    expect(carlos.stageChangedAt).toBeGreaterThan(0);

    carlos = addTag(carlos, 'respondio_outreach');
    expect(carlos.tags).toContain('respondio_outreach');
  });

  // Paso 8: Lead responde -> marcado en cola

  test('Paso 8 -- lead Carlos responde, marcado en cola', () => {
    const UID_Q = UID + '_paso8';
    const leads = [
      { name: 'Carlos', phone: '573161234567', state: 'hql', strategy: STRATEGY_BY_STATE['hql'], status: 'sent', sentAt: Date.now() - 1000, followups: 0, responded: false },
      { name: 'Maria', phone: '573002345678', state: 'nuevo', strategy: STRATEGY_BY_STATE['nuevo'], status: 'sent', sentAt: Date.now() - 1000, followups: 0, responded: false },
    ];
    const queue = createOutreachQueue(UID_Q, leads);
    queue.status = 'completed';

    const marked = markLeadResponded(UID_Q, '573161234567');
    expect(marked).toBe(true);
    expect(queue.stats.responded).toBe(1);

    // Maria no respondio
    expect(queue.leads.find(l => l.name === 'Maria').responded).toBe(false);
  });

  // Paso 9: Follow-up para leads que no respondieron

  test('Paso 9 -- follow-up para leads que no respondieron despues de 24h', () => {
    const UID_Q = UID + '_paso9';
    const PAST_24H = Date.now() - 25 * 60 * 60 * 1000;
    const leads = [
      { name: 'Maria', phone: '573002345678', state: 'nuevo', strategy: STRATEGY_BY_STATE['nuevo'], status: 'sent', sentAt: PAST_24H, followups: 0, responded: false },
      { name: 'Luis', phone: '573113456789', state: 'llamar', strategy: STRATEGY_BY_STATE['llamar'], status: 'sent', sentAt: Date.now(), followups: 0, responded: false },
    ];
    const queue = createOutreachQueue(UID_Q, leads);
    queue.status = 'completed';

    const forFollowup = getLeadsForFollowup(UID_Q);
    expect(forFollowup.length).toBe(1);
    expect(forFollowup[0].name).toBe('Maria');
  });

  // Pipeline completo integrado

  test('Pipeline completo -- outreach+CRM+automation+respondio+followup', () => {
    const UID_FULL = UID + '_full';

    // A. Detectar comando
    const cmd = isImageCommand('hazte cargo de estos leads', true);
    expect(cmd.type).toBe('outreach');

    // B. Parsear screenshot
    const mockJson = JSON.stringify({
      type: 'contacts_list',
      source: 'HubSpot',
      contacts: [
        { name: 'Carlos', phone: '+573161234567', state: 'hql' },
        { name: 'Maria', phone: '+573002345678', state: 'nuevo' },
      ],
      actionable: true,
      suggested_actions: [],
    });
    const parsed = parseScreenshotResponse(mockJson);
    expect(parsed.leads.length).toBe(2);
    parsed.leads.forEach(l => expect(l.country.code).toBe('CO'));

    // C. Crear cola
    const leads = parsed.leads.map(l => ({
      ...l, status: 'pending', sentAt: null, followups: 0, responded: false,
    }));
    const queue = createOutreachQueue(UID_FULL, leads);
    expect(queue.stats.total).toBe(2);

    // D. CRM contacts (crm_engine usa phone/name/stage)
    const crmContacts = parsed.leads.map(l =>
      buildCrmContact(UID, { phone: '+' + l.phone, name: l.name, stage: 'lead', tags: ['outreach'] })
    );
    crmContacts.forEach(c => expect(c.stage).toBe('lead'));

    // E. Automation
    const rule = buildAutomationRule(UID, {
      name: 'Lead CO bienvenida',
      triggerType: 'lead_received',
      actions: [{ type: 'send_whatsapp', template: 'bienvenida' }],
    });
    const trigger = shouldTrigger(rule, 'lead_received', {}, null);
    expect(trigger).toBe(true);

    // F. Simular envio: sentAt = pasado
    leads[0].status = 'sent';
    leads[0].sentAt = Date.now() - 26 * 60 * 60 * 1000; // 26h ago
    leads[1].status = 'sent';
    leads[1].sentAt = Date.now() - 26 * 60 * 60 * 1000; // 26h ago - para que califique followup
    queue.status = 'completed';
    queue.stats.sent = 2;

    // G. Carlos responde
    leads[0].responded = true;
    leads[0].status = 'responded';
    queue.stats.responded = 1;

    // H. Maria no respondio -> followup
    const followupLeads = getLeadsForFollowup(UID_FULL);
    expect(followupLeads.length).toBe(1);
    expect(followupLeads[0].name).toBe('Maria');

    // I. Avanzar Carlos a prospect en CRM
    let carlos = crmContacts[0];
    carlos = updatePipelineStage(carlos, 'prospect');
    carlos = addTag(carlos, 'respondio');
    expect(carlos.stage).toBe('prospect');
    expect(carlos.tags).toContain('respondio');

    // J. Score de Carlos
    const score = computeLeadScore(carlos);
    expect(score).toBeGreaterThan(10);

    // K. Plan tags en respuesta IA
    const { plans, cleanText } = extractPlanTags('Te mando los detalles [ENVIAR_PLAN:pro]');
    expect(plans).toContain('pro');
    expect(cleanText).not.toContain('[ENVIAR_PLAN:pro]');

    // L. Stats CRM final
    const allContacts = [...crmContacts];
    allContacts[0] = carlos; // Carlos avanzado
    const stats = computeCrmStats(allContacts);
    expect(stats.total).toBe(2);
  });
});
