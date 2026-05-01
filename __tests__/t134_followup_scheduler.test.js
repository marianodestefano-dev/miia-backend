'use strict';
const { scheduleFollowup, cancelFollowup, getPendingFollowups, isBlockedCountry, FOLLOWUP_TYPES, FOLLOWUP_DELAYS_MS, __setFirestoreForTests } = require('../core/followup_scheduler');

const UID = 'followupTestUid1234567890';
const NOW = Date.now();

function makeMockDb({ throwSet = false, throwGet = false } = {}) {
  const store = {};
  return {
    collection: () => ({ doc: () => ({ collection: () => ({
      doc: (id) => ({
        set: async (data, opts) => {
          if (throwSet) throw new Error('set failed');
          store[id] = opts && opts.merge ? { ...(store[id] || {}), ...data } : data;
        }
      }),
      get: async () => {
        if (throwGet) throw new Error('get failed');
        return { docs: Object.values(store).map(v => ({ data: () => v })) };
      }
    }) }) })
  };
}

afterEach(() => __setFirestoreForTests(null));

describe('FOLLOWUP_TYPES y FOLLOWUP_DELAYS_MS', () => {
  test('tipos validos', () => {
    expect(FOLLOWUP_TYPES).toContain('first_contact');
    expect(FOLLOWUP_TYPES).toContain('reminder_3d');
    expect(FOLLOWUP_TYPES).toContain('final_30d');
  });
  test('delays correctos', () => {
    expect(FOLLOWUP_DELAYS_MS.first_contact).toBe(0);
    expect(FOLLOWUP_DELAYS_MS.reminder_3d).toBe(3 * 24 * 60 * 60 * 1000);
    expect(FOLLOWUP_DELAYS_MS.final_30d).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('isBlockedCountry', () => {
  test('numero US bloqueado', () => {
    expect(isBlockedCountry('+12125551234')).toBe(true);
    expect(isBlockedCountry('12125551234')).toBe(true);
  });
  test('numero Colombia no bloqueado', () => {
    expect(isBlockedCountry('+573001234567')).toBe(false);
  });
  test('numero Argentina no bloqueado', () => {
    expect(isBlockedCountry('+5491155551234')).toBe(false);
  });
  test('null no bloqueado', () => {
    expect(isBlockedCountry(null)).toBe(false);
  });
});

describe('scheduleFollowup — validacion', () => {
  beforeEach(() => { __setFirestoreForTests(makeMockDb()); });

  test('lanza si uid falta', async () => {
    await expect(scheduleFollowup(null, '+1234', 'first_contact')).rejects.toThrow('uid requerido');
  });
  test('lanza si phone falta', async () => {
    await expect(scheduleFollowup(UID, '', 'first_contact')).rejects.toThrow('phone requerido');
  });
  test('lanza si type invalido', async () => {
    await expect(scheduleFollowup(UID, '+573001234567', 'invalid_type')).rejects.toThrow('type invalido');
  });
});

describe('scheduleFollowup — US bloqueado (Regla 6.27)', () => {
  beforeEach(() => { __setFirestoreForTests(makeMockDb()); });

  test('numero US retorna blocked=true sin guardar', async () => {
    const r = await scheduleFollowup(UID, '+12125551234', 'reminder_3d');
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('US_POLICY');
    expect(r.followupId).toBeNull();
  });
});

describe('scheduleFollowup — exito', () => {
  beforeEach(() => { __setFirestoreForTests(makeMockDb()); });

  test('retorna followupId, scheduledAt, type', async () => {
    const r = await scheduleFollowup(UID, '+573001234567', 'reminder_3d', { _nowMs: NOW });
    expect(typeof r.followupId).toBe('string');
    expect(r.followupId.startsWith('fu_')).toBe(true);
    expect(typeof r.scheduledAt).toBe('string');
    expect(r.type).toBe('reminder_3d');
  });
  test('scheduledAt correcto para reminder_3d', async () => {
    const r = await scheduleFollowup(UID, '+573001234567', 'reminder_3d', { _nowMs: NOW });
    const scheduled = new Date(r.scheduledAt).getTime();
    const expected = NOW + FOLLOWUP_DELAYS_MS.reminder_3d;
    expect(Math.abs(scheduled - expected)).toBeLessThan(1000);
  });
  test('lanza si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(scheduleFollowup(UID, '+573001234567', 'first_contact')).rejects.toThrow('set failed');
  });
});

describe('cancelFollowup y getPendingFollowups', () => {
  test('cancelFollowup lanza si uid falta', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(cancelFollowup(null, 'fu_1')).rejects.toThrow('uid requerido');
  });
  test('getPendingFollowups retorna [] si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getPendingFollowups(UID);
    expect(r).toEqual([]);
  });
  test('getPendingFollowups filtra solo pending', async () => {
    const mock = makeMockDb();
    __setFirestoreForTests(mock);
    await scheduleFollowup(UID, '+573001234567', 'first_contact');
    const pending = await getPendingFollowups(UID);
    expect(pending.every(f => f.status === 'pending')).toBe(true);
  });
});
