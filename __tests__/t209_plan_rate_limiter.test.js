'use strict';

const {
  getPlanLimits, isValidPlan, getUsageToday,
  incrementUsage, checkLimit, checkAndConsume, getFullUsageSummary,
  PLANS, DEFAULT_PLAN,
  __setFirestoreForTests,
} = require('../core/plan_rate_limiter');

const UID = 'testUid1234567890';

function makeMockDb({ existingData = null, throwGet = false, throwSet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              if (!existingData) return { exists: false, data: () => ({}) };
              return { exists: true, data: () => existingData };
            },
            set: async () => {
              if (throwSet) throw new Error('set error');
            },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('PLANS y DEFAULT_PLAN', () => {
  test('tiene planes free starter pro enterprise', () => {
    expect(PLANS.free).toBeDefined();
    expect(PLANS.starter).toBeDefined();
    expect(PLANS.pro).toBeDefined();
    expect(PLANS.enterprise).toBeDefined();
  });
  test('es frozen', () => {
    expect(() => { PLANS.newplan = {}; }).toThrow();
  });
  test('DEFAULT_PLAN es free', () => {
    expect(DEFAULT_PLAN).toBe('free');
  });
  test('free tiene mensajes limitados', () => {
    expect(PLANS.free.messagesPerDay).toBeLessThan(PLANS.pro.messagesPerDay);
  });
  test('enterprise tiene mas limite que pro', () => {
    expect(PLANS.enterprise.messagesPerDay).toBeGreaterThan(PLANS.pro.messagesPerDay);
  });
});

describe('getPlanLimits', () => {
  test('retorna limites del plan correcto', () => {
    const limits = getPlanLimits('pro');
    expect(limits.messagesPerDay).toBe(PLANS.pro.messagesPerDay);
  });
  test('fallback a free para plan desconocido', () => {
    const limits = getPlanLimits('unknown_plan');
    expect(limits.messagesPerDay).toBe(PLANS.free.messagesPerDay);
  });
});

describe('isValidPlan', () => {
  test('true para planes validos', () => {
    expect(isValidPlan('free')).toBe(true);
    expect(isValidPlan('pro')).toBe(true);
  });
  test('false para plan invalido', () => {
    expect(isValidPlan('gold')).toBe(false);
  });
});

describe('getUsageToday', () => {
  test('lanza si uid undefined', async () => {
    await expect(getUsageToday(undefined, 'messagesPerDay')).rejects.toThrow('uid requerido');
  });
  test('lanza si metric undefined', async () => {
    await expect(getUsageToday(UID, undefined)).rejects.toThrow('metric requerido');
  });
  test('retorna 0 si no hay datos', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getUsageToday(UID, 'messagesPerDay');
    expect(r).toBe(0);
  });
  test('retorna valor guardado', async () => {
    __setFirestoreForTests(makeMockDb({ existingData: { messagesPerDay: 42 } }));
    const r = await getUsageToday(UID, 'messagesPerDay');
    expect(r).toBe(42);
  });
  test('fail-open retorna 0 si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getUsageToday(UID, 'messagesPerDay');
    expect(r).toBe(0);
  });
});

describe('incrementUsage', () => {
  test('lanza si uid undefined', async () => {
    await expect(incrementUsage(undefined, 'messagesPerDay')).rejects.toThrow('uid requerido');
  });
  test('incrementa sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(incrementUsage(UID, 'messagesPerDay')).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(incrementUsage(UID, 'messagesPerDay')).rejects.toThrow('set error');
  });
});

describe('checkLimit', () => {
  test('lanza si uid undefined', async () => {
    await expect(checkLimit(undefined, 'free', 'messagesPerDay')).rejects.toThrow('uid requerido');
  });
  test('lanza si metric desconocida', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(checkLimit(UID, 'free', 'unknownMetric')).rejects.toThrow('metric desconocida');
  });
  test('allowed true si bajo el limite', async () => {
    __setFirestoreForTests(makeMockDb({ existingData: { messagesPerDay: 50 } }));
    const r = await checkLimit(UID, 'free', 'messagesPerDay');
    expect(r.allowed).toBe(true);
    expect(r.used).toBe(50);
    expect(r.remaining).toBeGreaterThan(0);
  });
  test('allowed false si en el limite', async () => {
    __setFirestoreForTests(makeMockDb({ existingData: { messagesPerDay: PLANS.free.messagesPerDay } }));
    const r = await checkLimit(UID, 'free', 'messagesPerDay');
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });
});

describe('checkAndConsume', () => {
  test('consumed true si dentro del limite', async () => {
    __setFirestoreForTests(makeMockDb({ existingData: { messagesPerDay: 0 } }));
    const r = await checkAndConsume(UID, 'free', 'messagesPerDay');
    expect(r.consumed).toBe(true);
    expect(r.allowed).toBe(true);
  });
  test('consumed false si en el limite', async () => {
    __setFirestoreForTests(makeMockDb({ existingData: { messagesPerDay: PLANS.free.messagesPerDay } }));
    const r = await checkAndConsume(UID, 'free', 'messagesPerDay');
    expect(r.consumed).toBe(false);
    expect(r.allowed).toBe(false);
  });
});

describe('getFullUsageSummary', () => {
  test('lanza si uid undefined', async () => {
    await expect(getFullUsageSummary(undefined, 'free')).rejects.toThrow('uid requerido');
  });
  test('lanza si plan undefined', async () => {
    await expect(getFullUsageSummary(UID, undefined)).rejects.toThrow('plan requerido');
  });
  test('retorna resumen completo', async () => {
    __setFirestoreForTests(makeMockDb({ existingData: { messagesPerDay: 10 } }));
    const r = await getFullUsageSummary(UID, 'free');
    expect(r.uid).toBe(UID);
    expect(r.plan).toBe('free');
    expect(r.metrics.messagesPerDay).toBeDefined();
    expect(r.metrics.messagesPerDay.limit).toBe(PLANS.free.messagesPerDay);
  });
});
