'use strict';

const {
  getEvents, createEvent, proposeAvailableSlots, scheduleReminder, getDueReminders,
  DEFAULT_SLOT_DURATION_MINS, REMINDER_OFFSET_MINS,
  __setHttpClientForTests, __setFirestoreForTests,
} = require('../core/calendar_v2');

const UID = 'testUid1234567890';
const CAL_ID = 'primary';
const TOKEN = 'fake_token';
const NOW = new Date('2026-05-04T14:00:00.000Z').getTime();

function makeMockHttp({ items = [], eventId = 'ev123', throwErr = null } = {}) {
  return {
    request: async (url, opts) => {
      if (throwErr) throw new Error(throwErr);
      if (opts.method === 'GET') return { items };
      return { id: eventId };
    },
  };
}

function makeMockDb({ docs = [], throwGet = false, throwSet = false } = {}) {
  return {
    collection: () => ({ doc: () => ({ collection: () => ({
      doc: () => ({ set: async () => { if (throwSet) throw new Error('set error'); } }),
      where: () => ({
        get: async () => {
          if (throwGet) throw new Error('get error');
          const items = docs.map((d, i) => ({ id: d.id || 'r' + i, data: () => d }));
          return { forEach: fn => items.forEach(fn) };
        },
      }),
    })})})
  };
}

beforeEach(() => { __setHttpClientForTests(null); __setFirestoreForTests(null); });
afterEach(() => { __setHttpClientForTests(null); __setFirestoreForTests(null); });

describe('constants', () => {
  test('DEFAULT_SLOT_DURATION_MINS es 30', () => { expect(DEFAULT_SLOT_DURATION_MINS).toBe(30); });
  test('REMINDER_OFFSET_MINS es 60', () => { expect(REMINDER_OFFSET_MINS).toBe(60); });
});

describe('getEvents', () => {
  test('lanza si uid undefined', async () => {
    await expect(getEvents(undefined, CAL_ID, TOKEN, 'a', 'b')).rejects.toThrow('uid requerido');
  });
  test('retorna array de eventos', async () => {
    const gcItems = [
      { id: 'ev1', summary: 'Reunion', start: { dateTime: '2026-05-04T10:00:00Z' }, end: { dateTime: '2026-05-04T11:00:00Z' } },
    ];
    __setHttpClientForTests(makeMockHttp({ items: gcItems }));
    const r = await getEvents(UID, CAL_ID, TOKEN, 'a', 'b');
    expect(r.length).toBe(1);
    expect(r[0].title).toBe('Reunion');
  });
  test('retorna array vacio si no hay eventos', async () => {
    __setHttpClientForTests(makeMockHttp({ items: [] }));
    expect(await getEvents(UID, CAL_ID, TOKEN, 'a', 'b')).toEqual([]);
  });
  test('propaga error HTTP', async () => {
    __setHttpClientForTests(makeMockHttp({ throwErr: 'net error' }));
    await expect(getEvents(UID, CAL_ID, TOKEN, 'a', 'b')).rejects.toThrow('net error');
  });
});

describe('createEvent', () => {
  const ev = { title: 'Turno', start: '2026-05-04T10:00:00Z', end: '2026-05-04T11:00:00Z' };
  test('lanza si event.title undefined', async () => {
    await expect(createEvent(UID, CAL_ID, TOKEN, { start: 'a', end: 'b' })).rejects.toThrow('title');
  });
  test('retorna evento con calendarEventId', async () => {
    __setHttpClientForTests(makeMockHttp({ eventId: 'new_ev' }));
    const r = await createEvent(UID, CAL_ID, TOKEN, ev);
    expect(r.calendarEventId).toBe('new_ev');
    expect(r.title).toBe('Turno');
  });
});

describe('proposeAvailableSlots', () => {
  test('lanza si events no es array', () => {
    expect(() => proposeAvailableSlots('nope', '2026-05-04')).toThrow('debe ser array');
  });
  test('lanza si date invalida', () => {
    expect(() => proposeAvailableSlots([], '04-05-2026')).toThrow('invalida');
  });
  test('genera 18 slots de 30min de 9 a 18', () => {
    const slots = proposeAvailableSlots([], '2026-05-04');
    expect(slots.length).toBe(18);
    expect(slots[0].start).toBe('2026-05-04T09:00:00');
    expect(slots.every(s => s.available)).toBe(true);
  });
  test('marca conflicto correctamente', () => {
    const events = [{ start: '2026-05-04T10:00:00', end: '2026-05-04T11:00:00', allDay: false }];
    const slots = proposeAvailableSlots(events, '2026-05-04');
    const s1000 = slots.find(s => s.start.includes('T10:00'));
    expect(s1000.available).toBe(false);
  });
  test('slots sin conflicto siguen disponibles', () => {
    const events = [{ start: '2026-05-04T10:00:00', end: '2026-05-04T11:00:00', allDay: false }];
    const slots = proposeAvailableSlots(events, '2026-05-04');
    const s0900 = slots.find(s => s.start.includes('T09:00'));
    expect(s0900.available).toBe(true);
  });
  test('ignora eventos allDay', () => {
    const events = [{ start: '2026-05-04', end: '2026-05-04', allDay: true }];
    expect(proposeAvailableSlots(events, '2026-05-04').every(s => s.available)).toBe(true);
  });
});

describe('scheduleReminder', () => {
  const event = { id: 'ev1', title: 'Turno', start: '2026-05-04T11:00:00.000Z', phone: '+541155667788' };
  test('lanza si uid undefined', async () => {
    await expect(scheduleReminder(undefined, event)).rejects.toThrow('uid requerido');
  });
  test('lanza si event.phone undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(scheduleReminder(UID, { id: 'ev1', start: '2026-05-04T11:00:00Z' })).rejects.toThrow('phone');
  });
  test('programa reminder 60min antes', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await scheduleReminder(UID, event);
    const diff = new Date(event.start) - new Date(r.reminderAt);
    expect(diff).toBe(REMINDER_OFFSET_MINS * 60 * 1000);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(scheduleReminder(UID, event)).rejects.toThrow('set error');
  });
});

describe('getDueReminders', () => {
  test('lanza si uid undefined', async () => {
    await expect(getDueReminders(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna solo reminders due', async () => {
    const docs = [
      { id: 'r1', reminderAt: '2026-05-04T13:00:00Z', sent: false },
      { id: 'r2', reminderAt: '2026-05-04T15:00:00Z', sent: false },
    ];
    __setFirestoreForTests(makeMockDb({ docs }));
    const r = await getDueReminders(UID, NOW);
    expect(r.length).toBe(1);
    expect(r[0].reminderAt).toBe('2026-05-04T13:00:00Z');
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getDueReminders(UID)).toEqual([]);
  });
});
