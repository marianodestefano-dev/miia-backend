'use strict';
const { getTrainingData, setTrainingData, deleteTrainingData, MAX_CONTENT_BYTES, __setFirestoreForTests } = require('../core/training_crud');

function makeMockDb({ data=null, throwGet=false, throwSet=false }={}) {
  let store = data ? { ...data } : null;
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              if (store) return { exists: true, data: () => store };
              return { exists: false };
            },
            set: async (newData) => {
              if (throwSet) throw new Error('set error');
              store = { ...newData };
            }
          })
        })
      })
    })
  };
}

afterEach(() => { __setFirestoreForTests(null); });

describe('getTrainingData', () => {
  test('lanza error si uid vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getTrainingData('')).rejects.toThrow('uid requerido');
  });
  test('retorna content vacio si doc no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getTrainingData('uid1');
    expect(r.content).toBe('');
    expect(r.sizeBytes).toBe(0);
    expect(r.updatedAt).toBeNull();
  });
  test('retorna content y sizeBytes correctos', async () => {
    const content = 'instrucciones de prueba para MIIA';
    __setFirestoreForTests(makeMockDb({ data: { content, updatedAt: '2026-01-01T00:00:00Z' } }));
    const r = await getTrainingData('uid1');
    expect(r.content).toBe(content);
    expect(r.sizeBytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(r.updatedAt).toBe('2026-01-01T00:00:00Z');
  });
});

describe('setTrainingData', () => {
  test('lanza error si uid vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(setTrainingData('', 'content')).rejects.toThrow('uid requerido');
  });
  test('lanza error si content no es string', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(setTrainingData('uid1', 12345)).rejects.toThrow('content debe ser string');
  });
  test('acepta string vacio (regla 6.1)', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await setTrainingData('uid1', '');
    expect(r.sizeBytes).toBe(0);
    expect(r).toHaveProperty('updatedAt');
  });
  test('retorna sizeBytes correcto al guardar', async () => {
    __setFirestoreForTests(makeMockDb());
    const content = 'Responde siempre en espanol';
    const r = await setTrainingData('uid1', content);
    expect(r.sizeBytes).toBe(Buffer.byteLength(content, 'utf8'));
  });
  test('lanza error si content excede MAX_CONTENT_BYTES', async () => {
    __setFirestoreForTests(makeMockDb());
    const bigContent = 'x'.repeat(MAX_CONTENT_BYTES + 1);
    await expect(setTrainingData('uid1', bigContent)).rejects.toThrow('excede el limite');
  });
  test('lanza error si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(setTrainingData('uid1', 'test')).rejects.toThrow('set error');
  });
});

describe('deleteTrainingData', () => {
  test('guarda string vacio en Firestore (regla 6.1)', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const r = await deleteTrainingData('uid1');
    expect(r.deleted).toBe(true);
    // Verificar que se puede leer de vuelta con content vacio
    const after = await getTrainingData('uid1');
    expect(after.content).toBe('');
  });
  test('lanza error si uid vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(deleteTrainingData('')).rejects.toThrow('uid requerido');
  });
});
