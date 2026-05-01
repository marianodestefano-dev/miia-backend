'use strict';

const {
  requestHandoff, updateHandoffStatus, getActiveHandoffs, getHandoffsByPhone,
  isHandoffExpired, timeoutExpiredHandoffs, buildHandoffNotificationText,
  isValidStatus, isValidReason,
  HANDOFF_STATUSES, HANDOFF_REASONS, DEFAULT_TIMEOUT_MS, MAX_HANDOFFS_PER_QUERY,
  __setFirestoreForTests,
} = require('../core/handoff_manager');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';

function makeMockDb({ docs = [], throwSet = false, throwGet = false } = {}) {
  const docsMap = {};
  docs.forEach(d => { docsMap[d.id] = d; });
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
            },
          }),
          where: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const items = Object.entries(docsMap).map(([id, data]) => ({ id, data: () => data }));
              return { forEach: fn => items.forEach(fn) };
            },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('HANDOFF_STATUSES y HANDOFF_REASONS', () => {
  test('HANDOFF_STATUSES tiene 5 valores', () => { expect(HANDOFF_STATUSES.length).toBe(5); });
  test('HANDOFF_REASONS tiene 7 valores', () => { expect(HANDOFF_REASONS.length).toBe(7); });
  test('frozen HANDOFF_STATUSES', () => { expect(() => { HANDOFF_STATUSES.push('x'); }).toThrow(); });
  test('frozen HANDOFF_REASONS', () => { expect(() => { HANDOFF_REASONS.push('x'); }).toThrow(); });
  test('DEFAULT_TIMEOUT_MS es 30 minutos', () => { expect(DEFAULT_TIMEOUT_MS).toBe(30 * 60 * 1000); });
  test('MAX_HANDOFFS_PER_QUERY es 100', () => { expect(MAX_HANDOFFS_PER_QUERY).toBe(100); });
});

describe('isValidStatus e isValidReason', () => {
  test('pending es status valido', () => { expect(isValidStatus('pending')).toBe(true); });
  test('unknown no es status valido', () => { expect(isValidStatus('unknown')).toBe(false); });
  test('owner_request es reason valido', () => { expect(isValidReason('owner_request')).toBe(true); });
  test('random no es reason valido', () => { expect(isValidReason('random')).toBe(false); });
});

describe('requestHandoff', () => {
  test('lanza si uid undefined', async () => {
    await expect(requestHandoff(undefined, PHONE, 'owner_request')).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(requestHandoff(UID, undefined, 'owner_request')).rejects.toThrow('phone requerido');
  });
  test('lanza si reason undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(requestHandoff(UID, PHONE, undefined)).rejects.toThrow('reason requerido');
  });
  test('lanza si reason invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(requestHandoff(UID, PHONE, 'desconocido')).rejects.toThrow('reason invalido');
  });
  test('retorna handoffId y record', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await requestHandoff(UID, PHONE, 'lead_request');
    expect(r.handoffId).toBeDefined();
    expect(r.record.status).toBe('pending');
    expect(r.record.phone).toBe(PHONE);
    expect(r.record.reason).toBe('lead_request');
  });
  test('record tiene expiresAt', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await requestHandoff(UID, PHONE, 'complex_query');
    expect(r.record.expiresAt).toBeDefined();
    expect(new Date(r.record.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
  test('usa timeoutMs personalizado', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await requestHandoff(UID, PHONE, 'complaint', { timeoutMs: 60000 });
    const expires = new Date(r.record.expiresAt).getTime();
    expect(expires - Date.now()).toBeLessThanOrEqual(61000);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(requestHandoff(UID, PHONE, 'payment')).rejects.toThrow('set error');
  });
});

describe('updateHandoffStatus', () => {
  test('lanza si uid undefined', async () => {
    await expect(updateHandoffStatus(undefined, 'h1', 'active')).rejects.toThrow('uid requerido');
  });
  test('lanza si handoffId undefined', async () => {
    await expect(updateHandoffStatus(UID, undefined, 'active')).rejects.toThrow('handoffId requerido');
  });
  test('lanza si status invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateHandoffStatus(UID, 'h1', 'invalido')).rejects.toThrow('status invalido');
  });
  test('actualiza sin error para status valido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateHandoffStatus(UID, 'h1', 'active')).resolves.toBeUndefined();
  });
  test('resolved agrega resolvedAt', async () => {
    let savedUpdate = null;
    __setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
        set: async (data) => { savedUpdate = data; },
      })})})}),
    });
    await updateHandoffStatus(UID, 'h1', 'resolved', { notes: 'OK' });
    expect(savedUpdate.resolvedAt).toBeDefined();
    expect(savedUpdate.resolutionNotes).toBe('OK');
  });
});

describe('getActiveHandoffs', () => {
  test('lanza si uid undefined', async () => {
    await expect(getActiveHandoffs(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay activos', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getActiveHandoffs(UID);
    expect(r).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getActiveHandoffs(UID);
    expect(r).toEqual([]);
  });
});

describe('getHandoffsByPhone', () => {
  test('lanza si uid undefined', async () => {
    await expect(getHandoffsByPhone(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(getHandoffsByPhone(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('retorna array vacio si no hay handoffs', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getHandoffsByPhone(UID, PHONE);
    expect(r).toEqual([]);
  });
  test('fail-open si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getHandoffsByPhone(UID, PHONE);
    expect(r).toEqual([]);
  });
});

describe('isHandoffExpired', () => {
  test('retorna false si no hay record', () => {
    expect(isHandoffExpired(null)).toBe(false);
  });
  test('retorna false si no hay expiresAt', () => {
    expect(isHandoffExpired({ status: 'pending' })).toBe(false);
  });
  test('retorna true si expiresAt es pasado', () => {
    const record = { expiresAt: new Date(Date.now() - 1000).toISOString() };
    expect(isHandoffExpired(record)).toBe(true);
  });
  test('retorna false si expiresAt es futuro', () => {
    const record = { expiresAt: new Date(Date.now() + 60000).toISOString() };
    expect(isHandoffExpired(record)).toBe(false);
  });
  test('acepta nowMs personalizado', () => {
    const past = new Date('2020-01-01').toISOString();
    const nowMs = new Date('2021-01-01').getTime();
    expect(isHandoffExpired({ expiresAt: past }, nowMs)).toBe(true);
  });
});

describe('timeoutExpiredHandoffs', () => {
  test('lanza si uid undefined', async () => {
    await expect(timeoutExpiredHandoffs(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna 0 si no hay handoffs activos', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await timeoutExpiredHandoffs(UID, Date.now());
    expect(r.timedOut).toBe(0);
  });
});

describe('buildHandoffNotificationText', () => {
  test('incluye phone y razon conocida', () => {
    const txt = buildHandoffNotificationText('+54111', 'complaint');
    expect(txt).toContain('+54111');
    expect(txt).toContain('reclamo');
  });
  test('incluye razon desconocida tal cual', () => {
    const txt = buildHandoffNotificationText('+54111', 'unknown_reason');
    expect(txt).toContain('unknown_reason');
  });
});
