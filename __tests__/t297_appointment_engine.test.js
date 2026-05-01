'use strict';

/**
 * T297 -- appointment_engine unit tests (40/40)
 */

const {
  buildAppointmentRecord,
  saveAppointment,
  getAppointmentsForDate,
  getAppointmentsByPhone,
  checkConflict,
  updateAppointmentStatus,
  buildAvailableSlots,
  buildAppointmentText,
  buildAvailabilityText,
  isValidStatus,
  isValidType,
  isValidDatetime,
  datetimeToMs,
  APPOINTMENT_STATUSES,
  APPOINTMENT_TYPES,
  SLOT_DURATION_MIN_DEFAULT,
  MAX_APPOINTMENTS_PER_DAY,
  __setFirestoreForTests,
} = require('../core/appointment_engine');

function makeMockDb() {
  const store = {};
  return {
    store,
    db: {
      collection: () => ({
        doc: (uid) => ({
          collection: (subCol) => ({
            doc: (id) => ({
              set: async (data, opts) => {
                if (!store[uid]) store[uid] = {};
                if (!store[uid][subCol]) store[uid][subCol] = {};
                if (opts && opts.merge) {
                  store[uid][subCol][id] = { ...(store[uid][subCol][id] || {}), ...data };
                } else {
                  store[uid][subCol][id] = { ...data };
                }
              },
              get: async () => {
                const rec = store[uid] && store[uid][subCol] && store[uid][subCol][id];
                return { exists: !!rec, data: () => rec };
              },
            }),
            where: (field, op, val) => {
              const chain = { filters: [[field, op, val]] };
              chain.where = (f2, op2, v2) => { chain.filters.push([f2, op2, v2]); return chain; };
              chain.get = async () => {
                const all = Object.values((store[uid] || {})[subCol] || {});
                const filtered = all.filter(r => chain.filters.every(([f, o, v]) => {
                  if (o === '==') return r[f] === v;
                  return true;
                }));
                return {
                  empty: filtered.length === 0,
                  forEach: (fn) => filtered.forEach(d => fn({ data: () => d })),
                };
              };
              return chain;
            },
            get: async () => {
              const all = Object.values((store[uid] || {})[subCol] || {});
              return {
                empty: all.length === 0,
                forEach: (fn) => all.forEach(d => fn({ data: () => d })),
              };
            },
          }),
        }),
      }),
    },
  };
}

const UID = 'owner_t297_001';
const PHONE = '+541155550001';
const DT = '2026-06-15T10:00';
const DATE = '2026-06-15';

describe('T297 -- appointment_engine (40 tests)', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    __setFirestoreForTests(mock.db);
  });

  // isValidDatetime

  test('isValidDatetime: formato correcto YYYY-MM-DDTHH:MM', () => {
    expect(isValidDatetime('2026-06-15T10:00')).toBe(true);
    expect(isValidDatetime('2026-12-31T23:59')).toBe(true);
  });

  test('isValidDatetime: null y undefined retornan false', () => {
    expect(isValidDatetime(null)).toBe(false);
    expect(isValidDatetime(undefined)).toBe(false);
    expect(isValidDatetime('')).toBe(false);
  });

  test('isValidDatetime: formatos incorrectos retornan false', () => {
    expect(isValidDatetime('2026-06-15')).toBe(false);
    expect(isValidDatetime('10:00')).toBe(false);
    expect(isValidDatetime('2026-06-15 10:00')).toBe(false);
  });

  test('datetimeToMs: retorna timestamp numerico correcto', () => {
    const ts = datetimeToMs('2026-06-15T09:00');
    expect(typeof ts).toBe('number');
    expect(ts).toBeGreaterThan(0);
    const expected = new Date('2026-06-15T09:00:00.000Z').getTime();
    expect(ts).toBe(expected);
  });

  test('datetimeToMs: retorna null para formato invalido', () => {
    expect(datetimeToMs('fecha-mala')).toBe(null);
    expect(datetimeToMs(null)).toBe(null);
  });

  // buildAppointmentRecord

  test('buildAppointmentRecord: construye registro con campos obligatorios', () => {
    const rec = buildAppointmentRecord(UID, PHONE, DT);
    expect(rec.uid).toBe(UID);
    expect(rec.phone).toBe(PHONE);
    expect(rec.datetime).toBe(DT);
    expect(rec.date).toBe(DATE);
    expect(rec.status).toBe('pending');
    expect(typeof rec.timestampMs).toBe('number');
    expect(typeof rec.endsAtMs).toBe('number');
  });

  test('buildAppointmentRecord: lanza error si uid falta', () => {
    expect(() => buildAppointmentRecord('', PHONE, DT)).toThrow('uid requerido');
  });

  test('buildAppointmentRecord: lanza error si phone falta', () => {
    expect(() => buildAppointmentRecord(UID, '', DT)).toThrow('phone requerido');
  });

  test('buildAppointmentRecord: lanza error si datetime invalido', () => {
    expect(() => buildAppointmentRecord(UID, PHONE, '15/06/2026 10:00')).toThrow('datetime invalido');
    expect(() => buildAppointmentRecord(UID, PHONE, null)).toThrow('datetime invalido');
  });

  test('buildAppointmentRecord: tipo por defecto es in_person', () => {
    const rec = buildAppointmentRecord(UID, PHONE, DT);
    expect(rec.type).toBe('in_person');
  });

  test('buildAppointmentRecord: durationMin default es SLOT_DURATION_MIN_DEFAULT', () => {
    const rec = buildAppointmentRecord(UID, PHONE, DT);
    expect(rec.durationMin).toBe(SLOT_DURATION_MIN_DEFAULT);
    expect(rec.durationMin).toBe(30);
  });

  test('buildAppointmentRecord: tipo remote con opts.type', () => {
    const rec = buildAppointmentRecord(UID, PHONE, DT, { type: 'remote' });
    expect(rec.type).toBe('remote');
  });

  test('buildAppointmentRecord: opts contactName, notes, price, location, durationMin', () => {
    const rec = buildAppointmentRecord(UID, PHONE, DT, {
      contactName: 'Ana Martinez',
      notes: 'Traer historial',
      price: 3500,
      currency: 'ARS',
      location: 'Consultorio 2',
      durationMin: 60,
    });
    expect(rec.contactName).toBe('Ana Martinez');
    expect(rec.notes).toBe('Traer historial');
    expect(rec.price).toBe(3500);
    expect(rec.currency).toBe('ARS');
    expect(rec.location).toBe('Consultorio 2');
    expect(rec.durationMin).toBe(60);
    expect(rec.endsAtMs).toBe(rec.timestampMs + 60 * 60 * 1000);
  });

  test('buildAppointmentRecord: endsAtMs = timestampMs + durationMin * 60000', () => {
    const rec = buildAppointmentRecord(UID, PHONE, DT, { durationMin: 45 });
    expect(rec.endsAtMs).toBe(rec.timestampMs + 45 * 60 * 1000);
  });

  test('buildAppointmentRecord: appointmentId es determinista (mismo uid+phone+dt)', () => {
    const r1 = buildAppointmentRecord(UID, PHONE, DT);
    const r2 = buildAppointmentRecord(UID, PHONE, DT);
    expect(r1.appointmentId).toBe(r2.appointmentId);
  });

  // checkConflict

  test('checkConflict: retorna null si no hay appointments existentes', () => {
    const rec = buildAppointmentRecord(UID, PHONE, DT);
    expect(checkConflict(rec, [])).toBeNull();
    expect(checkConflict(rec, null)).toBeNull();
  });

  test('checkConflict: detecta conflicto por solapamiento', () => {
    const existing = buildAppointmentRecord(UID, PHONE, '2026-06-15T10:00', { durationMin: 30 });
    const newer = buildAppointmentRecord(UID, '+541155550002', '2026-06-15T10:15', { durationMin: 30 });
    const result = checkConflict(newer, [existing]);
    expect(result).not.toBeNull();
    expect(result.conflict).toBe(true);
    expect(result.conflictWith).toBe(existing.appointmentId);
  });

  test('checkConflict: sin conflicto cuando slots son consecutivos', () => {
    const existing = buildAppointmentRecord(UID, PHONE, '2026-06-15T10:00', { durationMin: 30 });
    const newer = buildAppointmentRecord(UID, '+541155550002', '2026-06-15T10:30', { durationMin: 30 });
    expect(checkConflict(newer, [existing])).toBeNull();
  });

  test('checkConflict: turnos cancelados no generan conflicto', () => {
    const existing = { ...buildAppointmentRecord(UID, PHONE, '2026-06-15T10:00'), status: 'cancelled' };
    const newer = buildAppointmentRecord(UID, '+541155550002', '2026-06-15T10:15', { durationMin: 30 });
    expect(checkConflict(newer, [existing])).toBeNull();
  });

  test('checkConflict: no_show no genera conflicto', () => {
    const existing = { ...buildAppointmentRecord(UID, PHONE, '2026-06-15T10:00'), status: 'no_show' };
    const newer = buildAppointmentRecord(UID, '+541155550002', '2026-06-15T10:15', { durationMin: 30 });
    expect(checkConflict(newer, [existing])).toBeNull();
  });

  // buildAvailableSlots

  test('buildAvailableSlots: genera 4 slots entre 9:00 y 11:00 con 30 min', () => {
    const slots = buildAvailableSlots(DATE, [], { workStartHour: 9, workEndHour: 11, durationMin: 30 });
    expect(slots.length).toBe(4);
    expect(slots[0].datetime).toBe(DATE + 'T09:00');
    expect(slots[3].datetime).toBe(DATE + 'T10:30');
  });

  test('buildAvailableSlots: slot ocupado se excluye', () => {
    const busy = buildAppointmentRecord(UID, PHONE, DATE + 'T09:00', { durationMin: 30 });
    const slots = buildAvailableSlots(DATE, [busy], { workStartHour: 9, workEndHour: 11, durationMin: 30 });
    expect(slots.length).toBe(3);
    expect(slots[0].datetime).toBe(DATE + 'T09:30');
  });

  test('buildAvailableSlots: 3 slots con durationMin 60 entre 9:00 y 12:00', () => {
    const slots = buildAvailableSlots(DATE, [], { workStartHour: 9, workEndHour: 12, durationMin: 60 });
    expect(slots.length).toBe(3);
    expect(slots[1].datetime).toBe(DATE + 'T10:00');
  });

  test('buildAvailableSlots: retorna array vacio si todos ocupados', () => {
    const appts = [
      buildAppointmentRecord(UID, PHONE, DATE + 'T09:00', { durationMin: 60 }),
      buildAppointmentRecord(UID, PHONE, DATE + 'T10:00', { durationMin: 60 }),
    ];
    const slots = buildAvailableSlots(DATE, appts, { workStartHour: 9, workEndHour: 11, durationMin: 60 });
    expect(slots.length).toBe(0);
  });

  test('buildAvailableSlots: cada slot tiene datetime string y timestampMs number', () => {
    const slots = buildAvailableSlots(DATE, [], { workStartHour: 9, workEndHour: 10, durationMin: 30 });
    expect(slots.length).toBeGreaterThan(0);
    expect(typeof slots[0].datetime).toBe('string');
    expect(typeof slots[0].timestampMs).toBe('number');
  });

  // buildAppointmentText

  test('buildAppointmentText: retorna string vacio para null', () => {
    expect(buildAppointmentText(null)).toBe('');
  });

  test('buildAppointmentText: contiene phone y datetime', () => {
    const rec = buildAppointmentRecord(UID, PHONE, DT);
    const text = buildAppointmentText(rec);
    expect(text).toContain(PHONE);
    expect(text).toContain(DT);
  });

  test('buildAppointmentText: incluye location cuando definida', () => {
    const rec = buildAppointmentRecord(UID, PHONE, DT, { location: 'Piso 3 Of 12' });
    const text = buildAppointmentText(rec);
    expect(text).toContain('Piso 3 Of 12');
  });

  test('buildAppointmentText: incluye precio cuando definido', () => {
    const rec = buildAppointmentRecord(UID, PHONE, DT, { price: 5000, currency: 'ARS' });
    const text = buildAppointmentText(rec);
    expect(text).toContain('5000');
  });

  // buildAvailabilityText

  test('buildAvailabilityText: mensaje cuando no hay slots', () => {
    const text = buildAvailabilityText(DATE, []);
    expect(text).toContain('No hay turnos disponibles');
  });

  test('buildAvailabilityText: lista de slots disponibles', () => {
    const slots = buildAvailableSlots(DATE, [], { workStartHour: 9, workEndHour: 10, durationMin: 30 });
    const text = buildAvailabilityText(DATE, slots);
    expect(text).toContain('09:00');
  });

  test('buildAvailabilityText: limita a 10 y muestra mensaje de mas', () => {
    const manySlots = buildAvailableSlots(DATE, [], { workStartHour: 8, workEndHour: 20, durationMin: 30 });
    const text = buildAvailabilityText(DATE, manySlots);
    expect(text).toContain('mas');
  });

  // saveAppointment

  test('saveAppointment: guarda y retorna appointmentId', async () => {
    const rec = buildAppointmentRecord(UID, PHONE, DT);
    const id = await saveAppointment(UID, rec);
    expect(id).toBe(rec.appointmentId);
    const stored = mock.store[UID]['appointments'][rec.appointmentId];
    expect(stored).toBeDefined();
    expect(stored.phone).toBe(PHONE);
  });

  test('saveAppointment: lanza error si uid falta', async () => {
    const rec = buildAppointmentRecord(UID, PHONE, DT);
    await expect(saveAppointment('', rec)).rejects.toThrow('uid requerido');
  });

  test('saveAppointment: lanza error si record invalido (sin appointmentId)', async () => {
    await expect(saveAppointment(UID, {})).rejects.toThrow('record invalido');
  });

  // getAppointmentsForDate

  test('getAppointmentsForDate: retorna turnos del dia ordenados por hora', async () => {
    const r1 = buildAppointmentRecord(UID, PHONE, '2026-06-15T11:00');
    const r2 = buildAppointmentRecord(UID, '+541155550002', '2026-06-15T09:00');
    await saveAppointment(UID, r1);
    await saveAppointment(UID, r2);
    const appts = await getAppointmentsForDate(UID, '2026-06-15');
    expect(appts.length).toBe(2);
    expect(appts[0].timestampMs).toBeLessThan(appts[1].timestampMs);
  });

  test('getAppointmentsForDate: retorna array vacio para fecha sin turnos', async () => {
    const rec = buildAppointmentRecord(UID, PHONE, '2026-06-15T10:00');
    await saveAppointment(UID, rec);
    const appts = await getAppointmentsForDate(UID, '2026-06-20');
    expect(appts).toEqual([]);
  });

  // getAppointmentsByPhone

  test('getAppointmentsByPhone: retorna solo turnos del contacto', async () => {
    const r1 = buildAppointmentRecord(UID, PHONE, '2026-06-15T10:00');
    const r2 = buildAppointmentRecord(UID, PHONE, '2026-06-16T14:00');
    const r3 = buildAppointmentRecord(UID, '+541155550099', '2026-06-15T10:00');
    await saveAppointment(UID, r1);
    await saveAppointment(UID, r2);
    await saveAppointment(UID, r3);
    const appts = await getAppointmentsByPhone(UID, PHONE);
    expect(appts.length).toBe(2);
    appts.forEach(a => expect(a.phone).toBe(PHONE));
  });

  test('getAppointmentsByPhone: retorna array vacio si phone sin turnos', async () => {
    const rec = buildAppointmentRecord(UID, PHONE, DT);
    await saveAppointment(UID, rec);
    const appts = await getAppointmentsByPhone(UID, '+5400000000');
    expect(appts).toEqual([]);
  });

  // updateAppointmentStatus

  test('updateAppointmentStatus: lanza error para status invalido', async () => {
    await expect(updateAppointmentStatus(UID, 'appt_123', 'flying')).rejects.toThrow('status invalido');
  });

  test('updateAppointmentStatus: lanza error si uid falta', async () => {
    await expect(updateAppointmentStatus('', 'appt_123', 'confirmed')).rejects.toThrow('uid requerido');
  });

  test('updateAppointmentStatus: confirmed agrega confirmedAt', async () => {
    const rec = buildAppointmentRecord(UID, PHONE, DT);
    await saveAppointment(UID, rec);
    await updateAppointmentStatus(UID, rec.appointmentId, 'confirmed');
    const stored = mock.store[UID]['appointments'][rec.appointmentId];
    expect(stored.status).toBe('confirmed');
    expect(stored.confirmedAt).toBeGreaterThan(0);
  });

  test('updateAppointmentStatus: cancelled agrega cancelledAt y cancelReason', async () => {
    const rec = buildAppointmentRecord(UID, PHONE, DT);
    await saveAppointment(UID, rec);
    await updateAppointmentStatus(UID, rec.appointmentId, 'cancelled', { cancelReason: 'Cliente no disponible' });
    const stored = mock.store[UID]['appointments'][rec.appointmentId];
    expect(stored.status).toBe('cancelled');
    expect(stored.cancelledAt).toBeGreaterThan(0);
    expect(stored.cancelReason).toBe('Cliente no disponible');
  });

  // Constantes

  test('APPOINTMENT_STATUSES es frozen con 6 estados correctos', () => {
    expect(Object.isFrozen(APPOINTMENT_STATUSES)).toBe(true);
    expect(APPOINTMENT_STATUSES.length).toBe(6);
    ['pending','confirmed','cancelled','completed','no_show','rescheduled'].forEach(s => {
      expect(APPOINTMENT_STATUSES).toContain(s);
    });
  });

  test('APPOINTMENT_TYPES es frozen con 4 tipos correctos', () => {
    expect(Object.isFrozen(APPOINTMENT_TYPES)).toBe(true);
    expect(APPOINTMENT_TYPES.length).toBe(4);
    ['in_person','remote','phone_call','home_visit'].forEach(t => {
      expect(APPOINTMENT_TYPES).toContain(t);
    });
  });

  test('isValidStatus e isValidType funcionan correctamente', () => {
    expect(isValidStatus('confirmed')).toBe(true);
    expect(isValidStatus('flying')).toBe(false);
    expect(isValidType('remote')).toBe(true);
    expect(isValidType('submarine')).toBe(false);
  });

  test('MAX_APPOINTMENTS_PER_DAY=20 y SLOT_DURATION_MIN_DEFAULT=30', () => {
    expect(MAX_APPOINTMENTS_PER_DAY).toBe(20);
    expect(SLOT_DURATION_MIN_DEFAULT).toBe(30);
  });
});
