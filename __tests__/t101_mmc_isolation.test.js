'use strict';
const { writeCanary, checkIsolation, runIsolationSuite, CANARY_TOKEN, __setFirestoreForTests } = require('../core/mmc_isolation');

const UID_A = 'tenantAAAA0000000000000000';
const UID_B = 'tenantBBBB0000000000000000';
const PHONE = '+573001234567';

// Simulamos Firestore in-memory separado por uid
function makeMockDb(storeMap = {}) {
  return {
    collection: () => ({
      doc: (uid) => ({
        collection: () => ({
          doc: (phone) => ({
            get: async () => {
              const key = `${uid}/${phone}`;
              if (storeMap[key]) return { exists: true, data: () => storeMap[key] };
              return { exists: false };
            },
            set: async (data, opts) => {
              const key = `${uid}/${phone}`;
              if (opts && opts.merge) {
                storeMap[key] = Object.assign({}, storeMap[key] || {}, data);
              } else {
                storeMap[key] = data;
              }
            }
          })
        })
      })
    })
  };
}

afterEach(() => { __setFirestoreForTests(null); });

describe('CANARY_TOKEN', () => {
  test('es el valor esperado', () => {
    expect(CANARY_TOKEN).toBe('UNICORNIO_FUCSIA_42');
  });
});

describe('writeCanary', () => {
  test('lanza error si uid o phone son falsy', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(writeCanary('', PHONE)).rejects.toThrow('uidA y phone requeridos');
    await expect(writeCanary(UID_A, '')).rejects.toThrow('uidA y phone requeridos');
  });

  test('escribe canary en el path correcto y retorna docPath', async () => {
    const store = {};
    __setFirestoreForTests(makeMockDb(store));
    const path = await writeCanary(UID_A, PHONE);
    expect(path).toContain(UID_A);
    expect(path).toContain(PHONE);
    const key = `${UID_A}/${PHONE}`;
    expect(store[key]).toBeDefined();
    expect(store[key].entries[0].content).toBe(CANARY_TOKEN);
  });
});

describe('checkIsolation', () => {
  test('lanza error si uidA === uidB', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(checkIsolation(UID_A, UID_A, PHONE)).rejects.toThrow('deben ser distintos');
  });

  test('retorna leak=false si uidB no tiene datos', async () => {
    const store = {};
    __setFirestoreForTests(makeMockDb(store));
    // Solo escribir en UID_A, no en UID_B
    store[`${UID_A}/${PHONE}`] = { entries: [{ content: CANARY_TOKEN }] };
    const result = await checkIsolation(UID_A, UID_B, PHONE);
    expect(result.leak).toBe(false);
  });

  test('retorna leak=true si canary aparece en uidB', async () => {
    const store = {};
    // Simular leak: poner datos de A en B
    store[`${UID_A}/${PHONE}`] = { entries: [{ content: CANARY_TOKEN }] };
    store[`${UID_B}/${PHONE}`] = { entries: [{ content: CANARY_TOKEN }] }; // LEAK
    __setFirestoreForTests(makeMockDb(store));
    const result = await checkIsolation(UID_A, UID_B, PHONE);
    expect(result.leak).toBe(true);
    expect(result.canaryFound).toBe(true);
    expect(result.details).toContain('LEAK');
  });

  test('retorna leak=false si uidB tiene datos distintos (sin canary)', async () => {
    const store = {};
    store[`${UID_A}/${PHONE}`] = { entries: [{ content: CANARY_TOKEN }] };
    store[`${UID_B}/${PHONE}`] = { entries: [{ content: 'data propia de B', type: 'lead' }] };
    __setFirestoreForTests(makeMockDb(store));
    const result = await checkIsolation(UID_A, UID_B, PHONE);
    expect(result.leak).toBe(false);
  });
});

describe('runIsolationSuite', () => {
  test('retorna leak=false en aislamiento correcto', async () => {
    const store = {};
    __setFirestoreForTests(makeMockDb(store));
    const result = await runIsolationSuite(UID_A, UID_B, PHONE);
    expect(result.leak).toBe(false);
    expect(result.uidA).toBe(UID_A);
    expect(result.uidB).toBe(UID_B);
  });

  test('retorna leak=true si store comparte datos entre uids', async () => {
    // Store compartido = simula falla de aislamiento donde A y B leen del mismo bucket
    const sharedBucket = {};
    const leakyDb = {
      collection: () => ({
        doc: () => ({ // MISMO doc para todos los uids
          collection: () => ({
            doc: (phone) => ({
              get: async () => {
                if (sharedBucket[phone]) return { exists: true, data: () => sharedBucket[phone] };
                return { exists: false };
              },
              set: async (data, opts) => {
                sharedBucket[phone] = opts && opts.merge
                  ? Object.assign({}, sharedBucket[phone] || {}, data)
                  : data;
              }
            })
          })
        })
      })
    };
    __setFirestoreForTests(leakyDb);
    const result = await runIsolationSuite(UID_A, UID_B, PHONE);
    expect(result.leak).toBe(true);
  });
});
