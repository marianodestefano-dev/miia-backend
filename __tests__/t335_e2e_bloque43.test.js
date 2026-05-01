'use strict';

/**
 * T335 -- E2E Bloque 43
 * Pipeline: contact_gate (decide si responder) -> lead clasificado -> CRM -> notification
 */

const {
  shouldMiiaRespond, matchesBusinessKeywords, classifyUnknownContact,
} = require('../core/contact_gate');
const { classifyIntent } = require('../core/intent_classifier');
const { calculateBotScore } = require('../core/bot_detection');
const {
  buildCrmContact, updatePipelineStage, addTag, computeCrmStats,
  __setFirestoreForTests: setCrmDb,
} = require('../core/crm_engine');
const { createNotification, __setFirestoreForTests: setNotifDb } = require('../core/notification_manager');

const UID = 'owner_bloque43_001';
const LEAD_PHONE = '+5711112222';
const BOT_PHONE = '+5733334444';
const NOW = Date.now();

function makeMockDb() {
  const store = {};
  return {
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
            get: async () => ({ exists: false }),
          }),
          get: async () => ({ docs: [] }),
        }),
      }),
    }),
  };
}

const BIZ_KEYWORDS = ['automatizacion', 'MIIA', 'plan pro', 'demo'];

describe('T335 -- E2E Bloque 43: contact_gate + intent + bot + CRM + notification', () => {
  beforeEach(() => {
    const db = makeMockDb();
    setCrmDb(db);
    setNotifDb(db);
  });

  test('Paso 1 -- grupo bloqueado siempre', () => {
    const r = shouldMiiaRespond({ isSelfChat: false, isGroup: true, basePhone: BOT_PHONE });
    expect(r.respond).toBe(false);
    expect(r.reason).toBe('group_blocked');
  });

  test('Paso 2 -- bot detectado', () => {
    const msgs = [
      { text: 'PROMO', timestamp: NOW - 900, fromMe: false },
      { text: 'PROMO', timestamp: NOW - 800, fromMe: false },
      { text: 'PROMO', timestamp: NOW - 700, fromMe: false },
    ];
    const { verdict } = calculateBotScore(msgs);
    expect(verdict).toBe('bot');
  });

  test('Paso 3 -- lead con keyword match aprobado', () => {
    const gate = shouldMiiaRespond({
      isSelfChat: false, isGroup: false, contactType: null,
      messageBody: 'Hola, quiero saber sobre automatizacion de mi negocio',
      businessKeywords: BIZ_KEYWORDS,
      basePhone: LEAD_PHONE,
    });
    expect(gate.respond).toBe(true);
    expect(gate.reason).toBe('keyword_match');
    expect(gate.matchedKeyword).toBe('automatizacion');
  });

  test('Paso 4 -- clasificar contacto como lead', () => {
    const classified = classifyUnknownContact(
      'me interesa el plan pro de MIIA',
      BIZ_KEYWORDS, []
    );
    expect(classified.type).toBe('lead');
  });

  test('Paso 5 -- intent del lead: price o booking', () => {
    const { intent } = classifyIntent('Cuanto cuesta el plan pro? Quiero agendar una demo');
    expect(['price', 'booking']).toContain(intent);
  });

  test('Paso 6 -- CRM: nuevo lead -> prospect', () => {
    let contact = buildCrmContact(UID, {
      phone: LEAD_PHONE,
      name: 'Ana Gomez',
      stage: 'lead',
      tags: ['keyword_match', 'automatizacion'],
    });
    contact = updatePipelineStage(contact, 'prospect');
    contact = addTag(contact, 'demo_solicitada');
    expect(contact.stage).toBe('prospect');
    expect(contact.tags).toContain('demo_solicitada');
  });

  test('Paso 7 -- notificacion de nuevo lead calificado', async () => {
    const notif = await createNotification(UID, {
      type: 'success',
      title: 'Nuevo lead calificado via keyword',
      body: `Ana Gomez (+5711112222) matcheó keyword "automatizacion"`,
    });
    expect(notif.type).toBe('success');
    expect(notif.read).toBe(false);
  });

  test('Pipeline completo -- gate + bot filter + classify + CRM + notif', async () => {
    // A: bot rechazado
    const botMsgs = [
      { text: 'SPAM', timestamp: NOW - 900, fromMe: false },
      { text: 'SPAM', timestamp: NOW - 800, fromMe: false },
      { text: 'SPAM', timestamp: NOW - 700, fromMe: false },
    ];
    const { verdict } = calculateBotScore(botMsgs);
    expect(verdict).toBe('bot');

    // B: lead aprobado por contact_gate
    const gate = shouldMiiaRespond({
      isSelfChat: false, isGroup: false, contactType: null,
      messageBody: 'Quisiera saber sobre el plan MIIA para mi empresa',
      businessKeywords: BIZ_KEYWORDS,
      basePhone: LEAD_PHONE,
    });
    expect(gate.respond).toBe(true);
    expect(gate.matchedKeyword).toBe('MIIA');

    // C: clasificado como lead
    const classified = classifyUnknownContact('plan MIIA empresa', BIZ_KEYWORDS, []);
    expect(classified.type).toBe('lead');

    // D: intent
    const { intent } = classifyIntent('quiero saber cuanto cuesta el plan MIIA');
    expect(intent).toBe('price');

    // E: CRM
    let contact = buildCrmContact(UID, { phone: LEAD_PHONE, name: 'Carlos', stage: 'lead' });
    contact = updatePipelineStage(contact, 'prospect');
    expect(contact.stage).toBe('prospect');

    // F: notif
    const notif = await createNotification(UID, { type: 'info', title: 'Lead via gate', body: 'MIIA keyword match' });
    expect(notif.notifId).toMatch(/^n_/);

    // G: stats
    const stats = computeCrmStats([contact]);
    expect(stats.byStage.prospect).toBe(1);
  });
});
