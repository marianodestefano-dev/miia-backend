'use strict';

/**
 * T321 -- E2E Bloque 37
 * Pipeline: dashboard summary -> contact history -> lead scoring -> bot detection -> CRM
 */

const { buildDashboardSummary, __setFirestoreForTests: setDashDb } = require('../core/dashboard_summary');
const { getContactHistory, __setFirestoreForTests: setHistDb } = require('../core/contact_history');
const { calculateLeadScore, classifyLeadScore } = require('../core/lead_scoring');
const { calculateBotScore } = require('../core/bot_detection');
const {
  buildCrmContact, updatePipelineStage, addTag, computeCrmStats,
  __setFirestoreForTests: setCrmDb,
} = require('../core/crm_engine');

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const UID = 'owner_bloque37_001';

function makeFullMockDb(conversations, contactTypes) {
  return {
    collection: (col) => ({
      doc: (docUid) => ({
        collection: (subCol) => ({
          doc: (docId) => ({
            get: async () => {
              if (col === 'users' && subCol === 'miia_persistent' && docId === 'tenant_conversations') {
                return { exists: true, data: () => ({ conversations: conversations || {}, contactTypes: contactTypes || {} }) };
              }
              return { exists: false };
            },
            set: async () => {},
          }),
        }),
      }),
    }),
  };
}

describe('T321 -- E2E Bloque 37: dashboard + history + scoring + bot + CRM', () => {
  const conversations = {
    '+5711112222': [
      { text: 'Hola, quiero info del plan pro', timestamp: NOW - 5 * DAY, fromMe: false },
      { text: 'Cual es el precio mensual?', timestamp: NOW - 4 * DAY, fromMe: false },
      { text: 'Tenemos 15 empleados en Bogota', timestamp: NOW - 3 * DAY, fromMe: false },
    ],
    '+5733334444': [
      { text: 'PROMO', timestamp: NOW - 500, fromMe: false },
      { text: 'PROMO', timestamp: NOW - 400, fromMe: false },
      { text: 'PROMO', timestamp: NOW - 300, fromMe: false },
    ],
  };
  const contactTypes = {
    '+5711112222': 'lead',
    '+5733334444': 'lead',
  };

  beforeEach(() => {
    const db = makeFullMockDb(conversations, contactTypes);
    setDashDb(db);
    setHistDb(db);
    setCrmDb(db);
  });

  test('Paso 1 -- dashboard muestra 2 convs y 2 leads', async () => {
    const summary = await buildDashboardSummary(UID, NOW);
    expect(summary.totalConversations).toBe(2);
    expect(summary.totalLeads).toBe(2);
    expect(summary.recentMessageCount).toBeGreaterThan(0);
  });

  test('Paso 2 -- historial de lead Ana ordenado desc', async () => {
    const hist = await getContactHistory(UID, '+5711112222', { limit: 10 });
    expect(hist.messages.length).toBe(3);
    // Mas reciente primero (3 dias < 4 dias)
    expect(hist.messages[0].timestamp).toBeGreaterThan(hist.messages[1].timestamp);
  });

  test('Paso 3 -- bot detectado en +5733334444', () => {
    const botMsgs = conversations['+5733334444'];
    const { verdict, score } = calculateBotScore(botMsgs);
    expect(verdict).toBe('bot');
    expect(score).toBeGreaterThanOrEqual(60);
  });

  test('Paso 4 -- lead Ana calificado como warm o hot', () => {
    const msgs = conversations['+5711112222'].map(m => ({
      timestamp: m.timestamp,
      text: m.text,
    }));
    const { score } = calculateLeadScore({ messages: msgs, enrichment: { name: 'Ana', email: 'ana@empresa.co' } }, NOW);
    const cat = classifyLeadScore(score);
    expect(['hot', 'warm']).toContain(cat);
  });

  test('Paso 5 -- CRM: Ana avanza de lead a prospect', () => {
    let ana = buildCrmContact(UID, { phone: '+5711112222', name: 'Ana', stage: 'lead', tags: ['hql'] });
    ana = updatePipelineStage(ana, 'prospect');
    ana = addTag(ana, 'calificada');
    expect(ana.stage).toBe('prospect');
    expect(ana.tags).toContain('calificada');
    expect(ana.stageChangedAt).toBeDefined();
  });

  test('Paso 6 -- stats CRM post-clasificacion', () => {
    const bot = buildCrmContact(UID, { phone: '+5733334444', name: 'Bot', stage: 'lead' });
    let ana = buildCrmContact(UID, { phone: '+5711112222', name: 'Ana', stage: 'lead' });
    ana = updatePipelineStage(ana, 'prospect');
    const stats = computeCrmStats([bot, ana]);
    expect(stats.total).toBe(2);
    expect(stats.byStage.lead).toBe(1);
    expect(stats.byStage.prospect).toBe(1);
  });

  test('Pipeline completo -- dashboard -> historial -> bot filter -> score -> CRM avance', async () => {
    // A: dashboard
    const summary = await buildDashboardSummary(UID, NOW);
    expect(summary.totalConversations).toBe(2);

    // B: historial Ana
    const hist = await getContactHistory(UID, '+5711112222');
    expect(hist.messages.length).toBeGreaterThan(0);

    // C: bot check para +5733334444
    const { verdict } = calculateBotScore(conversations['+5733334444']);
    expect(verdict).toBe('bot');

    // D: score Ana
    const { score } = calculateLeadScore({
      messages: hist.messages,
      enrichment: { name: 'Ana Gomez' },
    }, NOW);
    expect(score).toBeGreaterThan(0);

    // E: CRM Ana -> prospect
    let ana = buildCrmContact(UID, { phone: '+5711112222', name: 'Ana Gomez', stage: 'lead' });
    ana = updatePipelineStage(ana, 'prospect');
    expect(ana.stage).toBe('prospect');

    // F: stats finales
    const stats = computeCrmStats([ana]);
    expect(stats.byStage.prospect).toBe(1);
  });
});
