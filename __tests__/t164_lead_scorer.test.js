'use strict';

const {
  calculateScore, recordInteraction, getLeadInteractions,
  checkAlertThreshold, getPendingAlerts,
  INTERACTION_WEIGHTS, DEFAULT_ALERT_THRESHOLD, MAX_SCORE, SCORE_DECAY_DAYS,
  __setFirestoreForTests,
} = require('../core/lead_scorer');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const NOW = new Date('2026-05-04T12:00:00.000Z').getTime();

function makeMockDb({ throwGet = false, throwSet = false } = {}) {
  const innerColl = {
    doc: () => ({ set: async () => { if (throwSet) throw new Error('set error'); } }),
    get: async () => {
      if (throwGet) throw new Error('get error');
      return { forEach: fn => {} };
    },
    where: () => ({
      get: async () => {
        if (throwGet) throw new Error('get error');
        return { forEach: fn => {} };
      },
    }),
  };
  const outerDoc = {
    collection: () => innerColl,
  };
  const outerColl = {
    doc: () => outerDoc,
  };
  const rootDoc = {
    collection: () => outerColl,
  };
  const rootColl = {
    doc: () => rootDoc,
  };
  return {
    collection: () => rootColl,
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('INTERACTION_WEIGHTS y constants', () => {
  test('tiene pesos para todos los tipos', () => {
    expect(INTERACTION_WEIGHTS.message_sent).toBeDefined();
    expect(INTERACTION_WEIGHTS.price_inquiry).toBeGreaterThan(INTERACTION_WEIGHTS.message_sent);
    expect(INTERACTION_WEIGHTS.catalog_purchase).toBeGreaterThan(INTERACTION_WEIGHTS.price_inquiry);
  });
  test('es frozen', () => {
    expect(() => { INTERACTION_WEIGHTS.nuevo = 99; }).toThrow();
  });
  test('DEFAULT_ALERT_THRESHOLD es 20', () => { expect(DEFAULT_ALERT_THRESHOLD).toBe(20); });
  test('MAX_SCORE es 100', () => { expect(MAX_SCORE).toBe(100); });
});

describe('calculateScore', () => {
  test('lanza si interactions no es array', () => {
    expect(() => calculateScore('nope')).toThrow('debe ser array');
  });
  test('retorna score 0 para lista vacia', () => {
    const r = calculateScore([]);
    expect(r.score).toBe(0);
    expect(r.level).toBe('cold');
    expect(r.interactions).toBe(0);
  });
  test('score aumenta con mas interacciones recientes', () => {
    const interactions = [
      { type: 'message_sent', timestamp: new Date(NOW).toISOString() },
      { type: 'price_inquiry', timestamp: new Date(NOW).toISOString() },
    ];
    const r = calculateScore(interactions, NOW);
    expect(r.score).toBeGreaterThan(0);
  });
  test('compra da score alto', () => {
    const r = calculateScore([
      { type: 'catalog_purchase', timestamp: new Date(NOW).toISOString() },
    ], NOW);
    expect(r.score).toBeGreaterThanOrEqual(15);
    expect(['hot', 'warm', 'interested']).toContain(r.level);
  });
  test('score antiguo decae', () => {
    const oldTs = new Date(NOW - SCORE_DECAY_DAYS * 24 * 60 * 60 * 1000 - 1000).toISOString();
    const r = calculateScore([
      { type: 'catalog_purchase', timestamp: oldTs },
    ], NOW);
    expect(r.score).toBe(0);
  });
  test('capped en MAX_SCORE', () => {
    const many = Array.from({ length: 30 }, () => ({
      type: 'catalog_purchase', timestamp: new Date(NOW).toISOString(),
    }));
    const r = calculateScore(many, NOW);
    expect(r.score).toBe(MAX_SCORE);
  });
  test('nivel hot para score alto', () => {
    const many = Array.from({ length: 5 }, () => ({
      type: 'catalog_purchase', timestamp: new Date(NOW).toISOString(),
    }));
    const r = calculateScore(many, NOW);
    expect(r.level).toBe('hot');
  });
  test('nivel cold para score cero', () => {
    expect(calculateScore([], NOW).level).toBe('cold');
  });
  test('acepta weight personalizado', () => {
    const r = calculateScore([{ type: 'message_sent', timestamp: new Date(NOW).toISOString(), weight: 50 }], NOW);
    expect(r.score).toBeGreaterThan(INTERACTION_WEIGHTS.message_sent);
  });
});

describe('recordInteraction', () => {
  test('lanza si uid undefined', async () => {
    await expect(recordInteraction(undefined, PHONE, 'message_sent')).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(recordInteraction(UID, undefined, 'message_sent')).rejects.toThrow('phone requerido');
  });
  test('lanza si tipo invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordInteraction(UID, PHONE, 'tipo_falso')).rejects.toThrow('tipo invalido');
  });
  test('registra sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordInteraction(UID, PHONE, 'message_sent')).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordInteraction(UID, PHONE, 'message_sent')).rejects.toThrow('set error');
  });
});

describe('checkAlertThreshold', () => {
  test('lanza si uid undefined', async () => {
    await expect(checkAlertThreshold(undefined, PHONE, 50)).rejects.toThrow('uid requerido');
  });
  test('lanza si score no es numero', async () => {
    await expect(checkAlertThreshold(UID, PHONE, 'alto')).rejects.toThrow('numero');
  });
  test('shouldAlert = true si score >= threshold', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await checkAlertThreshold(UID, PHONE, 25, 20);
    expect(r.shouldAlert).toBe(true);
    expect(r.score).toBe(25);
  });
  test('shouldAlert = false si score < threshold', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await checkAlertThreshold(UID, PHONE, 10, 20);
    expect(r.shouldAlert).toBe(false);
  });
  test('usa DEFAULT_ALERT_THRESHOLD si no se provee', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await checkAlertThreshold(UID, PHONE, DEFAULT_ALERT_THRESHOLD);
    expect(r.shouldAlert).toBe(true);
  });
  test('fail-soft en error Firestore al guardar alerta', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const r = await checkAlertThreshold(UID, PHONE, 50, 20);
    expect(r.shouldAlert).toBe(true);
  });
});

describe('getPendingAlerts', () => {
  test('lanza si uid undefined', async () => {
    await expect(getPendingAlerts(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay alertas', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getPendingAlerts(UID);
    expect(r).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getPendingAlerts(UID);
    expect(r).toEqual([]);
  });
});
