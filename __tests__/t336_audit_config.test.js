'use strict';

const {
  logAuditEvent, getAuditLog, hashEntry,
  AUDIT_ACTIONS, MAX_META_KEYS,
  __setFirestoreForTests: setAuditDb,
} = require('../core/audit_trail');

const {
  validateTenantConfig, validateField,
  CONFIG_SCHEMA, VALID_TIMEZONES,
} = require('../core/config_validator');

const UID = 'uid_t336';

function makeAuditDb(auditDocs = []) {
  const store = {};
  return {
    collection: (col) => ({
      doc: (uid) => ({
        collection: (subCol) => ({
          doc: (id) => ({
            set: async (data) => {
              if (!store[uid]) store[uid] = {};
              store[uid][id] = data;
            },
          }),
          get: async () => ({
            docs: auditDocs.map(d => ({ data: () => d })),
          }),
        }),
      }),
    }),
  };
}

describe('T336 -- audit_trail + config_validator (28 tests)', () => {

  // AUDIT_ACTIONS
  test('AUDIT_ACTIONS frozen y contiene acciones sensibles', () => {
    expect(() => { AUDIT_ACTIONS.push('hack'); }).toThrow();
    expect(AUDIT_ACTIONS).toContain('training_data:updated');
    expect(AUDIT_ACTIONS).toContain('settings:updated');
    expect(AUDIT_ACTIONS).toContain('data:exported');
  });

  test('MAX_META_KEYS = 10', () => {
    expect(MAX_META_KEYS).toBe(10);
  });

  // hashEntry
  test('hashEntry: retorna string hex de 16 chars', () => {
    const entry = { timestamp: '2026-05-01T10:00:00Z', uid: UID, action: 'settings:updated', actor: 'owner' };
    const h = hashEntry(entry);
    expect(typeof h).toBe('string');
    expect(h.length).toBe(16);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });

  test('hashEntry: mismo input -> mismo hash (deterministico)', () => {
    const entry = { timestamp: '2026-05-01T10:00:00Z', uid: UID, action: 'settings:updated', actor: 'owner' };
    expect(hashEntry(entry)).toBe(hashEntry(entry));
  });

  // logAuditEvent
  test('logAuditEvent: uid null lanza', async () => {
    await expect(logAuditEvent(null, 'settings:updated', 'owner')).rejects.toThrow('uid requerido');
  });

  test('logAuditEvent: action invalida lanza', async () => {
    setAuditDb(makeAuditDb());
    await expect(logAuditEvent(UID, 'hack:done', 'owner')).rejects.toThrow('action invalida');
  });

  test('logAuditEvent: actor null lanza', async () => {
    setAuditDb(makeAuditDb());
    await expect(logAuditEvent(UID, 'settings:updated', null)).rejects.toThrow('actor requerido');
  });

  test('logAuditEvent: meta > 10 keys lanza', async () => {
    setAuditDb(makeAuditDb());
    const bigMeta = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i]));
    await expect(logAuditEvent(UID, 'settings:updated', 'owner', bigMeta)).rejects.toThrow('max 10 keys');
  });

  test('logAuditEvent: crea entrada correctamente', async () => {
    setAuditDb(makeAuditDb());
    const r = await logAuditEvent(UID, 'data:exported', 'owner', { format: 'json' });
    expect(r.entryId).toMatch(/^audit_/);
    expect(r.timestamp).toBeDefined();
    expect(r.hash).toHaveLength(16);
  });

  // getAuditLog
  test('getAuditLog: uid null lanza', async () => {
    await expect(getAuditLog(null)).rejects.toThrow('uid requerido');
  });

  test('getAuditLog: retorna entradas ordenadas desc', async () => {
    const docs = [
      { action: 'settings:updated', timestamp: '2026-05-01T09:00:00Z' },
      { action: 'data:exported', timestamp: '2026-05-01T10:00:00Z' },
    ];
    setAuditDb(makeAuditDb(docs));
    const entries = await getAuditLog(UID);
    expect(entries.length).toBe(2);
    expect(entries[0].action).toBe('data:exported'); // mas reciente primero
  });

  test('getAuditLog: filtrar por action', async () => {
    const docs = [
      { action: 'settings:updated', timestamp: '2026-05-01T09:00:00Z' },
      { action: 'data:exported', timestamp: '2026-05-01T10:00:00Z' },
    ];
    setAuditDb(makeAuditDb(docs));
    const entries = await getAuditLog(UID, { action: 'settings:updated' });
    expect(entries.length).toBe(1);
    expect(entries[0].action).toBe('settings:updated');
  });

  test('getAuditLog: Firestore error -> []', async () => {
    const brokenDb = { collection: () => { throw new Error('down'); } };
    setAuditDb(brokenDb);
    const entries = await getAuditLog(UID);
    expect(entries).toEqual([]);
  });

  // CONFIG_SCHEMA / VALID_TIMEZONES
  test('CONFIG_SCHEMA frozen', () => {
    expect(() => { CONFIG_SCHEMA.hackField = {}; }).toThrow();
  });

  test('VALID_TIMEZONES frozen y contiene America/Bogota', () => {
    expect(() => { VALID_TIMEZONES.push('Mars/Olympus'); }).toThrow();
    expect(VALID_TIMEZONES).toContain('America/Bogota');
    expect(VALID_TIMEZONES).toContain('UTC');
  });

  // validateTenantConfig
  test('validateTenantConfig: null -> invalid', () => {
    const r = validateTenantConfig(null);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  test('validateTenantConfig: array -> invalid', () => {
    const r = validateTenantConfig([]);
    expect(r.valid).toBe(false);
  });

  test('validateTenantConfig: config minima valida', () => {
    const r = validateTenantConfig({ businessName: 'Mi Negocio', timezone: 'America/Bogota' });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('validateTenantConfig: businessName faltante -> error', () => {
    const r = validateTenantConfig({ timezone: 'America/Bogota' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('businessName'))).toBe(true);
  });

  test('validateTenantConfig: language invalido -> error', () => {
    const r = validateTenantConfig({ businessName: 'X', timezone: 'UTC', language: 'zh' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('language'))).toBe(true);
  });

  test('validateTenantConfig: maxMessagesPerHour < min -> error', () => {
    const r = validateTenantConfig({ businessName: 'X', timezone: 'UTC', maxMessagesPerHour: 0 });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('maxMessagesPerHour'))).toBe(true);
  });

  test('validateTenantConfig: autoReply no boolean -> error', () => {
    const r = validateTenantConfig({ businessName: 'X', timezone: 'UTC', autoReply: 'yes' });
    expect(r.valid).toBe(false);
  });

  test('validateTenantConfig: timezone desconocido -> warning (no error)', () => {
    const r = validateTenantConfig({ businessName: 'X', timezone: 'Asia/Tokyo' });
    expect(r.valid).toBe(true); // no es requerido ser de la lista
    expect(r.warnings.some(w => w.includes('timezone'))).toBe(true);
  });

  test('validateTenantConfig: campo desconocido -> warning', () => {
    const r = validateTenantConfig({ businessName: 'X', timezone: 'UTC', hackField: 'x' });
    expect(r.valid).toBe(true);
    expect(r.warnings.some(w => w.includes('hackField'))).toBe(true);
  });

  test('validateTenantConfig: defaults aplicados en normalized', () => {
    const r = validateTenantConfig({ businessName: 'X', timezone: 'UTC' });
    expect(r.normalized.language).toBe('es'); // default
    expect(r.normalized.autoReply).toBe(true); // default
    expect(r.normalized.maxMessagesPerHour).toBe(50); // default
  });

  // validateField
  test('validateField: null + required -> error', () => {
    const err = validateField('name', null, { required: true, type: 'string' });
    expect(err).toMatch(/requerido/);
  });

  test('validateField: null + not required -> null (ok)', () => {
    const err = validateField('optField', null, { required: false, type: 'string' });
    expect(err).toBeNull();
  });

  test('validateField: string demasiado larga -> error', () => {
    const err = validateField('name', 'a'.repeat(101), { type: 'string', maxLength: 100 });
    expect(err).toMatch(/max 100/);
  });
});
