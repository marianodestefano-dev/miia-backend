'use strict';

const {
  scheduleFollowUp, buildFollowUpRecord, saveFollowUp,
  updateFollowUpStatus, getNextFollowUp, getPendingFollowUps,
  buildFollowUpMessage, buildFollowUpSummaryText,
  isValidStatus, isValidType,
  FOLLOWUP_STATUSES, FOLLOWUP_TYPES, DEFAULT_DELAY_MS,
  MAX_FOLLOWUPS_PER_LEAD,
  __setFirestoreForTests,
} = require('../core/follow_up_scheduler');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const NOW = 1746100000000;

function makeMockDb({ stored = {}, throwGet = false, throwSet = false, pendingCount = 0 } = {}) {
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
            where: (f2, o2, v2) => ({
              get: async () => {
                if (throwGet) throw new Error('get error');
                const entries = Object.values(db_stored).filter(d => {
                  if (!d) return false;
                  let match = true;
                  if (field === 'phone') match = match && d.phone === val;
                  if (field === 'status') match = match && d.status === val;
                  if (f2 === 'phone') match = match && d.phone === v2;
                  if (f2 === 'status') match = match && d.status === v2;
                  return match;
                });
                const fakePending = pendingCount > 0
                  ? Array(pendingCount).fill({ phone: PHONE, status: 'pending' })
                  : entries;
                return {
                  empty: fakePending.length === 0,
                  forEach: fn => fakePending.forEach(d => fn({ data: () => d })),
                };
              },
            }),
            get: async () => {
              if (throwGet) throw new Error('get error');
              const entries = Object.values(db_stored).filter(d => {
                if (!d) return false;
                if (field === 'status') return d.status === val;
                if (field === 'phone') return d.phone === val;
                return true;
              });
              return {
                empty: entries.length === 0,
                forEach: fn => entries.forEach(d => fn({ data: () => d })),
              };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return {
              forEach: fn => Object.values(db_stored).forEach(d => fn({ data: () => d })),
            };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

describe('Constantes', () => {
  test('FOLLOWUP_STATUSES tiene 5', () => { expect(FOLLOWUP_STATUSES.length).toBe(5); });
  test('frozen FOLLOWUP_STATUSES', () => { expect(() => { FOLLOWUP_STATUSES.push('x'); }).toThrow(); });
  test('FOLLOWUP_TYPES tiene 6', () => { expect(FOLLOWUP_TYPES.length).toBe(6); });
  test('frozen FOLLOWUP_TYPES', () => { expect(() => { FOLLOWUP_TYPES.push('x'); }).toThrow(); });
  test('MAX_FOLLOWUPS_PER_LEAD es 10', () => { expect(MAX_FOLLOWUPS_PER_LEAD).toBe(10); });
  test('DEFAULT_DELAY_MS.day1_check es 1 dia', () => {
    expect(DEFAULT_DELAY_MS.day1_check).toBe(24 * 60 * 60 * 1000);
  });
  test('DEFAULT_DELAY_MS.day3_reminder es 3 dias', () => {
    expect(DEFAULT_DELAY_MS.day3_reminder).toBe(3 * 24 * 60 * 60 * 1000);
  });
  test('DEFAULT_DELAY_MS.week1_reconnect es 7 dias', () => {
    expect(DEFAULT_DELAY_MS.week1_reconnect).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('isValidStatus / isValidType', () => {
  test('pending es status valido', () => { expect(isValidStatus('pending')).toBe(true); });
  test('cancelled es status valido', () => { expect(isValidStatus('cancelled')).toBe(true); });
  test('bad_status no es valido', () => { expect(isValidStatus('bad_status')).toBe(false); });
  test('initial_response es type valido', () => { expect(isValidType('initial_response')).toBe(true); });
  test('custom es type valido', () => { expect(isValidType('custom')).toBe(true); });
  test('bad_type no es valido', () => { expect(isValidType('bad_type')).toBe(false); });
});

describe('buildFollowUpRecord', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildFollowUpRecord(undefined, PHONE, 'day1_check', NOW)).toThrow('uid requerido');
  });
  test('lanza si phone undefined', () => {
    expect(() => buildFollowUpRecord(UID, undefined, 'day1_check', NOW)).toThrow('phone requerido');
  });
  test('lanza si type invalido', () => {
    expect(() => buildFollowUpRecord(UID, PHONE, 'bad_type', NOW)).toThrow('type invalido');
  });
  test('lanza si scheduledAt no es numero', () => {
    expect(() => buildFollowUpRecord(UID, PHONE, 'day1_check', 'manana')).toThrow('scheduledAt debe ser timestamp ms');
  });
  test('construye record correctamente', () => {
    const r = buildFollowUpRecord(UID, PHONE, 'day1_check', NOW);
    expect(r.uid).toBe(UID);
    expect(r.phone).toBe(PHONE);
    expect(r.type).toBe('day1_check');
    expect(r.status).toBe('pending');
    expect(r.scheduledAt).toBe(NOW);
    expect(r.followUpId).toContain('day1_check');
  });
  test('acepta opts.message y opts.contactName', () => {
    const r = buildFollowUpRecord(UID, PHONE, 'custom', NOW, { message: 'Hola!', contactName: 'Juan' });
    expect(r.message).toBe('Hola!');
    expect(r.contactName).toBe('Juan');
  });
});

describe('scheduleFollowUp', () => {
  test('lanza si uid undefined', () => {
    expect(() => scheduleFollowUp(undefined, PHONE, 'day1_check')).toThrow('uid requerido');
  });
  test('lanza si type invalido', () => {
    expect(() => scheduleFollowUp(UID, PHONE, 'bad_type')).toThrow('type invalido');
  });
  test('day1_check se agenda en 1 dia desde baseTime', () => {
    const r = scheduleFollowUp(UID, PHONE, 'day1_check', { baseTime: NOW });
    expect(r.scheduledAt).toBe(NOW + DEFAULT_DELAY_MS.day1_check);
  });
  test('day3_reminder se agenda en 3 dias', () => {
    const r = scheduleFollowUp(UID, PHONE, 'day3_reminder', { baseTime: NOW });
    expect(r.scheduledAt).toBe(NOW + DEFAULT_DELAY_MS.day3_reminder);
  });
  test('custom con delayMs personalizado', () => {
    const r = scheduleFollowUp(UID, PHONE, 'custom', { baseTime: NOW, delayMs: 5000 });
    expect(r.scheduledAt).toBe(NOW + 5000);
  });
  test('status inicial es pending', () => {
    const r = scheduleFollowUp(UID, PHONE, 'initial_response');
    expect(r.status).toBe('pending');
  });
});

describe('saveFollowUp', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveFollowUp(undefined, { followUpId: 'x', phone: PHONE })).rejects.toThrow('uid requerido');
  });
  test('lanza si record invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveFollowUp(UID, null)).rejects.toThrow('record invalido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = scheduleFollowUp(UID, PHONE, 'day1_check', { baseTime: NOW });
    const id = await saveFollowUp(UID, r);
    expect(id).toBe(r.followUpId);
  });
  test('lanza si se alcanza MAX_FOLLOWUPS_PER_LEAD', async () => {
    __setFirestoreForTests(makeMockDb({ pendingCount: 10 }));
    const r = scheduleFollowUp(UID, PHONE, 'day1_check', { baseTime: NOW });
    await expect(saveFollowUp(UID, r)).rejects.toThrow('max follow-ups alcanzado');
  });
  test('propaga error Firestore en set', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const r = scheduleFollowUp(UID, PHONE, 'day1_check', { baseTime: NOW });
    await expect(saveFollowUp(UID, r)).rejects.toThrow('set error');
  });
});

describe('updateFollowUpStatus', () => {
  test('lanza si uid undefined', async () => {
    await expect(updateFollowUpStatus(undefined, 'id', 'sent')).rejects.toThrow('uid requerido');
  });
  test('lanza si followUpId undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateFollowUpStatus(UID, undefined, 'sent')).rejects.toThrow('followUpId requerido');
  });
  test('lanza si status invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateFollowUpStatus(UID, 'id123', 'bad_status')).rejects.toThrow('status invalido');
  });
  test('actualiza a sent sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const id = await updateFollowUpStatus(UID, 'fu_001', 'sent');
    expect(id).toBe('fu_001');
  });
  test('actualiza a cancelled sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const id = await updateFollowUpStatus(UID, 'fu_001', 'cancelled');
    expect(id).toBe('fu_001');
  });
});

describe('getNextFollowUp', () => {
  test('lanza si uid undefined', async () => {
    await expect(getNextFollowUp(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getNextFollowUp(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('retorna null si no hay pendientes', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getNextFollowUp(UID, PHONE)).toBeNull();
  });
  test('retorna el de menor scheduledAt', async () => {
    const r1 = buildFollowUpRecord(UID, PHONE, 'day1_check', NOW + 1000);
    const r2 = buildFollowUpRecord(UID, PHONE, 'day3_reminder', NOW + 500);
    __setFirestoreForTests(makeMockDb({ stored: { [r1.followUpId]: r1, [r2.followUpId]: r2 } }));
    const next = await getNextFollowUp(UID, PHONE);
    expect(next.type).toBe('day3_reminder');
  });
  test('fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getNextFollowUp(UID, PHONE)).toBeNull();
  });
});

describe('getPendingFollowUps', () => {
  test('lanza si uid undefined', async () => {
    await expect(getPendingFollowUps(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna vacio si no hay pendientes', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getPendingFollowUps(UID)).toEqual([]);
  });
  test('filtra por before timestamp', async () => {
    const r1 = { ...buildFollowUpRecord(UID, PHONE, 'day1_check', NOW - 1000), status: 'pending' };
    const r2 = { ...buildFollowUpRecord(UID, PHONE, 'day3_reminder', NOW + 5000), status: 'pending' };
    __setFirestoreForTests(makeMockDb({ stored: { [r1.followUpId]: r1, [r2.followUpId]: r2 } }));
    const pending = await getPendingFollowUps(UID, { before: NOW });
    expect(pending.length).toBe(1);
    expect(pending[0].type).toBe('day1_check');
  });
  test('filtra por type', async () => {
    const r1 = { ...buildFollowUpRecord(UID, PHONE, 'day1_check', NOW), status: 'pending' };
    const r2 = { ...buildFollowUpRecord(UID, '+5411999', 'day3_reminder', NOW + 100), status: 'pending' };
    __setFirestoreForTests(makeMockDb({ stored: { [r1.followUpId]: r1, [r2.followUpId]: r2 } }));
    const pending = await getPendingFollowUps(UID, { type: 'day1_check' });
    expect(pending.length).toBe(1);
    expect(pending[0].type).toBe('day1_check');
  });
  test('respeta limit', async () => {
    const stored = {};
    for (let i = 0; i < 5; i++) {
      const r = { ...buildFollowUpRecord(UID, '+5411' + i, 'day1_check', NOW + i * 1000), status: 'pending' };
      stored[r.followUpId] = r;
    }
    __setFirestoreForTests(makeMockDb({ stored }));
    const pending = await getPendingFollowUps(UID, { limit: 3 });
    expect(pending.length).toBe(3);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getPendingFollowUps(UID)).toEqual([]);
  });
});

describe('buildFollowUpMessage', () => {
  test('day1_check contiene nombre', () => {
    const text = buildFollowUpMessage('day1_check', 'Juan', 'MiBiz');
    expect(text).toContain('Juan');
    expect(text).toContain('MiBiz');
  });
  test('day3_reminder no vacio', () => {
    expect(buildFollowUpMessage('day3_reminder', 'Ana', 'Shop').length).toBeGreaterThan(0);
  });
  test('initial_response sin nombre usa fallback', () => {
    const text = buildFollowUpMessage('initial_response', null, null);
    expect(text.length).toBeGreaterThan(0);
  });
  test('custom retorna string vacio', () => {
    expect(buildFollowUpMessage('custom', 'X', 'Y')).toBe('');
  });
  test('month1_winback contiene negocio', () => {
    const text = buildFollowUpMessage('month1_winback', 'Carlos', 'MiTienda');
    expect(text).toContain('MiTienda');
  });
});

describe('buildFollowUpSummaryText', () => {
  test('retorna mensaje si vacio', () => {
    const text = buildFollowUpSummaryText([]);
    expect(text).toContain('No hay');
  });
  test('null retorna mensaje', () => {
    expect(buildFollowUpSummaryText(null)).toContain('No hay');
  });
  test('incluye count de follow-ups', () => {
    const records = [buildFollowUpRecord(UID, PHONE, 'day1_check', NOW)];
    const text = buildFollowUpSummaryText(records);
    expect(text).toContain('1');
  });
  test('muestra maximo 5 y agrega etc', () => {
    const records = [];
    for (let i = 0; i < 7; i++) {
      records.push(buildFollowUpRecord(UID, '+5411' + i, 'day1_check', NOW + i));
    }
    const text = buildFollowUpSummaryText(records);
    expect(text).toContain('mas');
  });
});
