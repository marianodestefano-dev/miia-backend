'use strict';
const { applyDecay, runDecayForOwner, DECAY_THRESHOLD_DAYS, DECAY_RATE, MIN_FLOOR, __setFirestoreForTests } = require('../core/mmc_decay');

const DAY_MS = 24 * 60 * 60 * 1000;
const THRESHOLD_MS = DECAY_THRESHOLD_DAYS * DAY_MS;

function makeMockDb({ docs=[], throwList=false, throwUpdate=false }={}) {
  const docObjs = docs.map(({ id, entries }) => ({
    id,
    data: () => ({ entries }),
    ref: {
      update: async (data) => {
        if (throwUpdate) throw new Error('update error');
        docObjs.find(d => d.id === id)._updated = data;
      }
    }
  }));
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          get: async () => {
            if (throwList) throw new Error('list error');
            return { docs: docObjs };
          }
        })
      })
    })
  };
}

afterEach(() => { __setFirestoreForTests(null); });

describe('constantes', () => {
  test('DECAY_THRESHOLD_DAYS=90, DECAY_RATE=0.95, MIN_FLOOR=0.05', () => {
    expect(DECAY_THRESHOLD_DAYS).toBe(90);
    expect(DECAY_RATE).toBe(0.95);
    expect(MIN_FLOOR).toBe(0.05);
  });
});

describe('applyDecay', () => {
  test('memoria dentro del umbral (< 90d) no decae', () => {
    const now = 1000000000000;
    const memories = [{ type: 'lead', timestamp: now - 50 * DAY_MS }];
    const result = applyDecay(memories, now);
    expect(result[0].importanceScore).toBeUndefined(); // sin cambio
  });

  test('memoria exactamente en 90d no decae', () => {
    const now = 1000000000000;
    const memories = [{ type: 'lead', timestamp: now - 90 * DAY_MS }];
    const result = applyDecay(memories, now);
    expect(result[0].importanceScore).toBeUndefined();
  });

  test('memoria de 91d decae 1 dia: score = 0.5 * 0.95^1', () => {
    const now = 1000000000000;
    const memories = [{ type: 'lead', timestamp: now - 91 * DAY_MS }];
    const result = applyDecay(memories, now);
    const expected = 0.5 * Math.pow(0.95, 1);
    expect(result[0].importanceScore).toBeCloseTo(expected, 4);
  });

  test('memoria de 100d decae 10 dias: score = 0.8 * 0.95^10 para owner', () => {
    const now = 1000000000000;
    const memories = [{ type: 'owner', timestamp: now - 100 * DAY_MS }];
    const result = applyDecay(memories, now);
    const expected = 0.8 * Math.pow(0.95, 10);
    expect(result[0].importanceScore).toBeCloseTo(expected, 4);
  });

  test('score nunca baja de MIN_FLOOR=0.05', () => {
    const now = 1000000000000;
    // 500 dias extra = score casi 0
    const memories = [{ type: 'lead', timestamp: now - (90 + 500) * DAY_MS }];
    const result = applyDecay(memories, now);
    expect(result[0].importanceScore).toBeGreaterThanOrEqual(MIN_FLOOR);
    expect(result[0].importanceScore).toBe(MIN_FLOOR);
  });

  test('memoria sin timestamp no se modifica', () => {
    const now = 1000000000000;
    const memories = [{ type: 'lead', content: 'sin timestamp' }];
    const result = applyDecay(memories, now);
    expect(result[0]).toEqual(memories[0]);
  });

  test('retorna [] si memories no es array', () => {
    expect(applyDecay(null)).toEqual([]);
    expect(applyDecay(undefined)).toEqual([]);
  });
});

describe('runDecayForOwner', () => {
  test('lanza error si uid vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(runDecayForOwner('')).rejects.toThrow('uid requerido');
  });

  test('retorna { processed, updated, errors } con valores correctos', async () => {
    const now = 1000000000000;
    const entries = [
      { type: 'lead', timestamp: now - 100 * DAY_MS }, // decae
      { type: 'lead', timestamp: now - 50 * DAY_MS }  // no decae
    ];
    __setFirestoreForTests(makeMockDb({ docs: [{ id: 'phone1', entries }] }));
    const result = await runDecayForOwner('uid_test', now);
    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);
  });

  test('maneja errores de Firestore sin lanzar', async () => {
    __setFirestoreForTests(makeMockDb({ throwList: true }));
    const result = await runDecayForOwner('uid_err', Date.now());
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });
});
