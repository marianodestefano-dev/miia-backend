'use strict';

/**
 * T317 -- E2E Bloque 36
 * Pipeline: detectar bot -> score lead -> clasificar -> CRM + automation
 */

const { calculateBotScore } = require('../core/bot_detection');
const { calculateLeadScore, classifyLeadScore } = require('../core/lead_scoring');
const { buildCrmContact, updatePipelineStage, addTag, computeCrmStats, __setFirestoreForTests: setCrmDb } = require('../core/crm_engine');
const { buildAutomationRule, shouldTrigger, __setFirestoreForTests: setAutoDb } = require('../core/automation_engine');

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const UID = 'owner_bloque36_001';

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

describe('T317 -- E2E Bloque 36: bot_detection + lead_scoring + CRM + automation', () => {
  beforeEach(() => {
    const mock = makeMockDb();
    setCrmDb(mock.db);
    setAutoDb(mock.db);
  });

  test('Paso 1 -- contacto con muchos mensajes rapidos es bot', () => {
    const messages = [
      { text: 'hola', timestamp: NOW - 500, fromMe: false },
      { text: 'hola', timestamp: NOW - 400, fromMe: false },
      { text: 'hola', timestamp: NOW - 300, fromMe: false },
      { text: 'hola', timestamp: NOW - 200, fromMe: false },
    ];
    const { score, verdict } = calculateBotScore(messages);
    expect(score).toBeGreaterThanOrEqual(60);
    expect(verdict).toBe('bot');
  });

  test('Paso 2 -- contacto humano no es bot', () => {
    const messages = [
      { text: 'Hola, me interesa saber mas sobre el servicio de MIIA para mi negocio', timestamp: NOW - 10 * DAY, fromMe: false },
      { text: 'Cuanto cuesta el plan basico?', timestamp: NOW - 9 * DAY, fromMe: false },
      { text: 'Ok muchas gracias, lo voy a pensar y les aviso', timestamp: NOW - 8 * DAY, fromMe: false },
    ];
    const { verdict } = calculateBotScore(messages);
    expect(verdict).toBe('human');
  });

  test('Paso 3 -- lead humano calificado tiene score alto', () => {
    const msgs = [
      { timestamp: NOW - 3 * DAY, text: 'Me interesa el plan pro para mi empresa de 20 empleados' },
      { timestamp: NOW - 2 * DAY, text: 'Tienen soporte en Colombia? Somos de Bogota y necesitamos atencion local' },
      { timestamp: NOW - 1 * DAY, text: 'Perfecto, cuando podemos agendar una demo?' },
    ];
    const { score, breakdown } = calculateLeadScore({
      messages: msgs,
      enrichment: { email: 'ana@empresa.co', name: 'Ana Gomez' },
      hasAppointment: true,
    }, NOW);
    expect(score).toBeGreaterThanOrEqual(70);
    expect(breakdown.hasEmail).toBe(15);
    expect(breakdown.hasName).toBe(10);
    expect(breakdown.hasAppointment).toBe(20);
    expect(breakdown.recentActivity).toBe(20);
  });

  test('Paso 4 -- clasificar lead como hot', () => {
    const classification = classifyLeadScore(75);
    expect(classification).toBe('hot');
  });

  test('Paso 5 -- lead hot se crea en CRM como prospect', () => {
    let contact = buildCrmContact(UID, {
      phone: '+5711112222',
      name: 'Ana Gomez',
      stage: 'lead',
      tags: ['hot', 'demo_agendada'],
    });
    contact = updatePipelineStage(contact, 'prospect');
    contact = addTag(contact, 'score_alto');
    expect(contact.stage).toBe('prospect');
    expect(contact.tags).toContain('score_alto');
    expect(contact.tags).toContain('hot');
  });

  test('Paso 6 -- automation dispara appointment_set para lead hot', () => {
    const rule = buildAutomationRule(UID, {
      name: 'Demo agendada HQL',
      triggerType: 'appointment_set',
      actions: [{ type: 'send_whatsapp', template: 'confirmacion_demo' }],
    });
    expect(shouldTrigger(rule, 'appointment_set', {}, null)).toBe(true);
  });

  test('Paso 7 -- computeCrmStats con mix lead/prospect', () => {
    const contacts = [
      buildCrmContact(UID, { phone: '+5711112222', name: 'Ana', stage: 'lead' }),
      buildCrmContact(UID, { phone: '+5733334444', name: 'Carlos', stage: 'prospect' }),
      buildCrmContact(UID, { phone: '+5755556666', name: 'Maria', stage: 'prospect' }),
    ];
    const stats = computeCrmStats(contacts);
    expect(stats.total).toBe(3);
    expect(stats.byStage.lead).toBe(1);
    expect(stats.byStage.prospect).toBe(2);
  });

  test('Pipeline completo -- bot filtrado, lead calificado avanza a prospect', () => {
    // A: bot detectado y descartado
    const botMsgs = [
      { text: 'PROMO', timestamp: NOW - 800, fromMe: false },
      { text: 'PROMO', timestamp: NOW - 700, fromMe: false },
      { text: 'PROMO', timestamp: NOW - 600, fromMe: false },
    ];
    const { verdict: botVerdict } = calculateBotScore(botMsgs);
    expect(botVerdict).toBe('bot');

    // B: lead humano calificado
    const humanMsgs = [
      { timestamp: NOW - 5 * DAY, text: 'Hola, quiero info sobre los planes de MIIA para mi restaurante' },
      { timestamp: NOW - 4 * DAY, text: 'Tenemos 3 sucursales en Bogota y necesitamos automatizar respuestas' },
    ];
    const { score } = calculateLeadScore({
      messages: humanMsgs,
      enrichment: { email: 'carlos@restaurante.co', name: 'Carlos Ruiz' },
    }, NOW);
    const category = classifyLeadScore(score);
    expect(['hot', 'warm']).toContain(category);

    // C: CRM + avance pipeline
    let contact = buildCrmContact(UID, { phone: '+5799998888', name: 'Carlos Ruiz', stage: 'lead' });
    contact = updatePipelineStage(contact, 'prospect');
    expect(contact.stage).toBe('prospect');

    // D: automation
    const rule = buildAutomationRule(UID, { name: 'Lead calificado', triggerType: 'lead_received', actions: [] });
    expect(shouldTrigger(rule, 'lead_received', {}, null)).toBe(true);

    // E: stats finales
    const stats = computeCrmStats([contact]);
    expect(stats.byStage.prospect).toBe(1);
  });
});
