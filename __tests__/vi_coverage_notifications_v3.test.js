'use strict';

/**
 * VI-BACKEND-COVERAGE: notifications_v3.js — 100% branches
 */

const {
  __setFirestoreForTests,
  NOTIFICATION_CHANNELS,
  AB_TEST_STATUS,
  sendMultiChannel,
  createABTest,
  recordABResult,
  getPredictiveSendTime,
  scheduleNotification,
} = require('../core/notifications_v3');

function makeDb({ abTestDoc = null, batches = [] } = {}) {
  const setMock = jest.fn().mockResolvedValue(undefined);
  const getMock = jest.fn().mockResolvedValue(
    abTestDoc
      ? { exists: true, data: () => abTestDoc }
      : { exists: false, data: () => null }
  );
  return {
    _setMock: setMock,
    collection: (col) => ({
      doc: (id) => ({
        set: setMock,
        get: getMock,
      }),
      where: () => ({
        get: () => Promise.resolve({
          forEach: (cb) => batches.forEach(d => cb({ data: () => d })),
        }),
      }),
    }),
  };
}

// ── NOTIFICATION_CHANNELS / AB_TEST_STATUS ────────────────────────────────────

describe('constantes', () => {
  test('NOTIFICATION_CHANNELS frozen con los 3 canales', () => {
    expect(NOTIFICATION_CHANNELS).toContain('whatsapp');
    expect(NOTIFICATION_CHANNELS).toContain('email');
    expect(NOTIFICATION_CHANNELS).toContain('push_web');
    expect(() => { NOTIFICATION_CHANNELS.push('x'); }).toThrow();
  });

  test('AB_TEST_STATUS frozen con active/paused/completed', () => {
    expect(AB_TEST_STATUS).toContain('active');
    expect(AB_TEST_STATUS).toContain('paused');
    expect(AB_TEST_STATUS).toContain('completed');
    expect(() => { AB_TEST_STATUS.push('x'); }).toThrow();
  });
});

// ── sendMultiChannel ──────────────────────────────────────────────────────────

describe('sendMultiChannel', () => {
  beforeEach(() => { __setFirestoreForTests(makeDb()); });

  test('canales inválidos → throw', async () => {
    await expect(sendMultiChannel('uid', '+57', 'msg', ['sms'])).rejects.toThrow('Invalid channels: sms');
    await expect(sendMultiChannel('uid', '+57', 'msg', ['whatsapp', 'smoke'])).rejects.toThrow('Invalid channels: smoke');
  });

  test('canales válidos → guarda batch y retorna', async () => {
    const db = makeDb();
    __setFirestoreForTests(db);
    const r = await sendMultiChannel('uid-1', '+57001', 'hola', ['whatsapp', 'email']);
    expect(r.channels).toHaveLength(2);
    expect(r.channels[0].channel).toBe('whatsapp');
    expect(r.channels[0].status).toBe('queued');
    expect(typeof r.id).toBe('string');
    expect(db._setMock).toHaveBeenCalled();
  });
});

// ── createABTest ──────────────────────────────────────────────────────────────

describe('createABTest', () => {
  beforeEach(() => { __setFirestoreForTests(makeDb()); });

  test('menos de 2 variantes → throw', async () => {
    await expect(createABTest('uid', { variants: [] })).rejects.toThrow('Need at least 2 variants');
    await expect(createABTest('uid', { variants: [{ text: 'solo uno' }] })).rejects.toThrow('Need at least 2 variants');
    await expect(createABTest('uid', {})).rejects.toThrow('Need at least 2 variants');
  });

  test('2+ variantes → crea test con targetSegment default "all"', async () => {
    const db = makeDb();
    __setFirestoreForTests(db);
    const r = await createABTest('uid-1', {
      variants: [{ text: 'variante A' }, { text: 'variante B' }],
    });
    expect(r.status).toBe('active');
    expect(r.targetSegment).toBe('all');
    expect(r.variants).toHaveLength(2);
    expect(r.variants[0].index).toBe(0);
    expect(r.variants[1].index).toBe(1);
    expect(db._setMock).toHaveBeenCalled();
  });

  test('targetSegment personalizado se respeta', async () => {
    __setFirestoreForTests(makeDb());
    const r = await createABTest('uid-2', {
      variants: [{ text: 'A' }, { text: 'B' }],
      targetSegment: 'premium',
    });
    expect(r.targetSegment).toBe('premium');
  });
});

// ── recordABResult ────────────────────────────────────────────────────────────

describe('recordABResult', () => {
  test('test no encontrado → throw', async () => {
    __setFirestoreForTests(makeDb({ abTestDoc: null }));
    await expect(recordABResult('test-x', 0, true)).rejects.toThrow('AB test not found: test-x');
  });

  test('opened=true con opens>0 → incrementa sends y opens (|| truthy)', async () => {
    const abTestDoc = {
      variants: [
        { index: 0, sends: 2, opens: 1 },
        { index: 1, sends: 1, opens: 0 },
      ],
    };
    const db = makeDb({ abTestDoc });
    __setFirestoreForTests(db);
    const r = await recordABResult('test-1', 0, true);
    expect(r.testId).toBe('test-1');
    expect(r.variant).toBe(0);
    expect(r.opened).toBe(true);
    expect(db._setMock).toHaveBeenCalled();
  });

  test('opened=true con opens=0 → incrementa sends y opens desde 0 (|| falsy)', async () => {
    const abTestDoc = {
      variants: [{ index: 0, sends: 0, opens: 0 }],
    };
    const db = makeDb({ abTestDoc });
    __setFirestoreForTests(db);
    const r = await recordABResult('test-1b', 0, true);
    expect(r.opened).toBe(true);
  });

  test('opened=false con opens=0 → no incrementa opens', async () => {
    const abTestDoc = {
      variants: [{ index: 0, sends: 0, opens: 0 }],
    };
    const db = makeDb({ abTestDoc });
    __setFirestoreForTests(db);
    const r = await recordABResult('test-2', 0, false);
    expect(r.opened).toBe(false);
  });

  test('opened=false con opens>0 → opens se mantiene (|| truthy)', async () => {
    const abTestDoc = {
      variants: [{ index: 0, sends: 3, opens: 2 }],
    };
    const db = makeDb({ abTestDoc });
    __setFirestoreForTests(db);
    const r = await recordABResult('test-3', 0, false);
    expect(r.opened).toBe(false);
    expect(db._setMock).toHaveBeenCalled();
  });
});

// ── getDb() firebase fallback ─────────────────────────────────────────────────

describe('getDb() fallback a config/firebase', () => {
  test('sin _db → usa config/firebase virtual', async () => {
    jest.resetModules();
    const mockSetFn = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../config/firebase', () => ({
      db: {
        collection: () => ({
          doc: () => ({
            set: mockSetFn,
            get: () => Promise.resolve({ exists: false }),
          }),
          where: () => ({
            get: () => Promise.resolve({ forEach: () => {} }),
          }),
        }),
      },
    }), { virtual: true });
    const n = require('../core/notifications_v3');
    await n.scheduleNotification('uid-fb', '+57000', 'msg', '2026-06-01T10:00:00Z', null);
    expect(mockSetFn).toHaveBeenCalled();
    jest.dontMock('../config/firebase');
  });
});

// ── getPredictiveSendTime ─────────────────────────────────────────────────────

describe('getPredictiveSendTime', () => {
  test('sin batches → default hora 10', async () => {
    __setFirestoreForTests(makeDb({ batches: [] }));
    const r = await getPredictiveSendTime('uid-1', '+57001');
    expect(r.hour).toBe(10);
    expect(r.source).toBe('default');
    expect(r.timezone).toBe('America/Bogota');
  });

  test('con batches del mismo phone → promedio horario', async () => {
    __setFirestoreForTests(makeDb({
      batches: [
        { phone: '+57001', sentAt: new Date('2026-01-01T08:00:00Z').toISOString() },
        { phone: '+57001', sentAt: new Date('2026-01-02T12:00:00Z').toISOString() },
        { phone: '+57002', sentAt: new Date('2026-01-01T22:00:00Z').toISOString() }, // otro phone
      ],
    }));
    const r = await getPredictiveSendTime('uid-1', '+57001');
    expect(r.source).toBe('historical');
    expect(r.hour).toBe(10); // (8+12)/2 = 10
  });

  test('batch sin sentAt → no se incluye en horas', async () => {
    __setFirestoreForTests(makeDb({
      batches: [
        { phone: '+57001' }, // sin sentAt
      ],
    }));
    const r = await getPredictiveSendTime('uid-1', '+57001');
    expect(r.source).toBe('default');
  });
});

// ── scheduleNotification ──────────────────────────────────────────────────────

describe('scheduleNotification', () => {
  test('guarda con channels default [whatsapp] si no se pasan', async () => {
    const db = makeDb();
    __setFirestoreForTests(db);
    const r = await scheduleNotification('uid-1', '+57001', 'recordatorio', '2026-06-01T10:00:00Z', null);
    expect(r.channels).toEqual(['whatsapp']);
    expect(r.status).toBe('scheduled');
    expect(db._setMock).toHaveBeenCalled();
  });

  test('channels pasados se respetan', async () => {
    const db = makeDb();
    __setFirestoreForTests(db);
    const r = await scheduleNotification('uid-2', '+57002', 'msg', '2026-06-01T10:00:00Z', ['email', 'push_web']);
    expect(r.channels).toEqual(['email', 'push_web']);
  });
});
