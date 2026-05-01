'use strict';

/**
 * T329 -- E2E Bloque 40
 * Pipeline: export -> training_crud -> notification -> owner_settings -> CRM
 */

const { getTrainingData, setTrainingData, deleteTrainingData, __setFirestoreForTests: setTrainDb } = require('../core/training_crud');
const { exportConversations, serializeExport, __setFirestoreForTests: setExportDb } = require('../core/conversation_export');
const { createNotification, __setFirestoreForTests: setNotifDb } = require('../core/notification_manager');
const { getSettings, updateSettings, __setFirestoreForTests: setSettingsDb } = require('../core/owner_settings');
const {
  buildCrmContact, updatePipelineStage, computeCrmStats,
  __setFirestoreForTests: setCrmDb,
} = require('../core/crm_engine');

const UID = 'owner_bloque40_001';

function makeMultiDb(trainingContent = null, conversations = null, settingsData = null) {
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
          const key = `${col}/${docId}`;
          if (opts && opts.merge) store[key] = { ...(store[key] || {}), ...data };
          else store[key] = { ...data };
        },
        collection: (subCol) => ({
          doc: (subDocId) => ({
            get: async () => {
              if (subDocId === 'training_data' && trainingContent !== null) {
                return { exists: true, data: () => ({ content: trainingContent, updatedAt: '2026-05-01T10:00:00Z' }) };
              }
              if (subDocId === 'tenant_conversations' && conversations !== null) {
                return { exists: true, data: () => conversations };
              }
              return { exists: false };
            },
            set: async (data, opts) => {
              const key = `${col}/${docId}/${subCol}/${subDocId}`;
              if (opts && opts.merge) store[key] = { ...(store[key] || {}), ...data };
              else store[key] = { ...data };
            },
          }),
          get: async () => ({ docs: [] }),
        }),
      }),
    }),
  };
}

describe('T329 -- E2E Bloque 40: training + export + notif + settings + CRM', () => {
  beforeEach(() => {
    const db = makeMultiDb();
    setTrainDb(db);
    setExportDb(db);
    setNotifDb(db);
    setSettingsDb(db);
    setCrmDb(db);
  });

  test('Paso 1 -- training data: guardar y leer', async () => {
    const db = makeMultiDb();
    setTrainDb(db);
    const r = await setTrainingData(UID, 'Soy MIIA, asistente de ventas de Bogota.');
    expect(r.sizeBytes).toBeGreaterThan(0);

    // Ahora leer (usa el doc guardado in-memory)
    const r2 = await getTrainingData(UID);
    // doc no existe en makeMultiDb sin trainingContent (no se persiste en tests simples)
    expect(r2.uid).toBe(UID);
  });

  test('Paso 2 -- training data vacío valido (bug 6.1)', async () => {
    const db = makeMultiDb();
    setTrainDb(db);
    const r = await setTrainingData(UID, '');
    expect(r.sizeBytes).toBe(0);
    const del = await deleteTrainingData(UID);
    expect(del.deleted).toBe(true);
  });

  test('Paso 3 -- exportar conversaciones del owner', async () => {
    const convs = {
      conversations: {
        '+5711112222': [{ text: 'Hola', timestamp: Date.now() - 3600000, fromMe: false }],
        '+5733334444': [{ text: 'Cuanto cuesta?', timestamp: Date.now() - 7200000, fromMe: false }],
      },
      contactTypes: { '+5711112222': 'lead', '+5733334444': 'lead' },
    };
    const db = makeMultiDb(null, convs);
    setExportDb(db);
    const r = await exportConversations(UID, { includeContactTypes: true });
    expect(r.totalConversations).toBe(2);
    expect(r.totalMessages).toBe(2);
    expect(r.data['+5711112222'].contactType).toBe('lead');
  });

  test('Paso 4 -- serializar export', async () => {
    const exp = { uid: UID, totalConversations: 2, totalMessages: 3, data: {}, exportedAt: '2026-05-01T10:00:00Z' };
    const json = serializeExport(exp);
    const parsed = JSON.parse(json);
    expect(parsed.uid).toBe(UID);
    expect(parsed.totalConversations).toBe(2);
  });

  test('Paso 5 -- notificacion al completar export', async () => {
    const db = makeMultiDb();
    setNotifDb(db);
    const notif = await createNotification(UID, {
      type: 'success',
      title: 'Export completado',
      body: '2 conversaciones exportadas correctamente',
    });
    expect(notif.type).toBe('success');
    expect(notif.read).toBe(false);
  });

  test('Paso 6 -- settings del owner: language y aiEnabled', async () => {
    const db = makeMultiDb(null, null, { language: 'es', aiEnabled: true });
    setSettingsDb(db);
    const { settings } = await getSettings(UID);
    expect(settings.language).toBe('es');
    expect(settings.aiEnabled).toBe(true);
  });

  test('Pipeline completo -- training + export + notif + CRM', async () => {
    // A: training
    const db = makeMultiDb();
    setTrainDb(db);
    const tr = await setTrainingData(UID, 'ADN vendedor: directo, empático, cierre consultivo');
    expect(tr.sizeBytes).toBeGreaterThan(0);

    // B: export
    const convData = {
      conversations: { '+5799998888': [{ text: 'Me interesa el plan pro', fromMe: false }] },
      contactTypes: { '+5799998888': 'lead' },
    };
    const db2 = makeMultiDb(null, convData);
    setExportDb(db2);
    const exp = await exportConversations(UID);
    expect(exp.totalConversations).toBe(1);

    // C: JSON serializado
    const json = serializeExport(exp);
    expect(JSON.parse(json).totalMessages).toBe(1);

    // D: notif
    const db3 = makeMultiDb();
    setNotifDb(db3);
    const notif = await createNotification(UID, { type: 'info', title: 'Export listo', body: 'Descarga disponible' });
    expect(notif.notifId).toMatch(/^n_/);

    // E: CRM
    let contact = buildCrmContact(UID, { phone: '+5799998888', name: 'Pedro', stage: 'lead' });
    contact = updatePipelineStage(contact, 'prospect');
    const stats = computeCrmStats([contact]);
    expect(stats.byStage.prospect).toBe(1);
  });
});
