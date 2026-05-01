'use strict';

/**
 * T333 -- E2E Bloque 42
 * Pipeline: mmc_retrieval -> mmc_decay -> lead_scoring -> CRM
 */

const { rankMemories, getTopMemories, __setFirestoreForTests: setMmcDb } = require('../core/mmc_retrieval');
const { applyDecay } = require('../core/mmc_decay');
const { calculateLeadScore, classifyLeadScore } = require('../core/lead_scoring');
const {
  buildCrmContact, updatePipelineStage, addTag, computeCrmStats,
  __setFirestoreForTests: setCrmDb,
} = require('../core/crm_engine');

const UID = 'owner_bloque42_001';
const PHONE = '+5711112222';
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function makeMmcFirestore(entries) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: true, data: () => ({ entries }) }),
          }),
        }),
      }),
    }),
  };
}

function makeCrmDb() {
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

describe('T333 -- E2E Bloque 42: mmc_retrieval + mmc_decay + lead_scoring + CRM', () => {
  beforeEach(() => {
    setCrmDb(makeCrmDb());
  });

  test('Paso 1 -- rankear memorias del lead', () => {
    const memories = [
      { type: 'owner', timestamp: NOW - 1 * DAY },
      { type: 'lead', timestamp: NOW - 2 * DAY },
      { type: 'evento', importanceScore: 0.1 }, // filtrado
    ];
    const ranked = rankMemories(memories);
    expect(ranked.length).toBe(2);
    expect(ranked[0].type).toBe('owner'); // 0.8 > 0.5
    expect(ranked[1].type).toBe('lead');
  });

  test('Paso 2 -- aplicar decay a memorias antiguas', () => {
    const memories = [
      { type: 'owner', timestamp: NOW - 30 * DAY },  // reciente: no decae
      { type: 'lead', timestamp: NOW - 95 * DAY },   // antigua: decae
    ];
    const decayed = applyDecay(memories, NOW);
    // Reciente sin cambio
    expect(decayed[0].importanceScore).toBeUndefined();
    // Antigua con decay: 0.5 * 0.95^5
    expect(decayed[1].importanceScore).toBeCloseTo(0.5 * Math.pow(0.95, 5), 3);
  });

  test('Paso 3 -- recuperar memorias top desde Firestore', async () => {
    const entries = [
      { type: 'owner', timestamp: NOW - 1 * DAY },
      { type: 'lead', timestamp: NOW - 2 * DAY },
    ];
    setMmcDb(makeMmcFirestore(entries));
    const tops = await getTopMemories(UID, PHONE);
    expect(tops.length).toBe(2);
    expect(tops[0].importanceScore).toBe(0.8); // owner primero
  });

  test('Paso 4 -- lead scoring con memorias como contexto', () => {
    const msgs = [
      { timestamp: NOW - 5 * DAY, text: 'Hola, me interesa el plan pro para mi empresa' },
      { timestamp: NOW - 4 * DAY, text: 'Tenemos 20 empleados y necesitamos automatizacion' },
      { timestamp: NOW - 3 * DAY, text: 'Cuanto cuesta? Podrian enviar una propuesta?' },
    ];
    const { score } = calculateLeadScore({
      messages: msgs,
      enrichment: { email: 'ana@empresa.co', name: 'Ana Gomez' },
    }, NOW);
    expect(score).toBeGreaterThanOrEqual(51); // 6+15+10+20 = 51 -> warm
    expect(classifyLeadScore(score)).toBe('warm');
  });

  test('Paso 5 -- CRM: lead warm -> prospect + tags', () => {
    let contact = buildCrmContact(UID, {
      phone: PHONE,
      name: 'Ana Gomez',
      stage: 'lead',
      tags: ['warm', 'mmc_data'],
    });
    contact = updatePipelineStage(contact, 'prospect');
    contact = addTag(contact, 'score_warm');
    expect(contact.stage).toBe('prospect');
    expect(contact.tags).toContain('score_warm');
    expect(contact.tags).toContain('mmc_data');
  });

  test('Paso 6 -- stats CRM post-mmc', () => {
    const contacts = [
      buildCrmContact(UID, { phone: PHONE, name: 'Ana', stage: 'lead' }),
      updatePipelineStage(buildCrmContact(UID, { phone: '+5722223333', name: 'Carlos', stage: 'lead' }), 'prospect'),
    ];
    const stats = computeCrmStats(contacts);
    expect(stats.total).toBe(2);
    expect(stats.byStage.lead).toBe(1);
    expect(stats.byStage.prospect).toBe(1);
  });

  test('Pipeline completo -- rank+decay+retrieval+score+CRM', async () => {
    // A: rank memorias
    const mems = [
      { type: 'owner', timestamp: NOW - 1 * DAY },
      { type: 'lead', timestamp: NOW - 95 * DAY },
    ];
    const ranked = rankMemories(mems);
    expect(ranked[0].type).toBe('owner');

    // B: decay las antiguas
    const decayed = applyDecay(mems, NOW);
    const leadMem = decayed.find(m => m.type === 'lead');
    expect(leadMem.importanceScore).toBeLessThan(0.5); // decayado

    // C: retrieval desde Firestore
    setMmcDb(makeMmcFirestore(mems));
    const tops = await getTopMemories(UID, PHONE);
    expect(tops.length).toBeGreaterThan(0);

    // D: score lead
    const { score } = calculateLeadScore({
      messages: [{ timestamp: NOW - 3 * DAY, text: 'quiero informacion sobre el plan empresarial de miia' }],
      enrichment: { name: 'Ana', email: 'ana@x.co' },
    }, NOW);
    expect(score).toBeGreaterThan(0);

    // E: CRM
    let contact = buildCrmContact(UID, { phone: PHONE, name: 'Ana', stage: 'lead' });
    contact = updatePipelineStage(contact, 'prospect');
    expect(contact.stage).toBe('prospect');

    // F: stats
    const stats = computeCrmStats([contact]);
    expect(stats.byStage.prospect).toBe(1);
  });
});
