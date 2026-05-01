'use strict';
const { logAuditEvent, getAuditLog, hashEntry, AUDIT_ACTIONS, MAX_META_KEYS, __setFirestoreForTests } = require('../core/audit_trail');

const UID = 'auditTestUid1234567890';

function makeMockDb({ throwSet = false, throwGet = false } = {}) {
  const store = {};
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id) => ({
            set: async (data) => {
              if (throwSet) throw new Error('set failed');
              store[id] = data;
            }
          }),
          get: async () => {
            if (throwGet) throw new Error('get failed');
            return { docs: Object.entries(store).map(([, v]) => ({ data: () => v })) };
          }
        })
      })
    })
  };
}

afterEach(() => { __setFirestoreForTests(null); });

describe('AUDIT_ACTIONS y MAX_META_KEYS', () => {
  test('tiene acciones esperadas', () => {
    expect(AUDIT_ACTIONS).toContain('training_data:updated');
    expect(AUDIT_ACTIONS).toContain('consent:granted');
    expect(AUDIT_ACTIONS).toContain('key:rotated');
  });
  test('MAX_META_KEYS = 10', () => {
    expect(MAX_META_KEYS).toBe(10);
  });
});

describe('hashEntry', () => {
  test('produce string hexadecimal de 16 chars', () => {
    const entry = { timestamp: '2024-01-01T00:00:00.000Z', uid: 'uid1', action: 'key:rotated', actor: 'system' };
    const hash = hashEntry(entry);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(16);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });
  test('mismo input = mismo hash', () => {
    const entry = { timestamp: 't', uid: 'u', action: 'data:exported', actor: 'owner' };
    expect(hashEntry(entry)).toBe(hashEntry(entry));
  });
});

describe('logAuditEvent — validacion', () => {
  beforeEach(() => { __setFirestoreForTests(makeMockDb()); });

  test('lanza si uid falta', async () => {
    await expect(logAuditEvent(null, 'key:rotated', 'system')).rejects.toThrow('uid requerido');
  });
  test('lanza si action invalida', async () => {
    await expect(logAuditEvent(UID, 'accion:no_existe', 'system')).rejects.toThrow('action invalida');
  });
  test('lanza si actor falta', async () => {
    await expect(logAuditEvent(UID, 'key:rotated', '')).rejects.toThrow('actor requerido');
  });
  test('lanza si meta supera MAX_META_KEYS', async () => {
    const meta = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i]));
    await expect(logAuditEvent(UID, 'key:rotated', 'system', meta)).rejects.toThrow('max 10 keys');
  });
});

describe('logAuditEvent — exito', () => {
  beforeEach(() => { __setFirestoreForTests(makeMockDb()); });

  test('retorna entryId, timestamp, hash', async () => {
    const r = await logAuditEvent(UID, 'consent:granted', 'owner', { ip: '1.1.1.1' });
    expect(typeof r.entryId).toBe('string');
    expect(r.entryId.startsWith('audit_')).toBe(true);
    expect(typeof r.timestamp).toBe('string');
    expect(typeof r.hash).toBe('string');
  });
  test('lanza si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(logAuditEvent(UID, 'key:rotated', 'system')).rejects.toThrow('set failed');
  });
});

describe('getAuditLog', () => {
  test('lanza si uid falta', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getAuditLog(null)).rejects.toThrow('uid requerido');
  });
  test('retorna [] si Firestore falla (fail-open)', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const result = await getAuditLog(UID);
    expect(result).toEqual([]);
  });
  test('filtra por action', async () => {
    const mock = makeMockDb();
    __setFirestoreForTests(mock);
    await logAuditEvent(UID, 'consent:granted', 'owner');
    await logAuditEvent(UID, 'key:rotated', 'system');
    const log = await getAuditLog(UID, { action: 'consent:granted' });
    expect(log.every(e => e.action === 'consent:granted')).toBe(true);
  });
  test('respeta limit', async () => {
    const mock = makeMockDb();
    __setFirestoreForTests(mock);
    await logAuditEvent(UID, 'data:exported', 'api');
    await logAuditEvent(UID, 'data:exported', 'api');
    await logAuditEvent(UID, 'data:exported', 'api');
    const log = await getAuditLog(UID, { limit: 2 });
    expect(log.length).toBeLessThanOrEqual(2);
  });
});
