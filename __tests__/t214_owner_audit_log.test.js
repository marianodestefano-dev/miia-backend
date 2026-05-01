'use strict';

const {
  isValidAction, isValidSeverity, logAction, getAuditLog,
  getActionsByType, getCriticalActions,
  ACTION_TYPES, SEVERITY_LEVELS, DEFAULT_SEVERITY, MAX_LOG_ENTRIES_PER_QUERY,
  __setFirestoreForTests,
} = require('../core/owner_audit_log');

const UID = 'testUid1234567890';

function makeMockDb({ docs = [], throwGet = false, throwSet = false } = {}) {
  const snap = {
    forEach: fn => docs.forEach((d, i) => fn({ id: 'entry' + i, data: () => d })),
  };
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            set: async () => { if (throwSet) throw new Error('set error'); },
          }),
          limit: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              return snap;
            },
          }),
          where: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              return snap;
            },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('ACTION_TYPES / SEVERITY_LEVELS / consts', () => {
  test('tiene acciones comunes', () => {
    expect(ACTION_TYPES).toContain('login');
    expect(ACTION_TYPES).toContain('config_change');
    expect(ACTION_TYPES).toContain('export_data');
  });
  test('ACTION_TYPES es frozen', () => {
    expect(() => { ACTION_TYPES.push('nuevo'); }).toThrow();
  });
  test('SEVERITY_LEVELS tiene info warning critical', () => {
    expect(SEVERITY_LEVELS).toContain('info');
    expect(SEVERITY_LEVELS).toContain('warning');
    expect(SEVERITY_LEVELS).toContain('critical');
  });
  test('DEFAULT_SEVERITY es info', () => {
    expect(DEFAULT_SEVERITY).toBe('info');
  });
  test('MAX_LOG_ENTRIES_PER_QUERY es 100', () => {
    expect(MAX_LOG_ENTRIES_PER_QUERY).toBe(100);
  });
});

describe('isValidAction / isValidSeverity', () => {
  test('true para acciones validas', () => {
    expect(isValidAction('login')).toBe(true);
    expect(isValidAction('export_data')).toBe(true);
  });
  test('false para accion invalida', () => {
    expect(isValidAction('hackear')).toBe(false);
  });
  test('true para severity valida', () => {
    expect(isValidSeverity('critical')).toBe(true);
  });
  test('false para severity invalida', () => {
    expect(isValidSeverity('extreme')).toBe(false);
  });
});

describe('logAction', () => {
  test('lanza si uid undefined', async () => {
    await expect(logAction(undefined, 'login')).rejects.toThrow('uid requerido');
  });
  test('lanza si action undefined', async () => {
    await expect(logAction(UID, undefined)).rejects.toThrow('action requerido');
  });
  test('lanza si action invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(logAction(UID, 'hackear')).rejects.toThrow('action invalido');
  });
  test('retorna entryId y timestamp', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await logAction(UID, 'login');
    expect(r.entryId).toBeDefined();
    expect(r.timestamp).toBeDefined();
  });
  test('usa severity del meta si valida', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await logAction(UID, 'api_key_rotate', { severity: 'critical' });
    expect(r.entryId).toBeDefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(logAction(UID, 'login')).rejects.toThrow('set error');
  });
});

describe('getAuditLog', () => {
  test('lanza si uid undefined', async () => {
    await expect(getAuditLog(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay entradas', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getAuditLog(UID);
    expect(r).toEqual([]);
  });
  test('retorna entradas con entryId', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [{ action: 'login', timestamp: new Date().toISOString() }] }));
    const r = await getAuditLog(UID);
    expect(r.length).toBe(1);
    expect(r[0].entryId).toBeDefined();
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getAuditLog(UID);
    expect(r).toEqual([]);
  });
});

describe('getActionsByType', () => {
  test('lanza si uid undefined', async () => {
    await expect(getActionsByType(undefined, 'login')).rejects.toThrow('uid requerido');
  });
  test('lanza si action invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getActionsByType(UID, 'invalido')).rejects.toThrow('action invalido');
  });
  test('retorna entradas del tipo pedido', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [{ action: 'login', severity: 'info' }] }));
    const r = await getActionsByType(UID, 'login');
    expect(r.length).toBe(1);
  });
});

describe('getCriticalActions', () => {
  test('lanza si uid undefined', async () => {
    await expect(getCriticalActions(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna entradas criticas', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [{ action: 'api_key_rotate', severity: 'critical' }] }));
    const r = await getCriticalActions(UID);
    expect(r.length).toBe(1);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getCriticalActions(UID);
    expect(r).toEqual([]);
  });
});
