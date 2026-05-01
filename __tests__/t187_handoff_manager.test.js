'use strict';

const {
  initiateHandoff, updateHandoffState, isHandoffActive,
  getPendingHandoffs, shouldMiiaRespond,
  HANDOFF_MODES, HANDOFF_REASONS, HANDOFF_STATES,
  DEFAULT_HANDOFF_TIMEOUT_MINS, __setFirestoreForTests,
} = require('../core/handoff_manager');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function makeMockDb({ pendingHandoffs = [], activeHandoffs = [], throwSet = false } = {}) {
  const docStore = {};
  const allHandoffs = [...pendingHandoffs, ...activeHandoffs];

  function makeWhereColl(items) {
    const obj = {
      where: (f, op, v) => {
        const filtered1 = items.filter(i => i[f] === v);
        return {
          where: (f2, op2, v2) => {
            const filtered2 = filtered1.filter(i => i[f2] === v2);
            return {
              get: async () => {
                const docs = filtered2.map((i, idx) => ({ id: 'doc' + idx, data: () => i }));
                return { forEach: fn => docs.forEach(fn) };
              },
            };
          },
          get: async () => {
            const docs = filtered1.map((i, idx) => ({ id: 'doc' + idx, data: () => i }));
            return { forEach: fn => docs.forEach(fn) };
          },
        };
      },
      doc: (id) => ({
        set: async (data, opts) => {
          if (throwSet) throw new Error('set error');
          docStore[id] = Object.assign(docStore[id] || {}, data);
        },
      }),
    };
    return obj;
  }

  const activeColl = makeWhereColl(allHandoffs);
  const uidDoc = { collection: () => activeColl };
  return { collection: () => ({ doc: () => uidDoc }) };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('constants', () => {
  test('HANDOFF_STATES incluye pending active resolved', () => {
    expect(HANDOFF_STATES).toContain('pending');
    expect(HANDOFF_STATES).toContain('active');
    expect(HANDOFF_STATES).toContain('resolved');
  });
  test('HANDOFF_REASONS es frozen', () => {
    expect(() => { HANDOFF_REASONS.push('x'); }).toThrow();
  });
  test('DEFAULT_HANDOFF_TIMEOUT_MINS es 30', () => { expect(DEFAULT_HANDOFF_TIMEOUT_MINS).toBe(30); });
  test('HANDOFF_MODES incluye auto manual escalation', () => {
    expect(HANDOFF_MODES).toContain('auto');
    expect(HANDOFF_MODES).toContain('manual');
    expect(HANDOFF_MODES).toContain('escalation');
  });
});

describe('initiateHandoff', () => {
  test('lanza si uid undefined', async () => {
    await expect(initiateHandoff(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(initiateHandoff(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('inicia handoff sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await initiateHandoff(UID, PHONE, { reason: 'complaint' });
    expect(r.handoffId).toBeDefined();
    expect(r.state).toBe('pending');
    expect(r.reason).toBe('complaint');
    expect(r.expiresAt).toBeDefined();
  });
  test('usa defaults si reason o mode invalidos', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await initiateHandoff(UID, PHONE, { reason: 'reason_falso', mode: 'mode_falso' });
    expect(r.state).toBe('pending');
  });
  test('acepta timeoutMins custom', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await initiateHandoff(UID, PHONE, { timeoutMins: 60 });
    const diff = new Date(r.expiresAt).getTime() - new Date(r.createdAt).getTime();
    expect(diff).toBeGreaterThanOrEqual(59 * 60 * 1000);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(initiateHandoff(UID, PHONE)).rejects.toThrow('set error');
  });
});


describe('updateHandoffState', () => {
  test('lanza si uid undefined', async () => {
    await expect(updateHandoffState(undefined, 'h1', 'active')).rejects.toThrow('uid requerido');
  });
  test('lanza si handoffId undefined', async () => {
    await expect(updateHandoffState(UID, undefined, 'active')).rejects.toThrow('handoffId requerido');
  });
  test('lanza si state invalido', async () => {
    await expect(updateHandoffState(UID, 'h1', 'estado_falso')).rejects.toThrow('state invalido');
  });
  test('actualiza sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateHandoffState(UID, 'h1', 'active')).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(updateHandoffState(UID, 'h1', 'resolved')).rejects.toThrow('set error');
  });
});

describe('isHandoffActive', () => {
  test('lanza si uid undefined', async () => {
    await expect(isHandoffActive(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('retorna false si sin handoffs activos', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await isHandoffActive(UID, PHONE)).toBe(false);
  });
  test('retorna true si hay handoff activo no expirado', async () => {
    const active = [{ phone: PHONE, state: 'active', expiresAt: FUTURE }];
    __setFirestoreForTests(makeMockDb({ activeHandoffs: active }));
    expect(await isHandoffActive(UID, PHONE)).toBe(true);
  });
  test('retorna false si handoff activo pero expirado', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const active = [{ phone: PHONE, state: 'active', expiresAt: past }];
    __setFirestoreForTests(makeMockDb({ activeHandoffs: active }));
    expect(await isHandoffActive(UID, PHONE)).toBe(false);
  });
  test('fail-open retorna false si Firestore falla', async () => {
    const failDb = { collection: () => ({ doc: () => ({ collection: () => ({ where: () => ({ where: () => ({ get: async () => { throw new Error('err'); } }) }) }) }) }) };
    __setFirestoreForTests(failDb);
    expect(await isHandoffActive(UID, PHONE)).toBe(false);
  });
});

describe('getPendingHandoffs', () => {
  test('lanza si uid undefined', async () => {
    await expect(getPendingHandoffs(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si sin pendientes', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getPendingHandoffs(UID)).toEqual([]);
  });
  test('retorna handoffs pendientes', async () => {
    const pending = [{ phone: PHONE, state: 'pending', reason: 'complaint' }];
    __setFirestoreForTests(makeMockDb({ pendingHandoffs: pending }));
    const r = await getPendingHandoffs(UID);
    expect(r.length).toBe(1);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    const failDb = { collection: () => ({ doc: () => ({ collection: () => ({ where: () => ({ get: async () => { throw new Error('err'); } }) }) }) }) };
    __setFirestoreForTests(failDb);
    expect(await getPendingHandoffs(UID)).toEqual([]);
  });
});

describe('shouldMiiaRespond', () => {
  test('lanza si uid undefined', async () => {
    await expect(shouldMiiaRespond(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('retorna true si sin handoff activo', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await shouldMiiaRespond(UID, PHONE)).toBe(true);
  });
  test('retorna false si hay handoff activo', async () => {
    const active = [{ phone: PHONE, state: 'active', expiresAt: FUTURE }];
    __setFirestoreForTests(makeMockDb({ activeHandoffs: active }));
    expect(await shouldMiiaRespond(UID, PHONE)).toBe(false);
  });
});
