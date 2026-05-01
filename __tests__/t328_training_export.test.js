'use strict';

const {
  getTrainingData, setTrainingData, deleteTrainingData,
  MAX_CONTENT_BYTES, __setFirestoreForTests: setTrainDb,
} = require('../core/training_crud');

const {
  exportConversations, serializeExport,
  __setFirestoreForTests: setExportDb,
} = require('../core/conversation_export');

const UID = 'uid_t328_test';
const NOW = 1000000000000;
const DAY = 24 * 60 * 60 * 1000;

// Mock Firestore para training_data y tenant_conversations
function makeDocDb(docData = null) {
  const store = {};
  return {
    collection: (col) => ({
      doc: (uid) => ({
        collection: (subCol) => ({
          doc: (docId) => ({
            get: async () => {
              const key = `${col}/${uid}/${subCol}/${docId}`;
              const d = store[key];
              if (d !== undefined) return { exists: true, data: () => d };
              if (docData !== null) return { exists: true, data: () => docData };
              return { exists: false };
            },
            set: async (data, opts) => {
              const key = `${col}/${uid}/${subCol}/${docId}`;
              if (opts && opts.merge) {
                store[key] = { ...(store[key] || {}), ...data };
              } else {
                store[key] = { ...data };
              }
            },
          }),
        }),
      }),
    }),
  };
}

describe('T328 -- training_crud + conversation_export (22 tests)', () => {

  // MAX_CONTENT_BYTES
  test('MAX_CONTENT_BYTES = 50KB', () => {
    expect(MAX_CONTENT_BYTES).toBe(50 * 1024);
  });

  // getTrainingData
  test('getTrainingData: uid null lanza', async () => {
    await expect(getTrainingData(null)).rejects.toThrow('uid requerido');
  });

  test('getTrainingData: doc no existe -> content=""', async () => {
    setTrainDb(makeDocDb(null));
    const r = await getTrainingData(UID);
    expect(r.content).toBe('');
    expect(r.sizeBytes).toBe(0);
    expect(r.updatedAt).toBeNull();
  });

  test('getTrainingData: retorna content + sizeBytes', async () => {
    setTrainDb(makeDocDb({ content: 'Hola mundo', updatedAt: '2026-05-01T10:00:00Z' }));
    const r = await getTrainingData(UID);
    expect(r.content).toBe('Hola mundo');
    expect(r.sizeBytes).toBeGreaterThan(0);
    expect(r.updatedAt).toBe('2026-05-01T10:00:00Z');
  });

  test('getTrainingData: uid retornado', async () => {
    setTrainDb(makeDocDb(null));
    const r = await getTrainingData(UID);
    expect(r.uid).toBe(UID);
  });

  // setTrainingData
  test('setTrainingData: uid null lanza', async () => {
    await expect(setTrainingData(null, 'x')).rejects.toThrow('uid requerido');
  });

  test('setTrainingData: content no string lanza', async () => {
    setTrainDb(makeDocDb(null));
    await expect(setTrainingData(UID, 123)).rejects.toThrow('content debe ser string');
  });

  test('setTrainingData: content demasiado grande lanza', async () => {
    setTrainDb(makeDocDb(null));
    const bigContent = 'x'.repeat(MAX_CONTENT_BYTES + 1);
    await expect(setTrainingData(UID, bigContent)).rejects.toThrow('excede el limite');
  });

  test('setTrainingData: content vacio valido (bug 6.1)', async () => {
    setTrainDb(makeDocDb(null));
    const r = await setTrainingData(UID, '');
    expect(r.sizeBytes).toBe(0);
    expect(r.updatedAt).toBeDefined();
  });

  test('setTrainingData: retorna sizeBytes y updatedAt', async () => {
    setTrainDb(makeDocDb(null));
    const r = await setTrainingData(UID, 'Mi training data personalizado');
    expect(r.sizeBytes).toBeGreaterThan(0);
    expect(r.uid).toBe(UID);
  });

  // deleteTrainingData
  test('deleteTrainingData: uid null lanza', async () => {
    await expect(deleteTrainingData(null)).rejects.toThrow('uid requerido');
  });

  test('deleteTrainingData: retorna {uid, deleted:true}', async () => {
    setTrainDb(makeDocDb(null));
    const r = await deleteTrainingData(UID);
    expect(r.deleted).toBe(true);
    expect(r.uid).toBe(UID);
  });

  // exportConversations
  test('exportConversations: uid null lanza', async () => {
    await expect(exportConversations(null)).rejects.toThrow('uid requerido');
  });

  test('exportConversations: doc no existe -> totalConversations=0', async () => {
    setExportDb(makeDocDb(null));
    const r = await exportConversations(UID);
    expect(r.totalConversations).toBe(0);
    expect(r.totalMessages).toBe(0);
  });

  test('exportConversations: exporta todas las conversations', async () => {
    const docData = {
      conversations: {
        '+571111': [{ text: 'A' }, { text: 'B' }],
        '+572222': [{ text: 'C' }],
      },
      contactTypes: { '+571111': 'lead', '+572222': 'client' },
    };
    setExportDb(makeDocDb(docData));
    const r = await exportConversations(UID);
    expect(r.totalConversations).toBe(2);
    expect(r.totalMessages).toBe(3);
    expect(r.exportedAt).toBeDefined();
  });

  test('exportConversations: filtrar por phone', async () => {
    const docData = {
      conversations: {
        '+571111': [{ text: 'A' }, { text: 'B' }],
        '+572222': [{ text: 'C' }],
      },
      contactTypes: {},
    };
    setExportDb(makeDocDb(docData));
    const r = await exportConversations(UID, { phone: '+571111' });
    expect(r.totalConversations).toBe(1);
    expect(r.totalMessages).toBe(2);
    expect(r.data['+571111']).toBeDefined();
    expect(r.data['+572222']).toBeUndefined();
  });

  test('exportConversations: phone no encontrado -> 0 conversations', async () => {
    const docData = { conversations: { '+571111': [] }, contactTypes: {} };
    setExportDb(makeDocDb(docData));
    const r = await exportConversations(UID, { phone: '+599999' });
    expect(r.totalConversations).toBe(0);
  });

  test('exportConversations: includeContactTypes agrega contactType', async () => {
    const docData = {
      conversations: { '+571111': [{ text: 'A' }] },
      contactTypes: { '+571111': 'lead' },
    };
    setExportDb(makeDocDb(docData));
    const r = await exportConversations(UID, { includeContactTypes: true });
    expect(r.data['+571111'].contactType).toBe('lead');
  });

  test('exportConversations: uid en resultado', async () => {
    setExportDb(makeDocDb(null));
    const r = await exportConversations(UID);
    expect(r.uid).toBe(UID);
  });

  // serializeExport
  test('serializeExport: null lanza', () => {
    expect(() => serializeExport(null)).toThrow('exportObj requerido');
  });

  test('serializeExport: retorna JSON string valido', () => {
    const obj = { uid: UID, totalConversations: 1, data: {} };
    const json = serializeExport(obj);
    expect(typeof json).toBe('string');
    const parsed = JSON.parse(json);
    expect(parsed.uid).toBe(UID);
  });
});
