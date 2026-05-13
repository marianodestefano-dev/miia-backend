'use strict';

/**
 * EXTRA #4.a — Multi-calendar awareness (IDEA #026)
 * Test del fix para evitar double booking: getAllVisibleCalendarIds usa
 * cal.calendarList.list() API real en lugar de solo data.calendars manual.
 *
 * Bug reproducido 2026-04-14 07:38: MIIA agendó "Probamos con Wi"
 * jueves 16 9am sin detectar el bloque ocupado 06:30-11:30 en el calendar
 * de trabajo compartido (JumpCloud freeBusyReader).
 */

// Mock googleapis + firebase-admin antes de require
jest.mock('googleapis', () => {
  const mockCal = { calendarList: { list: jest.fn() } };
  return {
    google: {
      auth: { OAuth2: jest.fn(function () { this.setCredentials = function () {}; this.on = function () {}; }) },
      calendar: jest.fn(() => mockCal),
      __mockCal: mockCal,
    },
  };
});

const mockGoogle = require('googleapis');

let mockGet = null;
jest.mock('firebase-admin', () => ({
  firestore: () => ({
    collection: () => ({ doc: () => ({ get: () => mockGet() }) }),
  }),
}));

const gcal = require('../core/google_calendar');

beforeEach(() => {
  mockGoogle.google.__mockCal.calendarList.list = jest.fn();
  mockGet = null;
});

// ── getAllVisibleCalendarIds ──────────────────────────────────────────────────

describe('getAllVisibleCalendarIds (EXTRA #4.a IDEA #026)', () => {
  test('owner sin tokens -> fallback getAllCalendarIds manual', async () => {
    // Sin googleTokens, getCalendarClient lanza, cae al catch
    mockGet = () => Promise.resolve({ exists: true, data: () => ({}) });
    const ids = await gcal.getAllVisibleCalendarIds('uid12345');
    // Fallback retorna al menos ['primary']
    expect(Array.isArray(ids)).toBe(true);
    expect(ids).toContain('primary');
  });

  test('API retorna multi-calendar (primary + work share + personal) -> todos incluidos', async () => {
    mockGet = () => Promise.resolve({
      exists: true,
      data: () => ({
        googleTokens: { access_token: 'ok', refresh_token: 'r' },
        googleCalendarId: 'primary',
      }),
    });
    mockGoogle.google.__mockCal.calendarList.list = jest.fn().mockResolvedValue({
      data: {
        items: [
          { id: 'primary', summary: 'Personal', accessRole: 'owner', selected: true },
          { id: 'work-shared@health.medilink.cl', summary: 'Trabajo', accessRole: 'freeBusyReader', selected: true },
          { id: 'other@gmail.com', summary: 'Otro', accessRole: 'reader', selected: true },
        ],
      },
    });
    const ids = await gcal.getAllVisibleCalendarIds('uid12345');
    expect(ids).toContain('primary');
    expect(ids).toContain('work-shared@health.medilink.cl');
    expect(ids).toContain('other@gmail.com');
  });

  test('calendarios hidden o deselected -> excluidos', async () => {
    mockGet = () => Promise.resolve({
      exists: true,
      data: () => ({ googleTokens: { access_token: 'ok' } }),
    });
    mockGoogle.google.__mockCal.calendarList.list = jest.fn().mockResolvedValue({
      data: {
        items: [
          { id: 'primary', summary: 'P', accessRole: 'owner', selected: true },
          { id: 'hidden_cal', summary: 'H', accessRole: 'owner', hidden: true },
          { id: 'unselected', summary: 'U', accessRole: 'owner', selected: false },
          { id: 'deleted', summary: 'D', accessRole: 'owner', deleted: true },
        ],
      },
    });
    const ids = await gcal.getAllVisibleCalendarIds('uid12345');
    expect(ids).toContain('primary');
    expect(ids).not.toContain('hidden_cal');
    expect(ids).not.toContain('unselected');
    expect(ids).not.toContain('deleted');
  });

  test('calendarios sin accessRole valido -> excluidos', async () => {
    mockGet = () => Promise.resolve({
      exists: true,
      data: () => ({ googleTokens: { access_token: 'ok' } }),
    });
    mockGoogle.google.__mockCal.calendarList.list = jest.fn().mockResolvedValue({
      data: {
        items: [
          { id: 'primary', summary: 'P', accessRole: 'owner', selected: true },
          { id: 'no_access', summary: 'X', accessRole: 'none', selected: true },
          { id: 'no_role', summary: 'Y', selected: true },
        ],
      },
    });
    const ids = await gcal.getAllVisibleCalendarIds('uid12345');
    expect(ids).toContain('primary');
    expect(ids).not.toContain('no_access');
    expect(ids).not.toContain('no_role');
  });

  test('item null o sin id -> ignorado sin romper', async () => {
    mockGet = () => Promise.resolve({
      exists: true,
      data: () => ({ googleTokens: { access_token: 'ok' } }),
    });
    mockGoogle.google.__mockCal.calendarList.list = jest.fn().mockResolvedValue({
      data: {
        items: [
          null,
          { /* sin id */ summary: 'X', accessRole: 'owner', selected: true },
          { id: 'primary', summary: 'P', accessRole: 'owner', selected: true },
        ],
      },
    });
    const ids = await gcal.getAllVisibleCalendarIds('uid12345');
    expect(ids).toContain('primary');
  });

  test('cal.calendarList.list lanza -> fallback a getAllCalendarIds', async () => {
    mockGet = () => Promise.resolve({
      exists: true,
      data: () => ({ googleTokens: { access_token: 'ok' }, googleCalendarId: 'primary' }),
    });
    mockGoogle.google.__mockCal.calendarList.list = jest.fn().mockRejectedValue(new Error('API down'));
    const ids = await gcal.getAllVisibleCalendarIds('uid12345');
    expect(ids).toContain('primary');
  });

  test('calendars manuales se incluyen como fallback aunque API responda', async () => {
    mockGet = () => Promise.resolve({
      exists: true,
      data: () => ({
        googleTokens: { access_token: 'ok' },
        calendars: {
          personal: { id: 'personal_cal' },
          work: { id: 'work_cal_manual' },
        },
      }),
    });
    mockGoogle.google.__mockCal.calendarList.list = jest.fn().mockResolvedValue({
      data: { items: [{ id: 'primary', accessRole: 'owner', selected: true }] },
    });
    const ids = await gcal.getAllVisibleCalendarIds('uid12345');
    expect(ids).toContain('primary');
    expect(ids).toContain('personal_cal');
    expect(ids).toContain('work_cal_manual');
  });

  test('items vacio -> fallback agrega primary', async () => {
    mockGet = () => Promise.resolve({
      exists: true,
      data: () => ({ googleTokens: { access_token: 'ok' } }),
    });
    mockGoogle.google.__mockCal.calendarList.list = jest.fn().mockResolvedValue({ data: {} });
    const ids = await gcal.getAllVisibleCalendarIds('uid12345');
    expect(ids).toContain('primary');
  });
});

// ── getAllCalendarIds (legacy, sin cambios) ───────────────────────────────────

describe('getAllCalendarIds (legacy)', () => {
  test('default primary cuando no hay config', async () => {
    mockGet = () => Promise.resolve({ exists: false, data: () => ({}) });
    const ids = await gcal.getAllCalendarIds('uid12345');
    expect(ids).toEqual(['primary']);
  });

  test('respeta googleCalendarId custom + calendars manuales', async () => {
    mockGet = () => Promise.resolve({
      exists: true,
      data: () => ({
        googleCalendarId: 'custom@gmail.com',
        calendars: {
          personal: { id: 'cal_personal' },
          work: { id: 'cal_work' },
        },
      }),
    });
    const ids = await gcal.getAllCalendarIds('uid12345');
    expect(ids).toContain('custom@gmail.com');
    expect(ids).toContain('cal_personal');
    expect(ids).toContain('cal_work');
  });

  test('calendars sin .id en personal/work -> ignorados', async () => {
    mockGet = () => Promise.resolve({
      exists: true,
      data: () => ({
        calendars: { personal: {}, work: {} },
      }),
    });
    const ids = await gcal.getAllCalendarIds('uid12345');
    expect(ids).toEqual(['primary']);
  });
});
