'use strict';

/**
 * T327 -- E2E Bloque 39
 * Pipeline: owner_settings check -> notification -> intent -> CRM
 */

const { getSettings, updateSettings, __setFirestoreForTests: setSettingsDb } = require('../core/owner_settings');
const { createNotification, getNotifications, __setFirestoreForTests: setNotifDb } = require('../core/notification_manager');
const { classifyIntent } = require('../core/intent_classifier');
const {
  buildCrmContact, updatePipelineStage, addTag, computeCrmStats,
  __setFirestoreForTests: setCrmDb,
} = require('../core/crm_engine');

const UID = 'owner_bloque39_001';

function makeFullDb(settingsData = null, notifDocs = []) {
  const store = {};
  return {
    collection: (col) => ({
      doc: (docId) => ({
        get: async () => {
          if (col === 'owners' && docId === UID) {
            if (settingsData) return { exists: true, data: () => ({ settings: settingsData }) };
            return { exists: false };
          }
          return { exists: false };
        },
        set: async (data, opts) => {
          if (!store[col]) store[col] = {};
          if (opts && opts.merge) {
            store[col][docId] = { ...(store[col][docId] || {}), ...data };
          } else {
            store[col][docId] = { ...data };
          }
        },
        collection: (subCol) => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (!store[docId]) store[docId] = {};
              if (!store[docId][subCol]) store[docId][subCol] = {};
              if (opts && opts.merge) {
                store[docId][subCol][id] = { ...(store[docId][subCol][id] || {}), ...data };
              } else {
                store[docId][subCol][id] = { ...data };
              }
            },
            get: async () => ({ exists: false }),
          }),
          get: async () => ({ docs: notifDocs.map(n => ({ data: () => n })) }),
        }),
      }),
    }),
  };
}

describe('T327 -- E2E Bloque 39: settings + notifications + intent + CRM', () => {
  beforeEach(() => {
    const db = makeFullDb();
    setSettingsDb(db);
    setNotifDb(db);
    setCrmDb(db);
  });

  test('Paso 1 -- owner settings: defaults cuando no hay config', async () => {
    const { settings } = await getSettings(UID);
    expect(settings.aiEnabled).toBe(true);
    expect(settings.language).toBe('es');
    expect(settings.autoReply).toBe(true);
  });

  test('Paso 2 -- owner activa working hours', async () => {
    const db = makeFullDb();
    setSettingsDb(db);
    const r = await updateSettings(UID, { workingHoursEnabled: true, workingHoursStart: '08:00', workingHoursEnd: '17:00' });
    expect(r.updatedKeys).toContain('workingHoursEnabled');
    expect(r.updatedKeys).toContain('workingHoursStart');
  });

  test('Paso 3 -- notificacion creada cuando llega lead calificado', async () => {
    const db = makeFullDb();
    setNotifDb(db);
    const notif = await createNotification(UID, {
      type: 'info',
      title: 'Nuevo lead calificado',
      body: 'Ana Gomez solicitó una demo del plan pro',
      meta: { phone: '+5711112222', intent: 'booking' },
    });
    expect(notif.type).toBe('info');
    expect(notif.read).toBe(false);
    expect(notif.meta.intent).toBe('booking');
  });

  test('Paso 4 -- intent lead detectado correctamente', () => {
    const msg = 'Hola, me interesa reservar una demo del servicio para esta semana';
    const { intent, confidence } = classifyIntent(msg);
    expect(intent).toBe('booking');
    expect(confidence).toBeGreaterThanOrEqual(0.7);
  });

  test('Paso 5 -- CRM: lead con intent booking -> prospect', () => {
    let contact = buildCrmContact(UID, {
      phone: '+5711112222',
      name: 'Ana Gomez',
      stage: 'lead',
      tags: ['booking'],
    });
    contact = updatePipelineStage(contact, 'prospect');
    contact = addTag(contact, 'demo_solicitada');
    expect(contact.stage).toBe('prospect');
    expect(contact.tags).toContain('demo_solicitada');
  });

  test('Paso 6 -- notificacion warning si lead es complaint', async () => {
    const db = makeFullDb();
    setNotifDb(db);
    const msg = 'Tengo una queja, el servicio no funciona correctamente';
    const { intent } = classifyIntent(msg);
    expect(intent).toBe('complaint');

    const notif = await createNotification(UID, {
      type: 'warning',
      title: 'Queja detectada',
      body: msg.substring(0, 80),
    });
    expect(notif.type).toBe('warning');
  });

  test('Pipeline completo -- settings + notif + intent + CRM + stats', async () => {
    // A: settings
    const { settings } = await getSettings(UID);
    expect(settings.aiEnabled).toBe(true);

    // B: intent lead
    const { intent } = classifyIntent('quiero agendar una cita para conocer el plan');
    expect(intent).toBe('booking');

    // C: notif
    const db = makeFullDb();
    setNotifDb(db);
    const notif = await createNotification(UID, {
      type: 'success',
      title: 'Lead calificado',
      body: 'Nuevo lead con intent booking detectado',
    });
    expect(notif.read).toBe(false);

    // D: CRM
    let contact = buildCrmContact(UID, { phone: '+5799998888', name: 'Pedro', stage: 'lead' });
    contact = updatePipelineStage(contact, 'prospect');
    expect(contact.stage).toBe('prospect');

    // E: stats
    const stats = computeCrmStats([contact]);
    expect(stats.byStage.prospect).toBe(1);
  });
});
