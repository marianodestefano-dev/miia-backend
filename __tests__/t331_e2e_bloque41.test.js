'use strict';

/**
 * T331 -- E2E Bloque 41
 * Pipeline: anti_loop_input (filtro bot) -> owner_rate_limiter -> intent -> CRM
 */

const { shouldRegenerate, recordInput, _resetForTests } = require('../core/anti_loop_input');
const { contactAllows, clearCache, __setFirestoreForTests: setRateDb } = require('../core/owner_rate_limiter');
const { classifyIntent } = require('../core/intent_classifier');
const { calculateBotScore } = require('../core/bot_detection');
const {
  buildCrmContact, updatePipelineStage, computeCrmStats,
  __setFirestoreForTests: setCrmDb,
} = require('../core/crm_engine');

const UID = 'owner_bloque41_001';
const BOT_PHONE = '+5733334444';
const HUMAN_PHONE = '+5711112222';
const NOW = Date.now();

function makeMockCrmDb() {
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
          }),
        }),
      }),
    }),
  };
}

function makeRateDb() {
  return { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) };
}

describe('T331 -- E2E Bloque 41: anti_loop + rate_limit + intent + bot + CRM', () => {
  beforeEach(() => {
    _resetForTests();
    clearCache();
    setRateDb(makeRateDb());
    setCrmDb(makeMockCrmDb());
  });

  test('Paso 1 -- bot detectado por mensajes identicos rapidos', () => {
    const msgs = [
      { text: 'CLICK', timestamp: NOW - 800, fromMe: false },
      { text: 'CLICK', timestamp: NOW - 700, fromMe: false },
      { text: 'CLICK', timestamp: NOW - 600, fromMe: false },
    ];
    const { verdict } = calculateBotScore(msgs);
    expect(verdict).toBe('bot');
  });

  test('Paso 2 -- anti_loop bloquea regeneracion para input repetido', () => {
    recordInput(UID, BOT_PHONE, 'CLICK CLICK CLICK');
    const r = shouldRegenerate(UID, BOT_PHONE, 'CLICK CLICK CLICK');
    expect(r.regenerate).toBe(false);
    expect(r.reason).toBe('exact_repeat');
  });

  test('Paso 3 -- rate_limiter bloquea despues de perContact msgs', () => {
    const ts = Date.now();
    for (let i = 0; i < 5; i++) contactAllows(UID, BOT_PHONE, ts + i);
    const r = contactAllows(UID, BOT_PHONE, ts + 5);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('contact_rate_exceeded');
  });

  test('Paso 4 -- human pasa anti_loop y rate_limit', () => {
    const novel = 'Hola, me interesa saber sobre sus planes de automatizacion';
    const antiLoop = shouldRegenerate(UID, HUMAN_PHONE, novel);
    expect(antiLoop.regenerate).toBe(true);

    const rate = contactAllows(UID, HUMAN_PHONE);
    expect(rate.allowed).toBe(true);
  });

  test('Paso 5 -- intent clasificado para human', () => {
    const msg = 'Cuanto cuesta el plan mensual?';
    const { intent } = classifyIntent(msg);
    expect(intent).toBe('price');
  });

  test('Paso 6 -- CRM: human lead calificado -> prospect', () => {
    let contact = buildCrmContact(UID, {
      phone: HUMAN_PHONE,
      name: 'Carlos',
      stage: 'lead',
    });
    contact = updatePipelineStage(contact, 'prospect');
    expect(contact.stage).toBe('prospect');
    expect(contact.stageChangedAt).toBeDefined();
  });

  test('Pipeline completo -- bot filtrado, human procesado hasta CRM', () => {
    // A: bot detectado
    const botMsgs = [
      { text: 'SPAM', timestamp: NOW - 900, fromMe: false },
      { text: 'SPAM', timestamp: NOW - 800, fromMe: false },
      { text: 'SPAM', timestamp: NOW - 700, fromMe: false },
    ];
    const { verdict } = calculateBotScore(botMsgs);
    expect(verdict).toBe('bot');

    // B: anti_loop bloquea bot input
    recordInput(UID, BOT_PHONE, 'SPAM');
    const antiBot = shouldRegenerate(UID, BOT_PHONE, 'SPAM');
    expect(antiBot.regenerate).toBe(false);

    // C: rate_limit para bot
    for (let i = 0; i < 5; i++) contactAllows(UID, BOT_PHONE, Date.now() + i);
    expect(contactAllows(UID, BOT_PHONE).allowed).toBe(false);

    // D: human pasa todos los filtros
    const humanInput = 'Hola, quiero agendar una demo del sistema MIIA';
    const antiHuman = shouldRegenerate(UID, HUMAN_PHONE, humanInput);
    expect(antiHuman.regenerate).toBe(true);

    const rateHuman = contactAllows(UID, HUMAN_PHONE);
    expect(rateHuman.allowed).toBe(true);

    const { intent } = classifyIntent(humanInput);
    expect(intent).toBe('booking');

    // E: recordar input del human para anti-loop futuro
    recordInput(UID, HUMAN_PHONE, humanInput);
    const r2 = shouldRegenerate(UID, HUMAN_PHONE, humanInput);
    expect(r2.regenerate).toBe(false); // ahora ya está en historial

    // F: CRM
    let contact = buildCrmContact(UID, { phone: HUMAN_PHONE, name: 'Ana', stage: 'lead' });
    contact = updatePipelineStage(contact, 'prospect');
    const stats = computeCrmStats([contact]);
    expect(stats.byStage.prospect).toBe(1);
  });
});
