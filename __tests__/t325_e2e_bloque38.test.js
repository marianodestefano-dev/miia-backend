'use strict';

/**
 * T325 -- E2E Bloque 38
 * Pipeline: intent_classifier -> conversation_summarizer -> bot_detection
 * -> lead_scoring -> CRM pipeline
 */

const { classifyIntent, classifyBatch } = require('../core/intent_classifier');
const { summarizeConversation, buildContextSummary } = require('../core/conversation_summarizer');
const { calculateBotScore } = require('../core/bot_detection');
const { calculateLeadScore, classifyLeadScore } = require('../core/lead_scoring');
const {
  buildCrmContact, updatePipelineStage, addTag, computeCrmStats,
  __setFirestoreForTests: setCrmDb,
} = require('../core/crm_engine');
const { buildAutomationRule, shouldTrigger, __setFirestoreForTests: setAutoDb } = require('../core/automation_engine');

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const UID = 'owner_bloque38_001';

function makeMockDb() {
  const store = {};
  return {
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

describe('T325 -- E2E Bloque 38: intent + summarizer + bot + scoring + CRM + automation', () => {
  beforeEach(() => {
    const mock = makeMockDb();
    setCrmDb(mock.db);
    setAutoDb(mock.db);
  });

  test('Paso 1 -- clasificar intenciones de batch de mensajes', () => {
    const msgs = [
      'Hola buenas tardes',
      'Cuanto cuesta el plan mensual?',
      'Quiero agendar una demo',
      'Cuanto vale el plan anual?',
    ];
    const { dominant, results } = classifyBatch(msgs);
    expect(results.length).toBe(4);
    expect(['price', 'greeting', 'booking']).toContain(dominant);
  });

  test('Paso 2 -- detectar booking intent en lead calificado', () => {
    const msg = 'Hola, quisiera reservar una cita para conocer el servicio';
    const { intent } = classifyIntent(msg);
    expect(intent).toBe('booking');
  });

  test('Paso 3 -- bot detectado y descartado', () => {
    const botMsgs = [
      { text: 'CLICK', timestamp: NOW - 800, fromMe: false },
      { text: 'CLICK', timestamp: NOW - 700, fromMe: false },
      { text: 'CLICK', timestamp: NOW - 600, fromMe: false },
    ];
    const { verdict } = calculateBotScore(botMsgs);
    expect(verdict).toBe('bot');
  });

  test('Paso 4 -- resumir conversacion de lead calificado', () => {
    const msgs = [
      { text: 'Hola, quiero informacion', timestamp: NOW - 5 * DAY, fromMe: false },
      { text: 'Tenemos 20 empleados en Bogota', timestamp: NOW - 4 * DAY, fromMe: false },
      { text: 'El plan pro me interesa', timestamp: NOW - 3 * DAY, fromMe: false },
      { text: 'Pueden agendar una demo?', timestamp: NOW - 2 * DAY, fromMe: false },
    ];
    const summary = summarizeConversation(msgs);
    expect(summary.messageCount).toBe(4);
    expect(summary.fromContact).toBe(4);
    expect(summary.preview.length).toBeGreaterThan(0);
    expect(summary.newestTimestamp).toBe(NOW - 2 * DAY);
  });

  test('Paso 5 -- lead score a partir de conversacion', () => {
    const msgs = [
      { timestamp: NOW - 5 * DAY, text: 'Quiero informacion sobre sus planes de automatizacion' },
      { timestamp: NOW - 4 * DAY, text: 'Somos empresa de logistica con 30 empleados en Colombia' },
      { timestamp: NOW - 3 * DAY, text: 'Nos interesa agendar una demo esta semana' },
    ];
    const { score } = calculateLeadScore({
      messages: msgs,
      enrichment: { name: 'Carlos', email: 'carlos@logistica.co' },
      hasAppointment: true,
    }, NOW);
    expect(score).toBeGreaterThanOrEqual(70);
    expect(classifyLeadScore(score)).toBe('hot');
  });

  test('Paso 6 -- CRM: lead hot -> prospect + tagged', () => {
    let contact = buildCrmContact(UID, { phone: '+5712345678', name: 'Carlos Ruiz', stage: 'lead', tags: ['hot', 'demo'] });
    contact = updatePipelineStage(contact, 'prospect');
    contact = addTag(contact, 'booking_intent');
    expect(contact.stage).toBe('prospect');
    expect(contact.tags).toContain('booking_intent');
    expect(contact.stageChangedAt).toBeDefined();
  });

  test('Paso 7 -- automation appointment_set dispara', () => {
    const rule = buildAutomationRule(UID, {
      name: 'Demo agendada',
      triggerType: 'appointment_set',
      actions: [{ type: 'send_whatsapp', template: 'confirmacion_demo' }],
    });
    expect(shouldTrigger(rule, 'appointment_set', {}, null)).toBe(true);
  });

  test('Pipeline completo -- intent + bot filter + score + CRM + automation', () => {
    // A: clasificar intent lead
    const { intent } = classifyIntent('Quiero agendar una demo del producto');
    expect(intent).toBe('booking');

    // B: bot check
    const humanMsgs = [
      { text: 'Hola, vi su publicidad', timestamp: NOW - 5 * DAY, fromMe: false },
      { text: 'Cuanto cuesta el plan mensual?', timestamp: NOW - 4 * DAY, fromMe: false },
    ];
    const { verdict } = calculateBotScore(humanMsgs);
    expect(verdict).toBe('human');

    // C: summarize
    const summary = summarizeConversation(humanMsgs);
    expect(summary.messageCount).toBe(2);

    // D: score
    const { score } = calculateLeadScore({
      messages: humanMsgs,
      enrichment: { name: 'Luis', email: 'luis@empresa.co' },
    }, NOW);
    const cat = classifyLeadScore(score);
    expect(['hot', 'warm']).toContain(cat);

    // E: CRM
    let contact = buildCrmContact(UID, { phone: '+5798765432', name: 'Luis', stage: 'lead' });
    contact = updatePipelineStage(contact, 'prospect');
    expect(contact.stage).toBe('prospect');

    // F: automation
    const rule = buildAutomationRule(UID, { name: 'Lead calificado', triggerType: 'lead_received', actions: [] });
    expect(shouldTrigger(rule, 'lead_received', {}, null)).toBe(true);

    // G: stats
    const stats = computeCrmStats([contact]);
    expect(stats.byStage.prospect).toBe(1);
  });
});
