'use strict';

const {
  scheduleNotification, getPendingNotifications, markAsSent,
  filterDueNotifications, getNotificationMessage,
  DEFAULT_MESSAGE_ES, DEFAULT_MESSAGE_EN,
  __setFirestoreForTests,
} = require('../core/availability_notifier');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const NEXT_OPEN = '2026-05-04T09:00';

function makePendingDoc(overrides = {}) {
  return { uid: UID, phone: PHONE, nextOpenAt: NEXT_OPEN, message: DEFAULT_MESSAGE_ES, sent: false, sentAt: null, ...overrides };
}

function makeMockDb({ docs = [], throwGet = false, throwSet = false } = {}) {
  const docsMap = {};
  docs.forEach(d => { docsMap[d.id || 'doc1'] = d; });
  return {
    collection: () => ({ doc: () => ({ collection: () => ({
      doc: () => ({
        set: async (data, opts) => { if (throwSet) throw new Error('set error'); },
      }),
      where: () => ({
        get: async () => {
          if (throwGet) throw new Error('get error');
          const items = Object.entries(docsMap).map(([id, data]) => ({ id, data: () => data }));
          return { forEach: fn => items.forEach(fn) };
        },
      }),
    })})})
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('scheduleNotification - validacion', () => {
  test('lanza si uid undefined', async () => {
    await expect(scheduleNotification(undefined, PHONE, NEXT_OPEN)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(scheduleNotification(UID, undefined, NEXT_OPEN)).rejects.toThrow('phone requerido');
  });
  test('lanza si nextOpenAt undefined', async () => {
    await expect(scheduleNotification(UID, PHONE, undefined)).rejects.toThrow('nextOpenAt requerido');
  });
});

describe('scheduleNotification - resultado', () => {
  test('retorna notificationId y scheduledFor', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await scheduleNotification(UID, PHONE, NEXT_OPEN);
    expect(r.notificationId).toBeDefined();
    expect(r.scheduledFor).toBe(NEXT_OPEN);
  });
  test('usa customMessage si se provee', async () => {
    __setFirestoreForTests(makeMockDb());
    let savedData = null;
    __setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
        set: async (data) => { savedData = data; },
      })})})})
    });
    await scheduleNotification(UID, PHONE, NEXT_OPEN, { customMessage: 'Hola custom!' });
    expect(savedData.message).toBe('Hola custom!');
  });
  test('propaga error si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(scheduleNotification(UID, PHONE, NEXT_OPEN)).rejects.toThrow('set error');
  });
});

describe('getPendingNotifications', () => {
  test('lanza si uid undefined', async () => {
    await expect(getPendingNotifications(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay pendientes', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getPendingNotifications(UID);
    expect(r).toEqual([]);
  });
  test('retorna notificaciones pendientes', async () => {
    const doc = { id: 'notif1', ...makePendingDoc() };
    __setFirestoreForTests(makeMockDb({ docs: [doc] }));
    const r = await getPendingNotifications(UID);
    expect(r.length).toBe(1);
    expect(r[0].phone).toBe(PHONE);
  });
  test('fail-open retorna array vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getPendingNotifications(UID);
    expect(r).toEqual([]);
  });
});

describe('markAsSent', () => {
  test('lanza si uid undefined', async () => {
    await expect(markAsSent(undefined, 'notif1')).rejects.toThrow('uid requerido');
  });
  test('lanza si notificationId undefined', async () => {
    await expect(markAsSent(UID, undefined)).rejects.toThrow('notificationId requerido');
  });
  test('marca sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(markAsSent(UID, 'notif1')).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(markAsSent(UID, 'notif1')).rejects.toThrow('set error');
  });
});

describe('filterDueNotifications', () => {
  test('lanza si pending no es array', () => {
    expect(() => filterDueNotifications('no array')).toThrow('debe ser array');
  });
  test('retorna notificaciones cuyo nextOpenAt <= ahora', () => {
    const nowMs = new Date('2026-05-04T10:00:00Z').getTime();
    const pending = [
      { nextOpenAt: '2026-05-04T09:00', phone: '+1' },
      { nextOpenAt: '2026-05-04T11:00', phone: '+2' },
    ];
    const due = filterDueNotifications(pending, nowMs);
    expect(due.length).toBe(1);
    expect(due[0].phone).toBe('+1');
  });
  test('retorna vacio si ninguna es due', () => {
    const nowMs = new Date('2026-05-04T08:00:00Z').getTime();
    const pending = [{ nextOpenAt: '2026-05-04T09:00', phone: '+1' }];
    expect(filterDueNotifications(pending, nowMs)).toEqual([]);
  });
  test('ignora notificaciones sin nextOpenAt', () => {
    const pending = [{ phone: '+1' }, { nextOpenAt: '2026-05-04T09:00', phone: '+2' }];
    const nowMs = new Date('2026-05-04T10:00:00Z').getTime();
    const due = filterDueNotifications(pending, nowMs);
    expect(due.length).toBe(1);
  });
});

describe('getNotificationMessage', () => {
  test('retorna mensaje en espanol por default', () => {
    expect(getNotificationMessage()).toBe(DEFAULT_MESSAGE_ES);
    expect(getNotificationMessage('es')).toBe(DEFAULT_MESSAGE_ES);
  });
  test('retorna mensaje en ingles', () => {
    expect(getNotificationMessage('en')).toBe(DEFAULT_MESSAGE_EN);
  });
  test('fallback a espanol para idioma desconocido', () => {
    expect(getNotificationMessage('fr')).toBe(DEFAULT_MESSAGE_ES);
  });
});
