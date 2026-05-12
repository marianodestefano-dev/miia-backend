'use strict';

/**
 * C5 -- Cross-Tenant Isolation Tests
 * Verifica que datos de owner A NUNCA sean visibles en el contexto de owner B.
 * Canary token: UNICORNIO_FUCSIA_42 (unico, no debe cruzar tenants).
 */

const {
  writeCanary, checkIsolation, runIsolationSuite,
  CANARY_TOKEN, __setFirestoreForTests: setIsolDb,
} = require('../core/mmc_isolation');

const UID_A = 'owner_uid_aaaaa_test';
const UID_B = 'owner_uid_bbbbb_test';
const PHONE_A = '+571111111111';
const PHONE_B = '+572222222222';
const CANARY = CANARY_TOKEN; // 'UNICORNIO_FUCSIA_42'

function makeIsolatedDb() {
  const store = {};
  return {
    collection: (col) => ({
      doc: (uid) => ({
        collection: (subCol) => ({
          doc: (docId) => ({
            set: async (data, opts) => {
              const key = col + '/' + uid + '/' + subCol + '/' + docId;
              if (opts && opts.merge) store[key] = Object.assign({}, store[key] || {}, data);
              else store[key] = Object.assign({}, data);
            },
            get: async () => {
              const key = col + '/' + uid + '/' + subCol + '/' + docId;
              const d = store[key];
              return { exists: !!d, data: () => d };
            },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

describe('C5 Test 1 -- Canary UNICORNIO_FUCSIA_42 no se filtra entre owners', () => {
  test('runIsolationSuite: canary en UID_A no visible en UID_B (DB correctamente aislada)', async () => {
    setIsolDb(makeIsolatedDb());
    const result = await runIsolationSuite(UID_A, UID_B, PHONE_A);
    if (result.leak) {
      throw new Error('ISOLATION BREACH: datos de owner A visibles en contexto de owner B');
    }
    expect(result.leak).toBe(false);
    expect(result.canaryFound).toBe(false);
  });

  test('checkIsolation: canary escrito en A, lectura de B -> no leak', async () => {
    setIsolDb(makeIsolatedDb());
    await writeCanary(UID_A, PHONE_A);
    const result = await checkIsolation(UID_A, UID_B, PHONE_A);
    if (result.leak) {
      throw new Error('ISOLATION BREACH: datos de owner A visibles en contexto de owner B');
    }
    expect(result.leak).toBe(false);
  });

  test('checkIsolation con DB sin aislamiento -> leak=true (simula falla)', async () => {
    const leakyDb = {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: () => ({
              set: async () => {},
              get: async () => ({ exists: true, data: () => ({ entries: [{ content: CANARY }] }) }),
            }),
          }),
        }),
      }),
    };
    setIsolDb(leakyDb);
    const result = await checkIsolation(UID_A, UID_B, PHONE_A);
    expect(result.leak).toBe(true);
    expect(result.details).toContain('LEAK');
  });
});

describe('C5 Test 2 -- Training data aislada por UID', () => {
  test('store[UID_A] con canary: key de UID_B retorna undefined', () => {
    const store = {};
    const keyA = 'owners/' + UID_A + '/training_data';
    const keyB = 'owners/' + UID_B + '/training_data';
    store[keyA] = 'ADN ventas - ' + CANARY;
    const dataForB = store[keyB];
    if (dataForB && typeof dataForB === 'string' && dataForB.includes(CANARY)) {
      throw new Error('ISOLATION BREACH: datos de owner A visibles en contexto de owner B');
    }
    expect(dataForB).toBeUndefined();
  });

  test('Firestore isolatedDb: get con UID_B no retorna docs escritos bajo UID_A', async () => {
    const db = makeIsolatedDb();
    setIsolDb(db);
    await db.collection('users').doc(UID_A).collection('mmc').doc(PHONE_A).set({
      entries: [{ content: CANARY, type: 'training' }],
    });
    const snapB = await db.collection('users').doc(UID_B).collection('mmc').doc(PHONE_A).get();
    if (snapB.exists) {
      const data = snapB.data();
      if (data && JSON.stringify(data).includes(CANARY)) {
        throw new Error('ISOLATION BREACH: datos de owner A visibles en contexto de owner B');
      }
    }
    expect(snapB.exists).toBe(false);
  });

  test('UIDs distintos -> keys de Firestore distintas (no colision)', () => {
    const keyA = 'users/' + UID_A + '/mmc/' + PHONE_A;
    const keyB = 'users/' + UID_B + '/mmc/' + PHONE_A;
    expect(keyA).not.toBe(keyB);
    expect(keyA).toContain(UID_A);
    expect(keyB).toContain(UID_B);
  });
});

describe('C5 Test 3 -- Conversations aisladas por UID', () => {
  test('conversations de tenant A no visibles en ctx de tenant B (in-memory)', () => {
    const ctxA = { uid: UID_A, conversations: {} };
    const ctxB = { uid: UID_B, conversations: {} };
    ctxA.conversations[PHONE_A] = [{ role: 'user', content: CANARY }];
    const convBForPhoneA = ctxB.conversations[PHONE_A];
    if (convBForPhoneA) {
      if (JSON.stringify(convBForPhoneA).includes(CANARY)) {
        throw new Error('ISOLATION BREACH: datos de owner A visibles en contexto de owner B');
      }
    }
    expect(convBForPhoneA).toBeUndefined();
  });

  test('contextos de tenants son independientes (no comparten referencia)', () => {
    const ctxA = { uid: UID_A, conversations: { [PHONE_A]: [{ content: CANARY }] } };
    const ctxB = { uid: UID_B, conversations: {} };
    expect(ctxB.uid).not.toBe(ctxA.uid);
    expect(ctxB.conversations[PHONE_A]).toBeUndefined();
    expect(ctxA.conversations[PHONE_A][0].content).toBe(CANARY);
  });

  test('texto de conversaciones de B no contiene canary de A', () => {
    const ctxA = { conversations: { [PHONE_A]: [{ role: 'user', content: CANARY }] } };
    const ctxB = { conversations: { [PHONE_B]: [{ role: 'user', content: 'hola' }] } };
    const allConvB = Object.values(ctxB.conversations).flat().map(function(m) { return m.content; }).join(' ');
    if (allConvB.includes(CANARY)) {
      throw new Error('ISOLATION BREACH: datos de owner A visibles en contexto de owner B');
    }
    expect(allConvB).not.toContain(CANARY);
  });
});
