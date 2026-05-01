'use strict';

/**
 * T314 -- E2E Bloque 35
 * Pipeline: owner busca leads (conversation_search) -> detecta leads frios
 * -> outreach_engine crea cola -> leads a CRM -> automation rule ->
 * confidence_engine decide guardar preferencias del lead -> stats finales.
 */

const {
  searchContacts,
  searchMessages,
  computeRelevance,
  normalizeText,
} = require('../core/conversation_search_engine');

const {
  decideAction,
  recordFeedback,
  getPatterns,
} = require('../core/confidence_engine');

const {
  cleanPhoneNumber,
  detectCountry,
  createOutreachQueue,
  getActiveQueue,
  markLeadResponded,
  STRATEGY_BY_STATE,
} = require('../core/outreach_engine');

const {
  buildCrmContact,
  updatePipelineStage,
  addTag,
  computeCrmStats,
  __setFirestoreForTests: setCrmDb,
} = require('../core/crm_engine');

const {
  buildAutomationRule,
  shouldTrigger,
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
            }),
          }),
        }),
      }),
    },
  };
}

const UID = 'owner_bloque35_001';

describe('T314 -- E2E Bloque 35: search + confidence + outreach + CRM + automation', () => {
  beforeEach(() => {
    const state = getPatterns();
    state.patterns = [];
    state.thresholds = { auto_save: 85, ask: 70, ignore: 0 };
    const mock = makeMockDb();
    setCrmDb(mock.db);
    setAutoDb(mock.db);
  });

  test('Paso 1 -- buscar leads frios por tag', () => {
    const contacts = [
      { name: 'Ana Gomez', phone: '+5711111111', tags: ['hql', 'frio'], notes: '' },
      { name: 'Carlos Ruiz', phone: '+5722222222', tags: ['nuevo'], notes: '' },
      { name: 'Maria Lopez', phone: '+5733333333', tags: ['hql', 'frio'], notes: '' },
    ];
    const result = searchContacts(contacts, 'frio', {});
    expect(result.total).toBe(2);
    result.results.forEach(r => expect(r.matchedIn).toContain('tags'));
  });

  test('Paso 2 -- detectar pais de leads frios', () => {
    const phones = ['+5711111111', '+5722222222'];
    phones.forEach(p => {
      const clean = cleanPhoneNumber(p);
      const country = detectCountry(clean);
      expect(country.code).toBe('CO');
    });
  });

  test('Paso 3 -- crear cola outreach para leads frios', () => {
    const leads = [
      { name: 'Ana', phone: '5711111111', state: 'hql', strategy: STRATEGY_BY_STATE['hql'], status: 'pending', sentAt: null, followups: 0, responded: false },
      { name: 'Maria', phone: '5733333333', state: 'hql', strategy: STRATEGY_BY_STATE['hql'], status: 'pending', sentAt: null, followups: 0, responded: false },
    ];
    const queue = createOutreachQueue(UID + '_t314', leads);
    expect(queue.stats.total).toBe(2);
    expect(queue.status).toBe('pending');
  });

  test('Paso 4 -- leads creados en CRM', () => {
    const contacts = [
      buildCrmContact(UID, { phone: '+5711111111', name: 'Ana Gomez', stage: 'lead', tags: ['hql'] }),
      buildCrmContact(UID, { phone: '+5733333333', name: 'Maria Lopez', stage: 'lead', tags: ['hql'] }),
    ];
    const stats = computeCrmStats(contacts);
    expect(stats.byStage.lead).toBe(2);
    expect(stats.total).toBe(2);
  });

  test('Paso 5 -- automation rule lead_received dispara', () => {
    const rule = buildAutomationRule(UID, {
      name: 'Bienvenida HQL',
      triggerType: 'lead_received',
      actions: [{ type: 'send_whatsapp', template: 'bienvenida_hql' }],
    });
    expect(shouldTrigger(rule, 'lead_received', {}, null)).toBe(true);
  });

  test('Paso 6 -- Ana responde: marcada en cola + avanza CRM', () => {
    const leads = [
      { name: 'Ana', phone: '5711111111', state: 'hql', strategy: STRATEGY_BY_STATE['hql'], status: 'sent', sentAt: Date.now() - 1000, followups: 0, responded: false },
    ];
    const queue = createOutreachQueue(UID + '_t314resp', leads);
    queue.status = 'completed';
    const marked = markLeadResponded(UID + '_t314resp', '5711111111');
    expect(marked).toBe(true);

    // Avanzar en CRM
    let ana = buildCrmContact(UID, { phone: '+5711111111', name: 'Ana', stage: 'lead' });
    ana = updatePipelineStage(ana, 'prospect');
    ana = addTag(ana, 'respondio');
    expect(ana.stage).toBe('prospect');
    expect(ana.tags).toContain('respondio');
  });

  test('Paso 7 -- confidence engine decide sobre info del lead', () => {
    const leadInfo = 'trabajo en empresa con 50 empleados y presupuesto anual de 100k';
    const dec = decideAction(85, leadInfo);
    expect(dec.action).toBe('save');
    recordFeedback(leadInfo, 'yes', 85);
    const state = getPatterns();
    expect(state.patterns.length).toBeGreaterThan(0);
  });

  test('Pipeline completo -- search + outreach + CRM + automation + confidence', () => {
    // A. Buscar leads hql
    const allContacts = [
      { name: 'Ana Gomez', phone: '+5711111111', tags: ['hql'], notes: '' },
      { name: 'Pedro Ruiz', phone: '+5744444444', tags: ['nuevo'], notes: '' },
    ];
    const hqlResult = searchContacts(allContacts, 'hql', {});
    expect(hqlResult.total).toBe(1);
    expect(hqlResult.results[0].contact.name).toBe('Ana Gomez');

    // B. Verificar pais
    const clean = cleanPhoneNumber('+5711111111');
    const country = detectCountry(clean);
    expect(country.code).toBe('CO');

    // C. Cola outreach
    const leads = [
      { name: 'Ana', phone: '5711111111', state: 'hql', strategy: STRATEGY_BY_STATE['hql'],
        status: 'pending', sentAt: null, followups: 0, responded: false },
    ];
    const queue = createOutreachQueue(UID + '_full35', leads);
    expect(queue.stats.total).toBe(1);

    // D. CRM
    let ana = buildCrmContact(UID, { phone: '+5711111111', name: 'Ana Gomez', stage: 'lead', tags: ['hql'] });
    expect(ana.stage).toBe('lead');

    // E. Automation
    const rule = buildAutomationRule(UID, { name: 'Outreach HQL', triggerType: 'lead_received', actions: [] });
    expect(shouldTrigger(rule, 'lead_received', {}, null)).toBe(true);

    // F. Ana responde
    queue.status = 'completed';
    markLeadResponded(UID + '_full35', '5711111111');
    ana = updatePipelineStage(ana, 'prospect');
    expect(ana.stage).toBe('prospect');

    // G. Confidence: guardar info importante del lead
    const info = 'es gerente de ventas con equipo de 10 personas';
    const dec = decideAction(88, info);
    expect(dec.action).toBe('save');

    // H. Buscar en mensajes previos
    const messages = [{ text: 'me interesa el plan pro para mi equipo', phone: '+5711111111' }];
    const msgSearch = searchMessages(messages, 'plan pro', {});
    expect(msgSearch.total).toBe(1);

    // I. normalizeText para normalizar query del owner
    const query = normalizeText('Ana Gómez HQL');
    expect(query).toBe('ana gomez hql');

    // J. Stats CRM final
    const stats = computeCrmStats([ana]);
    expect(stats.byStage.prospect).toBe(1);
  });
});
