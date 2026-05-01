'use strict';

const {
  buildAppointmentRecord, saveAppointment,
  getAppointmentsForDate, getAppointmentsByPhone,
  checkConflict, updateAppointmentStatus,
  buildAvailableSlots, buildAppointmentText, buildAvailabilityText,
  isValidStatus, isValidType, isValidDatetime, datetimeToMs,
  APPOINTMENT_STATUSES, APPOINTMENT_TYPES,
  SLOT_DURATION_MIN_DEFAULT, MAX_APPOINTMENTS_PER_DAY,
  __setFirestoreForTests,
} = require('../core/appointment_engine');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const DT = '2026-05-15T10:00';
const DATE = '2026-05-15';

function makeMockDb({ stored = {}, throwGet = false, throwSet = false } = {}) {
  const db_stored = { ...stored };
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              db_stored[id] = opts && opts.merge ? { ...(db_stored[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { exists: !!db_stored[id], data: () => db_stored[id] };
            },
          }),
          where: (field, op, val) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const entries = Object.values(db_stored).filter(d => d && d[field] === val);
              return { forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return { forEach: fn => Object.values(db_stored).forEach(d => fn({ data: () => d })) };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

describe('Constantes', () => {
  test('APPOINTMENT_STATUSES tiene 6', () => { expect(APPOINTMENT_STATUSES.length).toBe(6); });
  test('frozen APPOINTMENT_STATUSES', () => { expect(() => { APPOINTMENT_STATUSES.push('x'); }).toThrow(); });
  test('APPOINTMENT_TYPES tiene 4', () => { expect(APPOINTMENT_TYPES.length).toBe(4); });
  test('frozen APPOINTMENT_TYPES', () => { expect(() => { APPOINTMENT_TYPES.push('x'); }).toThrow(); });
  test('SLOT_DURATION_MIN_DEFAULT es 30', () => { expect(SLOT_DURATION_MIN_DEFAULT).toBe(30); });
  test('MAX_APPOINTMENTS_PER_DAY es 20', () => { expect(MAX_APPOINTMENTS_PER_DAY).toBe(20); });
});

describe('isValidStatus / isValidType / isValidDatetime', () => {
  test('pending es status valido', () => { expect(isValidStatus('pending')).toBe(true); });
  test('no_show es status valido', () => { expect(isValidStatus('no_show')).toBe(true); });
  test('bad_status invalido', () => { expect(isValidStatus('bad')).toBe(false); });
  test('in_person es type valido', () => { expect(isValidType('in_person')).toBe(true); });
  test('zoom invalido', () => { expect(isValidType('zoom')).toBe(false); });
  test('formato correcto valido', () => { expect(isValidDatetime('2026-05-15T10:00')).toBe(true); });
  test('formato incorrecto invalido', () => { expect(isValidDatetime('2026-05-15 10:00')).toBe(false); });
  test('null invalido', () => { expect(isValidDatetime(null)).toBe(false); });
  test('sin hora invalido', () => { expect(isValidDatetime('2026-05-15')).toBe(false); });
});

describe('datetimeToMs', () => {
  test('convierte a ms correctamente', () => {
    const ms = datetimeToMs('2026-05-15T10:00');
    expect(typeof ms).toBe('number');
    expect(ms).toBeGreaterThan(0);
  });
  test('null retorna null', () => {
    expect(datetimeToMs(null)).toBeNull();
  });
  test('formato invalido retorna null', () => {
    expect(datetimeToMs('2026-13-45T25:70')).toBeNull();
  });
});

describe('buildAppointmentRecord', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildAppointmentRecord(undefined, PHONE, DT)).toThrow('uid requerido');
  });
  test('lanza si phone undefined', () => {
    expect(() => buildAppointmentRecord(UID, undefined, DT)).toThrow('phone requerido');
  });
  test('lanza si datetime invalido', () => {
    expect(() => buildAppointmentRecord(UID, PHONE, '2026-05-15 10:00')).toThrow('datetime invalido');
  });
  test('construye record correctamente', () => {
    const r = buildAppointmentRecord(UID, PHONE, DT);
    expect(r.uid).toBe(UID);
    expect(r.phone).toBe(PHONE);
    expect(r.datetime).toBe(DT);
    expect(r.date).toBe(DATE);
    expect(r.status).toBe('pending');
    expect(r.type).toBe('in_person');
    expect(r.durationMin).toBe(SLOT_DURATION_MIN_DEFAULT);
    expect(typeof r.timestampMs).toBe('number');
    expect(r.endsAtMs).toBe(r.timestampMs + 30 * 60 * 1000);
  });
  test('acepta type remoto', () => {
    const r = buildAppointmentRecord(UID, PHONE, DT, { type: 'remote' });
    expect(r.type).toBe('remote');
  });
  test('type invalido cae a in_person', () => {
    const r = buildAppointmentRecord(UID, PHONE, DT, { type: 'zoom' });
    expect(r.type).toBe('in_person');
  });
  test('durationMin personalizado', () => {
    const r = buildAppointmentRecord(UID, PHONE, DT, { durationMin: 60 });
    expect(r.durationMin).toBe(60);
    expect(r.endsAtMs).toBe(r.timestampMs + 60 * 60 * 1000);
  });
  test('acepta price y currency', () => {
    const r = buildAppointmentRecord(UID, PHONE, DT, { price: 500, currency: 'ARS' });
    expect(r.price).toBe(500);
    expect(r.currency).toBe('ARS');
  });
  test('acepta location y notes', () => {
    const r = buildAppointmentRecord(UID, PHONE, DT, { location: 'Av. Cordoba 1234', notes: 'Traer DNI' });
    expect(r.location).toBe('Av. Cordoba 1234');
    expect(r.notes).toBe('Traer DNI');
  });
});

describe('saveAppointment', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveAppointment(undefined, { appointmentId: 'x' })).rejects.toThrow('uid requerido');
  });
  test('lanza si record invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveAppointment(UID, null)).rejects.toThrow('record invalido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = buildAppointmentRecord(UID, PHONE, DT);
    const id = await saveAppointment(UID, r);
    expect(id).toBe(r.appointmentId);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const r = buildAppointmentRecord(UID, PHONE, DT);
    await expect(saveAppointment(UID, r)).rejects.toThrow('set error');
  });
});

describe('getAppointmentsForDate', () => {
  test('lanza si uid undefined', async () => {
    await expect(getAppointmentsForDate(undefined, DATE)).rejects.toThrow('uid requerido');
  });
  test('lanza si date undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getAppointmentsForDate(UID, undefined)).rejects.toThrow('date requerido');
  });
  test('retorna vacio si no hay turnos', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getAppointmentsForDate(UID, DATE)).toEqual([]);
  });
  test('retorna turnos del dia ordenados', async () => {
    const r1 = buildAppointmentRecord(UID, PHONE, '2026-05-15T11:00');
    const r2 = buildAppointmentRecord(UID, '+5411999', '2026-05-15T09:00');
    __setFirestoreForTests(makeMockDb({ stored: { [r1.appointmentId]: r1, [r2.appointmentId]: r2 } }));
    const appts = await getAppointmentsForDate(UID, DATE);
    expect(appts.length).toBe(2);
    expect(appts[0].datetime).toBe('2026-05-15T09:00');
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getAppointmentsForDate(UID, DATE)).toEqual([]);
  });
});

describe('getAppointmentsByPhone', () => {
  test('lanza si uid undefined', async () => {
    await expect(getAppointmentsByPhone(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getAppointmentsByPhone(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('retorna turnos del contacto', async () => {
    const r1 = buildAppointmentRecord(UID, PHONE, '2026-05-15T10:00');
    const r2 = buildAppointmentRecord(UID, PHONE, '2026-05-20T14:00');
    const r3 = buildAppointmentRecord(UID, '+5411999', '2026-05-15T11:00');
    __setFirestoreForTests(makeMockDb({ stored: { [r1.appointmentId]: r1, [r2.appointmentId]: r2, [r3.appointmentId]: r3 } }));
    const appts = await getAppointmentsByPhone(UID, PHONE);
    expect(appts.length).toBe(2);
    appts.forEach(a => expect(a.phone).toBe(PHONE));
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getAppointmentsByPhone(UID, PHONE)).toEqual([]);
  });
});

describe('checkConflict', () => {
  test('sin turnos existentes retorna null', () => {
    const r = buildAppointmentRecord(UID, PHONE, DT);
    expect(checkConflict(r, [])).toBeNull();
  });
  test('null existentes retorna null', () => {
    const r = buildAppointmentRecord(UID, PHONE, DT);
    expect(checkConflict(r, null)).toBeNull();
  });
  test('detecta conflicto con turno solapado', () => {
    const existing = buildAppointmentRecord(UID, '+5411', '2026-05-15T10:00');
    const newAppt = buildAppointmentRecord(UID, PHONE, '2026-05-15T10:15');
    const conflict = checkConflict(newAppt, [existing]);
    expect(conflict).not.toBeNull();
    expect(conflict.conflict).toBe(true);
  });
  test('no detecta conflicto si turnos no se solapan', () => {
    const existing = buildAppointmentRecord(UID, '+5411', '2026-05-15T10:00');
    const newAppt = buildAppointmentRecord(UID, PHONE, '2026-05-15T11:00');
    expect(checkConflict(newAppt, [existing])).toBeNull();
  });
  test('ignorar turnos cancelados en check conflicto', () => {
    const existing = { ...buildAppointmentRecord(UID, '+5411', '2026-05-15T10:00'), status: 'cancelled' };
    const newAppt = buildAppointmentRecord(UID, PHONE, '2026-05-15T10:15');
    expect(checkConflict(newAppt, [existing])).toBeNull();
  });
});

describe('updateAppointmentStatus', () => {
  test('lanza si uid undefined', async () => {
    await expect(updateAppointmentStatus(undefined, 'id', 'confirmed')).rejects.toThrow('uid requerido');
  });
  test('lanza si appointmentId undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateAppointmentStatus(UID, undefined, 'confirmed')).rejects.toThrow('appointmentId requerido');
  });
  test('lanza si status invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateAppointmentStatus(UID, 'appt_001', 'bad_status')).rejects.toThrow('status invalido');
  });
  test('actualiza a confirmed sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const id = await updateAppointmentStatus(UID, 'appt_001', 'confirmed');
    expect(id).toBe('appt_001');
  });
  test('actualiza a cancelled con razon', async () => {
    __setFirestoreForTests(makeMockDb());
    const id = await updateAppointmentStatus(UID, 'appt_001', 'cancelled', { cancelReason: 'No puede asistir' });
    expect(id).toBe('appt_001');
  });
});

describe('buildAvailableSlots', () => {
  test('sin turnos genera slots de 9 a 18', () => {
    const slots = buildAvailableSlots(DATE, []);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].datetime).toContain('09:00');
  });
  test('slot ocupado no aparece', () => {
    const existing = buildAppointmentRecord(UID, PHONE, '2026-05-15T09:00');
    const slots = buildAvailableSlots(DATE, [existing]);
    const slot9 = slots.find(s => s.datetime.includes('09:00'));
    expect(slot9).toBeUndefined();
  });
  test('turno cancelado no bloquea slot', () => {
    const existing = { ...buildAppointmentRecord(UID, PHONE, '2026-05-15T09:00'), status: 'cancelled' };
    const slots = buildAvailableSlots(DATE, [existing]);
    const slot9 = slots.find(s => s.datetime.includes('09:00'));
    expect(slot9).toBeDefined();
  });
  test('hora de fin personalizada', () => {
    const slots = buildAvailableSlots(DATE, [], { workStartHour: 9, workEndHour: 10 });
    expect(slots.length).toBeLessThanOrEqual(2);
  });
  test('cada slot tiene timestampMs', () => {
    const slots = buildAvailableSlots(DATE, []);
    slots.forEach(s => expect(typeof s.timestampMs).toBe('number'));
  });
});

describe('buildAppointmentText', () => {
  test('retorna vacio si null', () => { expect(buildAppointmentText(null)).toBe(''); });
  test('incluye datetime y phone', () => {
    const r = buildAppointmentRecord(UID, PHONE, DT);
    const text = buildAppointmentText(r);
    expect(text).toContain(DT);
    expect(text).toContain(PHONE);
  });
  test('incluye location si hay', () => {
    const r = buildAppointmentRecord(UID, PHONE, DT, { location: 'Av. Cordoba 1234' });
    const text = buildAppointmentText(r);
    expect(text).toContain('Av. Cordoba 1234');
  });
  test('incluye precio si hay', () => {
    const r = buildAppointmentRecord(UID, PHONE, DT, { price: 500, currency: 'ARS' });
    const text = buildAppointmentText(r);
    expect(text).toContain('500');
    expect(text).toContain('ARS');
  });
});

describe('buildAvailabilityText', () => {
  test('sin slots retorna no disponible', () => {
    const text = buildAvailabilityText(DATE, []);
    expect(text).toContain('No hay');
    expect(text).toContain(DATE);
  });
  test('con slots lista horarios', () => {
    const slots = buildAvailableSlots(DATE, []);
    const text = buildAvailabilityText(DATE, slots);
    expect(text).toContain(DATE);
    expect(text).toContain('09:00');
  });
  test('muestra max 10 y agrega etc', () => {
    const slots = buildAvailableSlots(DATE, [], { workStartHour: 8, workEndHour: 20, durationMin: 15 });
    const text = buildAvailabilityText(DATE, slots);
    if (slots.length > 10) expect(text).toContain('mas');
  });
});
