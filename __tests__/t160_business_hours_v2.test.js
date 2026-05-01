'use strict';

const {
  isBusinessOpen, getSchedule, saveSchedule, validateSchedule,
  addHoliday, addSpecialDay, DAYS_OF_WEEK, DEFAULT_SCHEDULE,
  __setFirestoreForTests,
} = require('../core/business_hours_v2');

const BASE = {
  monday: [{ open: '09:00', close: '18:00' }],
  tuesday: [{ open: '09:00', close: '18:00' }],
  wednesday: [{ open: '09:00', close: '18:00' }],
  thursday: [{ open: '09:00', close: '18:00' }],
  friday: [{ open: '09:00', close: '17:00' }],
  saturday: [], sunday: [], holidays: [], specialDays: [], timezone: 'UTC',
};

const MON_NOON  = new Date('2026-05-04T12:00:00.000Z').getTime(); // lunes 12:00 UTC
const MON_EARLY = new Date('2026-05-04T08:00:00.000Z').getTime(); // lunes 08:00 UTC
const SAT_NOON  = new Date('2026-05-09T12:00:00.000Z').getTime(); // sabado 12:00 UTC

function makeMockDb({ data = null, throwGet = false, throwSet = false } = {}) {
  return { collection: () => ({ doc: () => ({
    get: async () => {
      if (throwGet) throw new Error('get error');
      if (!data) return { exists: false, data: () => ({}) };
      return { exists: true, data: () => data };
    },
    set: async () => { if (throwSet) throw new Error('set error'); },
  })})};
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('DAYS_OF_WEEK y DEFAULT_SCHEDULE', () => {
  test('DAYS_OF_WEEK tiene 7 dias', () => { expect(DAYS_OF_WEEK.length).toBe(7); });
  test('DAYS_OF_WEEK[0] es sunday', () => { expect(DAYS_OF_WEEK[0]).toBe('sunday'); });
  test('DAYS_OF_WEEK es frozen', () => { expect(() => { DAYS_OF_WEEK.push('x'); }).toThrow(); });
  test('DEFAULT_SCHEDULE tiene todos los dias', () => {
    for (const d of DAYS_OF_WEEK) expect(DEFAULT_SCHEDULE[d]).toBeDefined();
  });
});

describe('isBusinessOpen - validacion', () => {
  test('lanza si schedule null', () => { expect(() => isBusinessOpen(null, MON_NOON)).toThrow('schedule requerido'); });
});

describe('isBusinessOpen - horario normal', () => {
  test('abierto lunes mediodia', () => {
    const r = isBusinessOpen(BASE, MON_NOON);
    expect(r.isOpen).toBe(true);
    expect(r.reason).toBe('open');
    expect(r.nextOpen).toBeNull();
  });
  test('cerrado lunes antes de abrir', () => {
    const r = isBusinessOpen(BASE, MON_EARLY);
    expect(r.isOpen).toBe(false);
    expect(r.reason).toBe('outside_hours');
    expect(r.nextOpen).toBeDefined();
  });
  test('cerrado sabado', () => {
    const r = isBusinessOpen(BASE, SAT_NOON);
    expect(r.isOpen).toBe(false);
    expect(r.reason).toBe('closed_day');
  });
  test('nextOpen desde sabado apunta al lunes siguiente', () => {
    const r = isBusinessOpen(BASE, SAT_NOON);
    expect(r.nextOpen).toContain('2026-05-11');
  });
});

describe('isBusinessOpen - feriados', () => {
  test('cerrado en feriado', () => {
    const s = { ...BASE, holidays: ['2026-05-04'] };
    const r = isBusinessOpen(s, MON_NOON);
    expect(r.isOpen).toBe(false);
    expect(r.reason).toBe('holiday');
  });
  test('nextOpen salta feriados consecutivos', () => {
    const s = { ...BASE, holidays: ['2026-05-04', '2026-05-05'] };
    const r = isBusinessOpen(s, MON_NOON);
    expect(r.nextOpen).toContain('2026-05-06');
  });
});

describe('isBusinessOpen - dias especiales', () => {
  test('cerrado en dia especial sin slots', () => {
    const s = { ...BASE, specialDays: [{ date: '2026-05-04', slots: [] }] };
    const r = isBusinessOpen(s, MON_NOON);
    expect(r.isOpen).toBe(false);
    expect(r.reason).toBe('special_closed');
  });
  test('abierto en dia especial con slot que cubre la hora', () => {
    const s = { ...BASE, specialDays: [{ date: '2026-05-04', slots: [{ open: '10:00', close: '14:00' }] }] };
    const r = isBusinessOpen(s, MON_NOON);
    expect(r.isOpen).toBe(true);
    expect(r.reason).toBe('special_open');
  });
  test('cerrado en dia especial fuera del slot', () => {
    const s = { ...BASE, specialDays: [{ date: '2026-05-04', slots: [{ open: '14:00', close: '18:00' }] }] };
    const r = isBusinessOpen(s, MON_NOON);
    expect(r.isOpen).toBe(false);
    expect(r.reason).toBe('special_outside_hours');
  });
});

describe('validateSchedule', () => {
  test('vacio para schedule valido', () => { expect(validateSchedule(BASE)).toEqual([]); });
  test('error si day no es array', () => {
    const errs = validateSchedule({ ...BASE, monday: 'manana' });
    expect(errs.some(e => e.includes('monday'))).toBe(true);
  });
  test('error si open >= close', () => {
    const errs = validateSchedule({ ...BASE, monday: [{ open: '18:00', close: '09:00' }] });
    expect(errs.some(e => e.includes('open debe ser antes'))).toBe(true);
  });
  test('error si holidays no es array', () => {
    const errs = validateSchedule({ ...BASE, holidays: 'hoy' });
    expect(errs.some(e => e.includes('holidays'))).toBe(true);
  });
  test('error si schedule null', () => { expect(validateSchedule(null).length).toBeGreaterThan(0); });
});

describe('addHoliday', () => {
  test('agrega feriado', () => {
    const s = addHoliday(BASE, '2026-12-25');
    expect(s.holidays).toContain('2026-12-25');
  });
  test('no duplica', () => {
    const s = addHoliday(addHoliday(BASE, '2026-12-25'), '2026-12-25');
    expect(s.holidays.filter(d => d === '2026-12-25').length).toBe(1);
  });
  test('lanza si fecha invalida', () => {
    expect(() => addHoliday(BASE, '25-12-2026')).toThrow('fecha invalida');
  });
  test('inmutable - retorna nuevo objeto', () => {
    expect(addHoliday(BASE, '2026-12-25')).not.toBe(BASE);
  });
});

describe('addSpecialDay', () => {
  test('agrega dia especial', () => {
    const s = addSpecialDay(BASE, '2026-12-24', [{ open: '10:00', close: '14:00' }]);
    expect(s.specialDays.find(sd => sd.date === '2026-12-24')).toBeDefined();
  });
  test('reemplaza dia existente', () => {
    const s1 = addSpecialDay(BASE, '2026-12-24', [{ open: '10:00', close: '14:00' }]);
    const s2 = addSpecialDay(s1, '2026-12-24', [{ open: '08:00', close: '12:00' }]);
    expect(s2.specialDays.filter(sd => sd.date === '2026-12-24').length).toBe(1);
    expect(s2.specialDays.find(sd => sd.date === '2026-12-24').slots[0].open).toBe('08:00');
  });
  test('lanza si slots no es array', () => {
    expect(() => addSpecialDay(BASE, '2026-12-24', 'maniana')).toThrow('slots debe ser array');
  });
});

describe('getSchedule', () => {
  test('lanza si uid undefined', async () => {
    await expect(getSchedule(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna default si doc no existe', async () => {
    __setFirestoreForTests(makeMockDb({ data: null }));
    const s = await getSchedule('uid1');
    expect(s.monday).toBeDefined();
    expect(Array.isArray(s.holidays)).toBe(true);
  });
  test('fail-open retorna default si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const s = await getSchedule('uid1');
    expect(s.monday).toBeDefined();
  });
});

describe('saveSchedule', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveSchedule(undefined, BASE)).rejects.toThrow('uid requerido');
  });
  test('lanza si schedule invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveSchedule('uid1', { monday: 'nope' })).rejects.toThrow('invalido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveSchedule('uid1', BASE)).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(saveSchedule('uid1', BASE)).rejects.toThrow('set error');
  });
});
