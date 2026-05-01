'use strict';

const {
  buildCampaignRecord,
  buildDripStep,
  buildCampaignWithDripSteps,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  completeCampaign,
  cancelCampaign,
  recordSend,
  computeCampaignStats,
  buildCampaignSummaryText,
  saveCampaign,
  getCampaign,
  updateCampaign,
  listCampaigns,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TYPES,
  CAMPAIGN_CHANNELS,
  TRIGGER_EVENTS,
  MAX_AUDIENCE_SIZE,
  MAX_STEPS_PER_DRIP,
  MIN_STEP_DELAY_MS,
  __setFirestoreForTests,
} = require('../core/campaign_engine');

function makeMockDb() {
  const stored = {};
  return {
    stored,
    db: {
      collection: () => ({
        doc: (uid) => ({
          collection: (subCol) => ({
            doc: (id) => ({
              set: async (data) => {
                if (!stored[uid]) stored[uid] = {};
                stored[uid][id] = { ...data };
              },
              get: async () => {
                const rec = stored[uid] && stored[uid][id];
                return { exists: !!rec, data: () => rec };
              },
            }),
            where: (field, op, val) => {
              const chain = { filters: [[field, op, val]] };
              chain.where = (f2, op2, v2) => { chain.filters.push([f2, op2, v2]); return chain; };
              chain.get = async () => {
                const all = Object.values(stored[uid] || {});
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
              const all = Object.values(stored[uid] || {});
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

const UID = 'usr_camp_test_001';

describe('T284 — campaign_engine', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    __setFirestoreForTests(mock.db);
  });

  // ─── Constantes ───────────────────────────────────────────────────────────

  describe('Constantes exportadas', () => {
    test('CAMPAIGN_STATUSES es frozen con todos los estados', () => {
      expect(Object.isFrozen(CAMPAIGN_STATUSES)).toBe(true);
      expect(CAMPAIGN_STATUSES).toContain('draft');
      expect(CAMPAIGN_STATUSES).toContain('active');
      expect(CAMPAIGN_STATUSES).toContain('paused');
      expect(CAMPAIGN_STATUSES).toContain('completed');
      expect(CAMPAIGN_STATUSES).toContain('cancelled');
    });

    test('CAMPAIGN_TYPES es frozen', () => {
      expect(Object.isFrozen(CAMPAIGN_TYPES)).toBe(true);
      expect(CAMPAIGN_TYPES).toContain('broadcast');
      expect(CAMPAIGN_TYPES).toContain('drip');
      expect(CAMPAIGN_TYPES).toContain('trigger');
    });

    test('TRIGGER_EVENTS es frozen', () => {
      expect(Object.isFrozen(TRIGGER_EVENTS)).toBe(true);
      expect(TRIGGER_EVENTS).toContain('first_purchase');
      expect(TRIGGER_EVENTS).toContain('appointment_booked');
      expect(TRIGGER_EVENTS).toContain('inactivity_30d');
    });

    test('MAX_AUDIENCE_SIZE es 10000 y MAX_STEPS_PER_DRIP es 20', () => {
      expect(MAX_AUDIENCE_SIZE).toBe(10000);
      expect(MAX_STEPS_PER_DRIP).toBe(20);
    });

    test('MIN_STEP_DELAY_MS es 60000', () => {
      expect(MIN_STEP_DELAY_MS).toBe(60000);
    });
  });

  // ─── buildCampaignRecord ──────────────────────────────────────────────────

  describe('buildCampaignRecord', () => {
    test('construye campana broadcast con defaults', () => {
      const c = buildCampaignRecord(UID, {
        name: 'Promo verano',
        type: 'broadcast',
        channel: 'whatsapp',
      });

      expect(c.uid).toBe(UID);
      expect(c.name).toBe('Promo verano');
      expect(c.type).toBe('broadcast');
      expect(c.channel).toBe('whatsapp');
      expect(c.status).toBe('draft');
      expect(c.sentCount).toBe(0);
      expect(c.audienceSize).toBe(0);
      expect(c.steps).toEqual([]);
    });

    test('type invalido cae a broadcast', () => {
      const c = buildCampaignRecord(UID, { type: 'telepathic' });
      expect(c.type).toBe('broadcast');
    });

    test('channel invalido cae a whatsapp', () => {
      const c = buildCampaignRecord(UID, { channel: 'fax' });
      expect(c.channel).toBe('whatsapp');
    });

    test('scheduledAt futuro genera status scheduled', () => {
      const futureTs = Date.now() + 3600000;
      const c = buildCampaignRecord(UID, { scheduledAt: futureTs });
      expect(c.status).toBe('scheduled');
      expect(c.scheduledAt).toBe(futureTs);
    });

    test('scheduledAt pasado no genera scheduled', () => {
      const c = buildCampaignRecord(UID, { scheduledAt: Date.now() - 1000 });
      expect(c.status).toBe('draft');
      expect(c.scheduledAt).toBeNull();
    });

    test('campaignId es unico por llamada', () => {
      const c1 = buildCampaignRecord(UID, {});
      const c2 = buildCampaignRecord(UID, {});
      expect(c1.campaignId).not.toBe(c2.campaignId);
    });

    test('triggerEvent valido se guarda, invalido queda null', () => {
      const c1 = buildCampaignRecord(UID, { triggerEvent: 'first_purchase' });
      expect(c1.triggerEvent).toBe('first_purchase');
      const c2 = buildCampaignRecord(UID, { triggerEvent: 'win_the_lottery' });
      expect(c2.triggerEvent).toBeNull();
    });

    test('name se trunca a MAX length', () => {
      const c = buildCampaignRecord(UID, { name: 'x'.repeat(200) });
      expect(c.name.length).toBe(100);
    });
  });

  // ─── buildDripStep ────────────────────────────────────────────────────────

  describe('buildDripStep', () => {
    test('construye paso con delayMs valido', () => {
      const step = buildDripStep({ delayMs: 3600000, body: 'Hola paso 1', subject: 'Bienvenida' }, 0);
      expect(step.stepIndex).toBe(0);
      expect(step.delayMs).toBe(3600000);
      expect(step.body).toBe('Hola paso 1');
      expect(step.sentCount).toBe(0);
    });

    test('delayMs menor al minimo se clampea a MIN', () => {
      const step = buildDripStep({ delayMs: 100 }, 1);
      expect(step.delayMs).toBe(MIN_STEP_DELAY_MS);
    });

    test('delayMs faltante usa MIN', () => {
      const step = buildDripStep({}, 0);
      expect(step.delayMs).toBe(MIN_STEP_DELAY_MS);
    });
  });

  // ─── buildCampaignWithDripSteps ───────────────────────────────────────────

  describe('buildCampaignWithDripSteps', () => {
    test('construye campana drip con pasos', () => {
      const stepsData = [
        { delayMs: 3600000, body: 'Bienvenida' },
        { delayMs: 86400000, body: 'Seguimiento 1' },
        { delayMs: 172800000, body: 'Seguimiento 2' },
      ];
      const campaign = buildCampaignWithDripSteps(UID, { name: 'Onboarding' }, stepsData);
      expect(campaign.type).toBe('drip');
      expect(campaign.steps.length).toBe(3);
      expect(campaign.steps[0].stepIndex).toBe(0);
      expect(campaign.steps[1].body).toBe('Seguimiento 1');
    });

    test('limita pasos a MAX_STEPS_PER_DRIP', () => {
      const stepsData = Array.from({ length: 30 }, (_, i) => ({ delayMs: 3600000, body: 'Paso ' + i }));
      const campaign = buildCampaignWithDripSteps(UID, {}, stepsData);
      expect(campaign.steps.length).toBe(MAX_STEPS_PER_DRIP);
    });
  });

  // ─── startCampaign / pauseCampaign / resumeCampaign ──────────────────────

  describe('Ciclo de vida de la campana', () => {
    test('draft → active con audienceSize', () => {
      const c = buildCampaignRecord(UID, {});
      const started = startCampaign(c, 500);
      expect(started.status).toBe('active');
      expect(started.audienceSize).toBe(500);
      expect(started.startedAt).toBeGreaterThan(0);
    });

    test('audienceSize se clampea a MAX_AUDIENCE_SIZE', () => {
      const c = buildCampaignRecord(UID, {});
      const started = startCampaign(c, 99999);
      expect(started.audienceSize).toBe(MAX_AUDIENCE_SIZE);
    });

    test('scheduled → active', () => {
      const c = buildCampaignRecord(UID, { scheduledAt: Date.now() + 9999 });
      const started = startCampaign(c, 100);
      expect(started.status).toBe('active');
    });

    test('active → paused → active', () => {
      let c = buildCampaignRecord(UID, {});
      c = startCampaign(c, 200);
      const paused = pauseCampaign(c);
      expect(paused.status).toBe('paused');
      expect(paused.pausedAt).toBeGreaterThan(0);
      const resumed = resumeCampaign(paused);
      expect(resumed.status).toBe('active');
      expect(resumed.pausedAt).toBeNull();
    });

    test('active → completed', () => {
      let c = startCampaign(buildCampaignRecord(UID, {}), 100);
      const completed = completeCampaign(c);
      expect(completed.status).toBe('completed');
      expect(completed.completedAt).toBeGreaterThan(0);
    });

    test('draft → cancelled', () => {
      const c = buildCampaignRecord(UID, {});
      const cancelled = cancelCampaign(c);
      expect(cancelled.status).toBe('cancelled');
    });

    test('no puede iniciar una campana completada', () => {
      let c = startCampaign(buildCampaignRecord(UID, {}), 100);
      c = completeCampaign(c);
      expect(() => startCampaign(c, 100)).toThrow();
    });

    test('no puede pausar una campana en draft', () => {
      const c = buildCampaignRecord(UID, {});
      expect(() => pauseCampaign(c)).toThrow();
    });

    test('no puede reanudar una campana activa', () => {
      const c = startCampaign(buildCampaignRecord(UID, {}), 100);
      expect(() => resumeCampaign(c)).toThrow();
    });

    test('no puede cancelar una campana ya cancelada', () => {
      const c = cancelCampaign(buildCampaignRecord(UID, {}));
      expect(() => cancelCampaign(c)).toThrow();
    });

    test('no puede cancelar una campana completada', () => {
      let c = startCampaign(buildCampaignRecord(UID, {}), 100);
      c = completeCampaign(c);
      expect(() => cancelCampaign(c)).toThrow();
    });
  });

  // ─── recordSend / computeCampaignStats ────────────────────────────────────

  describe('recordSend y computeCampaignStats', () => {
    test('recordSend incrementa sentCount y deliveredCount', () => {
      let c = startCampaign(buildCampaignRecord(UID, {}), 100);
      c = recordSend(c, { delivered: true });
      c = recordSend(c, { delivered: false });
      c = recordSend(c, { delivered: true, error: false });
      expect(c.sentCount).toBe(3);
      expect(c.deliveredCount).toBe(2);
    });

    test('recordSend con error incrementa errorCount', () => {
      let c = startCampaign(buildCampaignRecord(UID, {}), 100);
      c = recordSend(c, { error: true });
      expect(c.errorCount).toBe(1);
    });

    test('computeCampaignStats calcula tasas correctamente', () => {
      let c = { ...startCampaign(buildCampaignRecord(UID, {}), 1000), sentCount: 800, deliveredCount: 720, openCount: 180, clickCount: 45, errorCount: 80 };
      const stats = computeCampaignStats(c);
      expect(stats.sentRate).toBe(80); // 800/1000
      expect(stats.deliveryRate).toBe(90); // 720/800
      expect(stats.openRate).toBe(25); // 180/720
      expect(stats.clickRate).toBe(25); // 45/180
      expect(stats.errorRate).toBe(10); // 80/800
    });

    test('computeCampaignStats sin envios retorna zeros', () => {
      const c = buildCampaignRecord(UID, {});
      const stats = computeCampaignStats(c);
      expect(stats.sentRate).toBe(0);
      expect(stats.deliveryRate).toBe(0);
    });
  });

  // ─── buildCampaignSummaryText ─────────────────────────────────────────────

  describe('buildCampaignSummaryText', () => {
    test('genera texto con nombre, tipo, canal y estado', () => {
      const c = buildCampaignRecord(UID, {
        name: 'Promo Black Friday',
        type: 'broadcast',
        channel: 'email',
      });
      const started = startCampaign(c, 500);
      const text = buildCampaignSummaryText(started);
      expect(text).toContain('Promo Black Friday');
      expect(text).toContain('broadcast');
      expect(text).toContain('email');
      expect(text).toContain('active');
      expect(text).toContain('Audiencia: 500');
    });

    test('retorna mensaje si campana es null', () => {
      expect(buildCampaignSummaryText(null)).toBe('Campana no encontrada.');
    });

    test('muestra pasos drip si los tiene', () => {
      const c = buildCampaignWithDripSteps(UID, { name: 'Drip Test' }, [
        { delayMs: 3600000, body: 'Paso 1' },
        { delayMs: 86400000, body: 'Paso 2' },
      ]);
      const text = buildCampaignSummaryText(c);
      expect(text).toContain('Pasos drip: 2');
    });
  });

  // ─── Firestore CRUD ───────────────────────────────────────────────────────

  describe('Operaciones Firestore', () => {
    test('saveCampaign + getCampaign funciona', async () => {
      const c = buildCampaignRecord(UID, { name: 'Campana Test', type: 'broadcast' });
      await saveCampaign(UID, c);
      const retrieved = await getCampaign(UID, c.campaignId);
      expect(retrieved).not.toBeNull();
      expect(retrieved.name).toBe('Campana Test');
    });

    test('getCampaign retorna null si no existe', async () => {
      const result = await getCampaign(UID, 'camp_inexistente');
      expect(result).toBeNull();
    });

    test('updateCampaign hace merge', async () => {
      const c = buildCampaignRecord(UID, {});
      await saveCampaign(UID, c);
      await updateCampaign(UID, c.campaignId, { status: 'active', audienceSize: 300 });
      const retrieved = await getCampaign(UID, c.campaignId);
      expect(retrieved.status).toBe('active');
      expect(retrieved.audienceSize).toBe(300);
    });

    test('listCampaigns retorna campanas guardadas', async () => {
      const c1 = buildCampaignRecord(UID, { type: 'broadcast' });
      const c2 = buildCampaignRecord(UID, { type: 'drip' });
      await saveCampaign(UID, c1);
      await saveCampaign(UID, c2);
      const all = await listCampaigns(UID);
      expect(all.length).toBe(2);
    });

    test('listCampaigns filtra por channel', async () => {
      const c1 = buildCampaignRecord(UID, { channel: 'whatsapp' });
      const c2 = buildCampaignRecord(UID, { channel: 'email' });
      await saveCampaign(UID, c1);
      await saveCampaign(UID, c2);
      const wa = await listCampaigns(UID, { channel: 'whatsapp' });
      expect(wa.every(c => c.channel === 'whatsapp')).toBe(true);
    });

    test('listCampaigns retorna array vacio si no hay', async () => {
      const result = await listCampaigns('uid_sin_campanas');
      expect(result).toEqual([]);
    });
  });
});
