'use strict';

/**
 * T289 — crm_engine tests
 * Pipeline: contacto CRM + stages + tags + scoring + actividades + follow-up +
 * stats pipeline + summary text + CRUD mock Firestore
 */

const {
  buildCrmContact,
  updatePipelineStage,
  addTag,
  removeTag,
  setFollowUp,
  clearFollowUp,
  computeLeadScore,
  buildActivityRecord,
  recordActivity,
  buildFollowUpRecord,
  computeCrmStats,
  buildCrmSummaryText,
  saveCrmContact,
  getCrmContact,
  updateCrmContact,
  saveActivity,
  listContactsByStage,
  listActivitiesByContact,
  PIPELINE_STAGES,
  CONTACT_SOURCES,
  ACTIVITY_TYPES,
  MAX_TAGS,
  __setFirestoreForTests: setCrmDb,
} = require('../core/crm_engine');

// ─── Mock DB ─────────────────────────────────────────────────────────────────

function makeMockDb() {
  const store = {};
  return {
    store,
    db: {
      collection: () => ({
        doc: (uid) => ({
          collection: (subCol) => ({
            doc: (id) => ({
              set: async (data) => {
                if (!store[uid]) store[uid] = {};
                if (!store[uid][subCol]) store[uid][subCol] = {};
                store[uid][subCol][id] = { ...data };
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
                const filtered = all.filter(r => chain.filters.every(([f, o, v]) => {
                  if (o === '==') return r[f] === v;
                  return true;
                }));
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

const UID = 'owner_crm_001';
const PHONE = '+541155550001';

describe('T289 — crm_engine: contactos CRM + pipeline + scoring', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    setCrmDb(mock.db);
  });

  // ─── Constantes ──────────────────────────────────────────────────────────

  test('constantes exportadas correctas', () => {
    expect(PIPELINE_STAGES).toContain('lead');
    expect(PIPELINE_STAGES).toContain('won');
    expect(PIPELINE_STAGES).toContain('lost');
    expect(CONTACT_SOURCES).toContain('whatsapp');
    expect(CONTACT_SOURCES).toContain('referral');
    expect(ACTIVITY_TYPES).toContain('note');
    expect(ACTIVITY_TYPES).toContain('stage_change');
    expect(MAX_TAGS).toBeGreaterThanOrEqual(10);
  });

  // ─── buildCrmContact ─────────────────────────────────────────────────────

  test('buildCrmContact valores por defecto', () => {
    const c = buildCrmContact(UID, { phone: PHONE, name: 'Juan Lopez' });
    expect(c.uid).toBe(UID);
    expect(c.phone).toBe(PHONE);
    expect(c.name).toBe('Juan Lopez');
    expect(c.stage).toBe('lead');
    expect(c.status).toBe('active');
    expect(c.tags).toEqual([]);
    expect(c.activityCount).toBe(0);
    expect(c.leadScore).toBe(10);
    expect(c.dealValue).toBe(0);
    expect(c.currency).toBe('ARS');
    expect(typeof c.contactId).toBe('string');
    expect(c.contactId.length).toBeGreaterThan(0);
  });

  test('buildCrmContact con datos completos', () => {
    const c = buildCrmContact(UID, {
      phone: PHONE,
      name: 'Maria Garcia',
      email: 'maria@ejemplo.com',
      company: 'MiEmpresa SA',
      stage: 'qualified',
      source: 'referral',
      dealValue: 50000,
      currency: 'USD',
      tags: ['vip', 'prioridad'],
    });
    expect(c.stage).toBe('qualified');
    expect(c.source).toBe('referral');
    expect(c.dealValue).toBe(50000);
    expect(c.currency).toBe('USD');
    expect(c.tags).toEqual(['vip', 'prioridad']);
    expect(c.email).toBe('maria@ejemplo.com');
    expect(c.company).toBe('MiEmpresa SA');
  });

  test('buildCrmContact stage invalido cae a lead', () => {
    const c = buildCrmContact(UID, { phone: PHONE, stage: 'extraterrestre' });
    expect(c.stage).toBe('lead');
  });

  test('buildCrmContact source invalido cae a manual', () => {
    const c = buildCrmContact(UID, { phone: PHONE, source: 'telepata' });
    expect(c.source).toBe('manual');
  });

  test('buildCrmContact leadScore se clampea 0-100', () => {
    const c1 = buildCrmContact(UID, { phone: PHONE, leadScore: 150 });
    expect(c1.leadScore).toBe(100);
    const c2 = buildCrmContact(UID, { phone: PHONE, leadScore: -5 });
    expect(c2.leadScore).toBe(0);
  });

  // ─── updatePipelineStage ─────────────────────────────────────────────────

  test('updatePipelineStage transicion valida lead→prospect', () => {
    const c = buildCrmContact(UID, { phone: PHONE });
    const updated = updatePipelineStage(c, 'prospect');
    expect(updated.stage).toBe('prospect');
    expect(updated.stageChangedAt).toBeGreaterThan(0);
  });

  test('updatePipelineStage transicion valida prospect→qualified', () => {
    const c = buildCrmContact(UID, { phone: PHONE, stage: 'prospect' });
    const updated = updatePipelineStage(c, 'qualified');
    expect(updated.stage).toBe('qualified');
  });

  test('updatePipelineStage transicion valida negotiation→won', () => {
    const c = buildCrmContact(UID, { phone: PHONE, stage: 'negotiation' });
    const updated = updatePipelineStage(c, 'won');
    expect(updated.stage).toBe('won');
  });

  test('updatePipelineStage transicion invalida lanza error', () => {
    const c = buildCrmContact(UID, { phone: PHONE, stage: 'lead' });
    expect(() => updatePipelineStage(c, 'won')).toThrow('invalid_transition');
  });

  test('updatePipelineStage stage invalido lanza error', () => {
    const c = buildCrmContact(UID, { phone: PHONE });
    expect(() => updatePipelineStage(c, 'fantasma')).toThrow('invalid_stage');
  });

  // ─── addTag / removeTag ───────────────────────────────────────────────────

  test('addTag agrega tag normalizado', () => {
    const c = buildCrmContact(UID, { phone: PHONE });
    const updated = addTag(c, '  VIP  ');
    expect(updated.tags).toContain('vip');
  });

  test('addTag no duplica tags', () => {
    let c = buildCrmContact(UID, { phone: PHONE });
    c = addTag(c, 'vip');
    c = addTag(c, 'vip');
    expect(c.tags.filter(t => t === 'vip').length).toBe(1);
  });

  test('addTag lanza error cuando tag es invalido', () => {
    const c = buildCrmContact(UID, { phone: PHONE });
    expect(() => addTag(c, '')).toThrow('invalid_tag');
    expect(() => addTag(c, '   ')).toThrow('invalid_tag');
  });

  test('addTag lanza error cuando se alcanza MAX_TAGS', () => {
    let c = buildCrmContact(UID, { phone: PHONE });
    for (let i = 0; i < MAX_TAGS; i++) {
      c = addTag(c, 'tag' + i);
    }
    expect(() => addTag(c, 'uno_mas')).toThrow('max_tags_reached');
  });

  test('removeTag elimina tag existente', () => {
    let c = buildCrmContact(UID, { phone: PHONE, tags: ['vip', 'prioridad'] });
    c = removeTag(c, 'vip');
    expect(c.tags).not.toContain('vip');
    expect(c.tags).toContain('prioridad');
  });

  test('removeTag no falla con tag inexistente', () => {
    const c = buildCrmContact(UID, { phone: PHONE, tags: ['vip'] });
    const updated = removeTag(c, 'inexistente');
    expect(updated.tags).toEqual(['vip']);
  });

  // ─── setFollowUp / clearFollowUp ─────────────────────────────────────────

  test('setFollowUp registra fecha', () => {
    const c = buildCrmContact(UID, { phone: PHONE });
    const future = Date.now() + 86400000;
    const updated = setFollowUp(c, future);
    expect(updated.followUpAt).toBe(future);
  });

  test('setFollowUp con fecha invalida lanza error', () => {
    const c = buildCrmContact(UID, { phone: PHONE });
    expect(() => setFollowUp(c, 'mañana')).toThrow('invalid_follow_up_at');
    expect(() => setFollowUp(c, -1)).toThrow('invalid_follow_up_at');
  });

  test('clearFollowUp limpia la fecha', () => {
    let c = buildCrmContact(UID, { phone: PHONE });
    c = setFollowUp(c, Date.now() + 86400000);
    c = clearFollowUp(c);
    expect(c.followUpAt).toBeNull();
  });

  // ─── computeLeadScore ────────────────────────────────────────────────────

  test('computeLeadScore lead sin datos: score base', () => {
    const c = buildCrmContact(UID, { phone: PHONE });
    const score = computeLeadScore(c);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBe(10); // SCORE_BASE solo
  });

  test('computeLeadScore sube con stage avanzado', () => {
    const base = buildCrmContact(UID, { phone: PHONE });
    const qualified = buildCrmContact(UID, { phone: PHONE, stage: 'qualified' });
    expect(computeLeadScore(qualified)).toBeGreaterThan(computeLeadScore(base));
  });

  test('computeLeadScore sube con deal value alto', () => {
    const sin = buildCrmContact(UID, { phone: PHONE });
    const con = buildCrmContact(UID, { phone: PHONE, dealValue: 200000 });
    expect(computeLeadScore(con)).toBeGreaterThan(computeLeadScore(sin));
  });

  test('computeLeadScore sube con tags y email', () => {
    const base = buildCrmContact(UID, { phone: PHONE });
    const rico = buildCrmContact(UID, {
      phone: PHONE,
      email: 'test@test.com',
      company: 'Empresa',
      tags: ['vip', 'caliente', 'referido'],
      activityCount: 5,
    });
    expect(computeLeadScore(rico)).toBeGreaterThan(computeLeadScore(base));
  });

  test('computeLeadScore maximo 100', () => {
    const c = buildCrmContact(UID, {
      phone: PHONE,
      stage: 'won',
      dealValue: 500000,
      email: 'x@x.com',
      company: 'Big Corp',
      tags: Array.from({length: 10}, (_, i) => 'tag' + i),
      activityCount: 30,
    });
    expect(computeLeadScore(c)).toBeLessThanOrEqual(100);
  });

  // ─── buildActivityRecord ─────────────────────────────────────────────────

  test('buildActivityRecord valores correctos', () => {
    const act = buildActivityRecord(UID, 'contact_001', {
      type: 'call',
      body: 'Llamada de seguimiento exitosa',
      outcome: 'interested',
      durationMs: 300000,
      performedBy: 'Mariano',
    });
    expect(act.uid).toBe(UID);
    expect(act.contactId).toBe('contact_001');
    expect(act.type).toBe('call');
    expect(act.body).toContain('seguimiento');
    expect(act.outcome).toBe('interested');
    expect(act.durationMs).toBe(300000);
    expect(act.performedBy).toBe('Mariano');
    expect(typeof act.activityId).toBe('string');
  });

  test('buildActivityRecord tipo invalido cae a note', () => {
    const act = buildActivityRecord(UID, 'c1', { type: 'humo' });
    expect(act.type).toBe('note');
  });

  // ─── recordActivity ───────────────────────────────────────────────────────

  test('recordActivity incrementa activityCount', () => {
    let c = buildCrmContact(UID, { phone: PHONE });
    const act = buildActivityRecord(UID, c.contactId, { type: 'note', body: 'Primera nota' });
    c = recordActivity(c, act);
    expect(c.activityCount).toBe(1);
    expect(c.lastActivityAt).toBeGreaterThan(0);
  });

  test('recordActivity multiples incrementos', () => {
    let c = buildCrmContact(UID, { phone: PHONE });
    for (let i = 0; i < 5; i++) {
      const act = buildActivityRecord(UID, c.contactId, { type: 'email', body: 'Email ' + i });
      c = recordActivity(c, act);
    }
    expect(c.activityCount).toBe(5);
  });

  // ─── buildFollowUpRecord ─────────────────────────────────────────────────

  test('buildFollowUpRecord valores correctos', () => {
    const fu = buildFollowUpRecord(UID, 'contact_001', {
      scheduledAt: Date.now() + 86400000,
      reason: 'Verificar interes en propuesta',
      channel: 'whatsapp',
    });
    expect(fu.uid).toBe(UID);
    expect(fu.contactId).toBe('contact_001');
    expect(fu.status).toBe('pending');
    expect(fu.channel).toBe('whatsapp');
    expect(fu.reason).toContain('propuesta');
    expect(fu.completedAt).toBeNull();
    expect(typeof fu.followUpId).toBe('string');
  });

  test('buildFollowUpRecord default scheduledAt 24h', () => {
    const fu = buildFollowUpRecord(UID, 'c1', {});
    expect(fu.scheduledAt).toBeGreaterThan(Date.now());
  });

  // ─── computeCrmStats ─────────────────────────────────────────────────────

  test('computeCrmStats lista vacia', () => {
    const stats = computeCrmStats([]);
    expect(stats.total).toBe(0);
    expect(stats.conversionRate).toBe(0);
    expect(stats.avgDealValue).toBe(0);
  });

  test('computeCrmStats con contactos variados', () => {
    const contacts = [
      buildCrmContact(UID, { phone: '+1', stage: 'lead' }),
      buildCrmContact(UID, { phone: '+2', stage: 'prospect' }),
      buildCrmContact(UID, { phone: '+3', stage: 'qualified' }),
      buildCrmContact(UID, { phone: '+4', stage: 'won', dealValue: 10000 }),
      buildCrmContact(UID, { phone: '+5', stage: 'won', dealValue: 20000 }),
      buildCrmContact(UID, { phone: '+6', stage: 'lost' }),
    ];
    const stats = computeCrmStats(contacts);
    expect(stats.total).toBe(6);
    expect(stats.wonCount).toBe(2);
    expect(stats.lostCount).toBe(1);
    // conversion: 2 won / (2 won + 1 lost) = 66.67%
    expect(stats.conversionRate).toBeCloseTo(66.67, 1);
    // avgDealValue: (10000+20000)/2 = 15000
    expect(stats.avgDealValue).toBe(15000);
    expect(stats.byStage.lead).toBe(1);
    expect(stats.byStage.won).toBe(2);
    expect(stats.totalPipelineValue).toBe(30000);
  });

  test('computeCrmStats solo perdidos: conversionRate 0', () => {
    const contacts = [
      buildCrmContact(UID, { phone: '+1', stage: 'lost' }),
      buildCrmContact(UID, { phone: '+2', stage: 'lost' }),
    ];
    const stats = computeCrmStats(contacts);
    expect(stats.conversionRate).toBe(0);
    expect(stats.wonCount).toBe(0);
  });

  // ─── buildCrmSummaryText ─────────────────────────────────────────────────

  test('buildCrmSummaryText contacto null', () => {
    expect(buildCrmSummaryText(null)).toContain('no encontrado');
  });

  test('buildCrmSummaryText contacto completo', () => {
    const c = buildCrmContact(UID, {
      phone: PHONE,
      name: 'Roberto Silva',
      company: 'TechStartup',
      stage: 'proposal',
      source: 'web',
      dealValue: 75000,
      tags: ['enterprise', 'urgente'],
      activityCount: 8,
    });
    const text = buildCrmSummaryText(c);
    expect(text).toContain('Roberto Silva');
    expect(text).toContain('PROPOSAL');
    expect(text).toContain('TechStartup');
    expect(text).toContain('75');
    expect(text).toContain('enterprise');
    expect(text).toContain('8');
  });

  // ─── CRUD Firestore mock ─────────────────────────────────────────────────

  test('saveCrmContact y getCrmContact round-trip', async () => {
    const c = buildCrmContact(UID, { phone: PHONE, name: 'Test Contact', stage: 'lead' });
    const id = await saveCrmContact(UID, c);
    expect(id).toBe(c.contactId);

    const retrieved = await getCrmContact(UID, c.contactId);
    expect(retrieved).not.toBeNull();
    expect(retrieved.name).toBe('Test Contact');
    expect(retrieved.stage).toBe('lead');
  });

  test('getCrmContact inexistente retorna null', async () => {
    const result = await getCrmContact(UID, 'no_existe_99999');
    expect(result).toBeNull();
  });

  test('updateCrmContact modifica campos', async () => {
    const c = buildCrmContact(UID, { phone: PHONE, name: 'Original', stage: 'lead' });
    await saveCrmContact(UID, c);
    await updateCrmContact(UID, c.contactId, { stage: 'prospect', dealValue: 5000 });
    const updated = await getCrmContact(UID, c.contactId);
    expect(updated.stage).toBe('prospect');
    expect(updated.dealValue).toBe(5000);
  });

  test('saveActivity y listActivitiesByContact', async () => {
    const c = buildCrmContact(UID, { phone: PHONE, name: 'Carlos' });
    const act1 = buildActivityRecord(UID, c.contactId, { type: 'call', body: 'Primera llamada' });
    const act2 = buildActivityRecord(UID, c.contactId, { type: 'email', body: 'Email enviado' });
    await saveActivity(UID, act1);
    await saveActivity(UID, act2);

    const activities = await listActivitiesByContact(UID, c.contactId);
    expect(activities.length).toBe(2);
    expect(activities.map(a => a.type)).toContain('call');
    expect(activities.map(a => a.type)).toContain('email');
  });

  test('listContactsByStage filtra por stage', async () => {
    const c1 = buildCrmContact(UID, { phone: '+100', name: 'Lead 1', stage: 'lead' });
    const c2 = buildCrmContact(UID, { phone: '+200', name: 'Lead 2', stage: 'lead' });
    const c3 = buildCrmContact(UID, { phone: '+300', name: 'Won 1', stage: 'won' });
    await saveCrmContact(UID, c1);
    await saveCrmContact(UID, c2);
    await saveCrmContact(UID, c3);

    const leads = await listContactsByStage(UID, 'lead');
    expect(leads.length).toBe(2);
    const wonList = await listContactsByStage(UID, 'won');
    expect(wonList.length).toBe(1);
  });

  // ─── Pipeline E2E ─────────────────────────────────────────────────────────

  test('Pipeline completo: lead → won con actividades y follow-up', async () => {
    // 1. Crear contacto como lead
    let contact = buildCrmContact(UID, {
      phone: PHONE,
      name: 'Ana Martinez',
      company: 'Farmacia Central',
      source: 'whatsapp',
      dealValue: 15000,
    });
    expect(contact.stage).toBe('lead');

    // 2. Agregar tags
    contact = addTag(contact, 'farmacia');
    contact = addTag(contact, 'interesada');
    expect(contact.tags.length).toBe(2);

    // 3. Avanzar stages
    contact = updatePipelineStage(contact, 'prospect');
    contact = updatePipelineStage(contact, 'qualified');
    contact = updatePipelineStage(contact, 'proposal');
    contact = updatePipelineStage(contact, 'negotiation');
    contact = updatePipelineStage(contact, 'won');
    expect(contact.stage).toBe('won');

    // 4. Registrar actividades
    let act;
    act = buildActivityRecord(UID, contact.contactId, { type: 'call', body: 'Demo realizada' });
    contact = recordActivity(contact, act);
    act = buildActivityRecord(UID, contact.contactId, { type: 'email', body: 'Propuesta enviada' });
    contact = recordActivity(contact, act);
    expect(contact.activityCount).toBe(2);

    // 5. Set follow-up (review post-venta)
    contact = setFollowUp(contact, Date.now() + 7 * 86400000);
    expect(contact.followUpAt).toBeGreaterThan(Date.now());

    // 6. Score
    const score = computeLeadScore(contact);
    expect(score).toBeGreaterThan(80); // won + actividades + deal

    // 7. Guardar en Firestore y recuperar
    await saveCrmContact(UID, contact);
    const saved = await getCrmContact(UID, contact.contactId);
    expect(saved.stage).toBe('won');
    expect(saved.activityCount).toBe(2);

    // 8. Stats
    const stats = computeCrmStats([contact]);
    expect(stats.wonCount).toBe(1);
    expect(stats.conversionRate).toBe(100);
    expect(stats.avgDealValue).toBe(15000);

    // 9. Summary text
    const text = buildCrmSummaryText(contact);
    expect(text).toContain('Ana Martinez');
    expect(text).toContain('WON');
    expect(text).toContain('farmacia');
  });
});
