'use strict';

/**
 * T312 -- E2E Bloque 34
 * Pipeline: lead dice algo importante -> confidence_engine decide guardar
 * -> conversation_search_engine busca lead en CRM -> CRM contact actualizado
 * -> automation rule fires -> stats finales.
 */

const {
  decideAction,
  findSimilarPatterns,
  recordFeedback,
  getPatterns,
} = require('../core/confidence_engine');

const {
  searchContacts,
  searchMessages,
  searchAll,
  computeRelevance,
  normalizeText,
  SEARCH_MODES,
} = require('../core/conversation_search_engine');

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
            }),
          }),
        }),
      }),
    },
  };
}

const UID = 'owner_bloque34_001';

describe('T312 -- E2E Bloque 34: confidence + search + CRM + automation', () => {
  beforeEach(() => {
    const state = getPatterns();
    state.patterns = [];
    state.thresholds = { auto_save: 85, ask: 70, ignore: 0 };
    const mock = makeMockDb();
    setCrmDb(mock.db);
    setAutoDb(mock.db);
  });

  test('Paso 1 -- lead dice algo importante (90 score) -> save decision', () => {
    const text = 'nuestros precios son fijos y no hacemos descuentos a ningun cliente';
    const decision = decideAction(90, text);
    expect(decision.action).toBe('save');
    expect(decision.confidence).toBeGreaterThanOrEqual(85);
  });

  test('Paso 2 -- buscar lead por nombre en CRM contacts', () => {
    const contacts = [
      { name: 'Ana Martinez', phone: '+5411234567', tags: ['lead'] },
      { name: 'Carlos Ruiz', phone: '+5422345678', tags: ['prospect'] },
      { name: 'Maria Lopez', phone: '+5433456789', tags: ['lead'] },
    ];
    const result = searchContacts(contacts, 'Ana', {});
    expect(result.total).toBe(1);
    expect(result.results[0].contact.name).toBe('Ana Martinez');
    expect(result.results[0].matchedIn).toContain('name');
  });

  test('Paso 3 -- buscar en conversaciones por keyword', () => {
    const messages = [
      { phone: '+5411234567', text: 'quiero saber el precio del plan mensual', ts: Date.now() - 1000 },
      { phone: '+5411234567', text: 'gracias por la informacion de precios', ts: Date.now() - 500 },
      { phone: '+5422345678', text: 'hola buenos dias como estan', ts: Date.now() },
    ];
    const result = searchMessages(messages, 'precio', {});
    expect(result.total).toBe(2);
    result.results.forEach(r => {
      expect(r.snippet).not.toBe('');
    });
  });

  test('Paso 4 -- searchAll combina contacts y messages', () => {
    const contacts = [{ name: 'Precio Plus', phone: '+5411111111', tags: [] }];
    const messages = [{ text: 'el precio es 100 dolares', phone: '+5411111111' }];
    const result = searchAll(contacts, messages, 'precio', {});
    expect(result.mode).toBe('all');
    expect(result.totalResults).toBeGreaterThanOrEqual(2);
    expect(result.contacts.total).toBeGreaterThanOrEqual(1);
    expect(result.conversations.total).toBeGreaterThanOrEqual(1);
  });

  test('Paso 5 -- lead encontrado avanza en CRM', () => {
    let ana = buildCrmContact(UID, {
      phone: '+5411234567', name: 'Ana Martinez', stage: 'lead',
    });
    ana = updatePipelineStage(ana, 'prospect');
    ana = addTag(ana, 'dato_importante_guardado');
    expect(ana.stage).toBe('prospect');
    expect(ana.tags).toContain('dato_importante_guardado');
  });

  test('Paso 6 -- automation rule message_important dispara', () => {
    const rule = buildAutomationRule(UID, {
      name: 'Guardar dato importante',
      triggerType: 'custom',
      actions: [{ type: 'save_to_crm', field: 'notes' }],
    });
    const fires = shouldTrigger(rule, 'custom', {}, null);
    expect(fires).toBe(true);
    const updated = recordExecution(rule);
    expect(updated.executionCount).toBe(1);
  });

  test('Paso 7 -- recordFeedback mejora decision futura', () => {
    const text = 'precio plan mensual esencial empresa mediana';
    recordFeedback(text, 'yes', 80);

    // Ahora con patrones confirmados, boost de confianza
    const state = getPatterns();
    const yesCount = state.patterns.filter(p => p.feedback === 'yes').length;
    expect(yesCount).toBeGreaterThan(0);
  });

  test('Pipeline completo -- confidence + search + CRM + automation', () => {
    // A. Lead dice algo importante
    const leadText = 'nuestros precios son fijos, no hay descuentos';
    const decision = decideAction(90, leadText);
    expect(decision.action).toBe('save');

    // B. Guardar feedback
    recordFeedback(leadText, 'yes', 90);

    // C. Buscar lead en contactos CRM
    const contacts = [
      { name: 'Carlos Ruiz', phone: '+5422222222', tags: ['vip'], notes: '' },
      { name: 'Ana Martinez', phone: '+5411111111', tags: ['lead'], notes: 'precio consultado' },
    ];
    const searchResult = searchContacts(contacts, 'Ana', { limit: 5 });
    expect(searchResult.total).toBe(1);
    const foundContact = searchResult.results[0].contact;
    expect(foundContact.name).toBe('Ana Martinez');

    // D. Buscar en mensajes
    const messages = [{ text: 'el precio es fijo sin descuentos', phone: foundContact.phone }];
    const msgResult = searchMessages(messages, 'precio', {});
    expect(msgResult.total).toBe(1);
    expect(msgResult.results[0].snippet).toContain('precio');

    // E. CRM contact avanza
    let ana = buildCrmContact(UID, {
      phone: foundContact.phone, name: foundContact.name, stage: 'lead',
    });
    ana = updatePipelineStage(ana, 'prospect');
    expect(ana.stage).toBe('prospect');

    // F. Automation dispara
    const rule = buildAutomationRule(UID, {
      name: 'Dato guardado -> notificar', triggerType: 'custom',
      actions: [{ type: 'notify_owner' }],
    });
    expect(shouldTrigger(rule, 'custom', {}, null)).toBe(true);

    // G. Stats CRM
    const stats = computeCrmStats([ana]);
    expect(stats.total).toBe(1);
    expect(stats.byStage.prospect).toBe(1);

    // H. normalizeText funciona para queries
    const normalized = normalizeText('Pregunta: ¿Cuál es el PRECIO?');
    expect(normalized).not.toContain('?');
    expect(normalized).toBe(normalized.toLowerCase());
  });
});
