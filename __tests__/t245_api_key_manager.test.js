'use strict';

const {
  createAPIKey, revokeAPIKey, rotateAPIKey, getAPIKeys, validateAPIKey,
  buildAPIKeyRecord, generateRawKey, hashKey, hasScope, buildKeyInfoText, validateScopes,
  isValidStatus, isValidScope,
  KEY_STATUSES, KEY_SCOPES, KEY_PREFIX, MAX_KEYS_PER_TENANT,
  DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS, RATE_LIMIT_PER_MINUTE,
  __setFirestoreForTests,
} = require('../core/api_key_manager');

const UID = 'testUid1234567890';

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
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return {
              forEach: fn => Object.entries(db_stored).forEach(([id, data]) => fn({ data: () => data })),
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
  test('KEY_STATUSES tiene 4', () => { expect(KEY_STATUSES.length).toBe(4); });
  test('frozen KEY_STATUSES', () => { expect(() => { KEY_STATUSES.push('x'); }).toThrow(); });
  test('KEY_SCOPES tiene 8', () => { expect(KEY_SCOPES.length).toBe(8); });
  test('frozen KEY_SCOPES', () => { expect(() => { KEY_SCOPES.push('x'); }).toThrow(); });
  test('KEY_PREFIX es miia_', () => { expect(KEY_PREFIX).toBe('miia_'); });
  test('MAX_KEYS_PER_TENANT es 5', () => { expect(MAX_KEYS_PER_TENANT).toBe(5); });
  test('DEFAULT_EXPIRY_DAYS es 365', () => { expect(DEFAULT_EXPIRY_DAYS).toBe(365); });
  test('MAX_EXPIRY_DAYS es 730', () => { expect(MAX_EXPIRY_DAYS).toBe(730); });
  test('RATE_LIMIT_PER_MINUTE es 60', () => { expect(RATE_LIMIT_PER_MINUTE).toBe(60); });
});

describe('isValidStatus / isValidScope / validateScopes', () => {
  test('active es status valido', () => { expect(isValidStatus('active')).toBe(true); });
  test('deleted no es valido', () => { expect(isValidStatus('deleted')).toBe(false); });
  test('read_conversations es scope valido', () => { expect(isValidScope('read_conversations')).toBe(true); });
  test('write_code no es scope valido', () => { expect(isValidScope('write_code')).toBe(false); });
  test('validateScopes lanza si no es array', () => {
    expect(() => validateScopes('read_conversations')).toThrow('debe ser array');
  });
  test('validateScopes lanza si scope invalido', () => {
    expect(() => validateScopes(['read_conversations', 'hack'])).toThrow('invalidos');
  });
  test('validateScopes no lanza con scopes validos', () => {
    expect(() => validateScopes(['read_conversations', 'manage_catalog'])).not.toThrow();
  });
});

describe('generateRawKey / hashKey', () => {
  test('generateRawKey empieza con KEY_PREFIX', () => {
    const key = generateRawKey();
    expect(key).toMatch(/^miia_[a-f0-9]+$/);
  });
  test('hashKey retorna hex 64 chars', () => {
    const h = hashKey('miia_test1234');
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
  test('mismo rawKey produce mismo hash', () => {
    expect(hashKey('miia_abc')).toBe(hashKey('miia_abc'));
  });
  test('diferentes rawKeys producen diferentes hashes', () => {
    expect(hashKey('miia_abc')).not.toBe(hashKey('miia_xyz'));
  });
});

describe('buildAPIKeyRecord', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildAPIKeyRecord(undefined, 'miia_abc')).toThrow('uid requerido');
  });
  test('lanza si rawKey undefined', () => {
    expect(() => buildAPIKeyRecord(UID, undefined)).toThrow('rawKey requerido');
  });
  test('lanza si scope invalido', () => {
    expect(() => buildAPIKeyRecord(UID, 'miia_abc', { scopes: ['hack'] })).toThrow('invalidos');
  });
  test('construye record con defaults', () => {
    const rawKey = generateRawKey();
    const r = buildAPIKeyRecord(UID, rawKey);
    expect(r.keyId).toMatch(/^key_/);
    expect(r.uid).toBe(UID);
    expect(r.keyHash).toBeDefined();
    expect(r.keyPrefix).toContain('miia_');
    expect(r.scopes).toEqual(['read_conversations']);
    expect(r.status).toBe('active');
    expect(r.usageCount).toBe(0);
    expect(r.expiresAt).toBeDefined();
  });
  test('expiry se limita a MAX_EXPIRY_DAYS', () => {
    const rawKey = generateRawKey();
    const r = buildAPIKeyRecord(UID, rawKey, { expiryDays: 1000 });
    const diffDays = (new Date(r.expiresAt) - new Date(r.createdAt)) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeLessThanOrEqual(MAX_EXPIRY_DAYS + 1);
  });
});

describe('createAPIKey', () => {
  test('lanza si uid undefined', async () => {
    await expect(createAPIKey(undefined)).rejects.toThrow('uid requerido');
  });
  test('crea key y retorna rawKey', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await createAPIKey(UID, { scopes: ['read_conversations', 'manage_catalog'], name: 'Test Key' });
    expect(r.rawKey).toMatch(/^miia_/);
    expect(r.record.scopes).toContain('read_conversations');
    expect(r.record.name).toBe('Test Key');
  });
  test('lanza si maximo de keys activas alcanzado', async () => {
    const stored = {};
    for (let i = 0; i < MAX_KEYS_PER_TENANT; i++) {
      stored['key_' + i] = { keyId: 'key_' + i, status: 'active' };
    }
    __setFirestoreForTests(makeMockDb({ stored }));
    await expect(createAPIKey(UID)).rejects.toThrow('maximo');
  });
  test('keys revocadas no bloquean el limite', async () => {
    const stored = {};
    for (let i = 0; i < MAX_KEYS_PER_TENANT; i++) {
      stored['key_' + i] = { keyId: 'key_' + i, status: 'revoked' };
    }
    __setFirestoreForTests(makeMockDb({ stored }));
    const r = await createAPIKey(UID);
    expect(r.rawKey).toMatch(/^miia_/);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(createAPIKey(UID)).rejects.toThrow('set error');
  });
});

describe('revokeAPIKey', () => {
  test('lanza si uid undefined', async () => {
    await expect(revokeAPIKey(undefined, 'key1')).rejects.toThrow('uid requerido');
  });
  test('lanza si keyId undefined', async () => {
    await expect(revokeAPIKey(UID, undefined)).rejects.toThrow('keyId requerido');
  });
  test('revoca sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(revokeAPIKey(UID, 'key1')).resolves.toBeUndefined();
  });
});

describe('rotateAPIKey', () => {
  test('lanza si uid undefined', async () => {
    await expect(rotateAPIKey(undefined, 'key1')).rejects.toThrow('uid requerido');
  });
  test('lanza si key no encontrada', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(rotateAPIKey(UID, 'noexiste')).rejects.toThrow('no encontrada');
  });
  test('lanza si key no activa', async () => {
    __setFirestoreForTests(makeMockDb({ stored: { 'key1': { keyId: 'key1', status: 'revoked', scopes: ['read_conversations'] } } }));
    await expect(rotateAPIKey(UID, 'key1')).rejects.toThrow('activa');
  });
  test('rota key activa exitosamente', async () => {
    __setFirestoreForTests(makeMockDb({ stored: { 'key1': { keyId: 'key1', status: 'active', scopes: ['read_conversations'], name: 'Mi Key' } } }));
    const r = await rotateAPIKey(UID, 'key1');
    expect(r.rawKey).toMatch(/^miia_/);
    expect(r.record.status).toBe('active');
  });
});

describe('getAPIKeys', () => {
  test('lanza si uid undefined', async () => {
    await expect(getAPIKeys(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay keys', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getAPIKeys(UID)).toEqual([]);
  });
  test('filtra por status', async () => {
    const stored = {
      'key1': { keyId: 'key1', status: 'active' },
      'key2': { keyId: 'key2', status: 'revoked' },
    };
    __setFirestoreForTests(makeMockDb({ stored }));
    const r = await getAPIKeys(UID, { status: 'active' });
    expect(r.length).toBe(1);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getAPIKeys(UID)).toEqual([]);
  });
});

describe('validateAPIKey', () => {
  test('lanza si uid undefined', async () => {
    await expect(validateAPIKey(undefined, 'miia_abc')).rejects.toThrow('uid requerido');
  });
  test('retorna invalid si key null', async () => {
    const r = await validateAPIKey(UID, null);
    expect(r.valid).toBe(false);
  });
  test('retorna invalid si formato incorrecto', async () => {
    const r = await validateAPIKey(UID, 'wrong_prefix_key');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('formato');
  });
  test('retorna valid si key correcta y activa', async () => {
    __setFirestoreForTests(makeMockDb());
    const created = await createAPIKey(UID, { scopes: ['read_conversations'] });
    const r = await validateAPIKey(UID, created.rawKey);
    expect(r.valid).toBe(true);
    expect(r.scopes).toContain('read_conversations');
  });
  test('retorna invalid si key revocada', async () => {
    const rawKey = generateRawKey();
    const record = buildAPIKeyRecord(UID, rawKey);
    record.status = 'revoked';
    __setFirestoreForTests(makeMockDb({ stored: { [record.keyId]: record } }));
    const r = await validateAPIKey(UID, rawKey);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('revoked');
  });
  test('retorna invalid si key expirada', async () => {
    const rawKey = generateRawKey();
    const record = buildAPIKeyRecord(UID, rawKey);
    record.expiresAt = new Date(Date.now() - 1000).toISOString();
    __setFirestoreForTests(makeMockDb({ stored: { [record.keyId]: record } }));
    const r = await validateAPIKey(UID, rawKey);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('expirada');
  });
});

describe('hasScope / buildKeyInfoText', () => {
  test('hasScope full_access permite cualquier scope', () => {
    const record = { scopes: ['full_access'] };
    expect(hasScope(record, 'manage_catalog')).toBe(true);
    expect(hasScope(record, 'send_broadcast')).toBe(true);
  });
  test('hasScope verifica scope especifico', () => {
    const record = { scopes: ['read_conversations', 'manage_catalog'] };
    expect(hasScope(record, 'read_conversations')).toBe(true);
    expect(hasScope(record, 'send_broadcast')).toBe(false);
  });
  test('hasScope false si record null', () => {
    expect(hasScope(null, 'read_conversations')).toBe(false);
  });
  test('buildKeyInfoText incluye informacion clave', () => {
    const rawKey = generateRawKey();
    const record = buildAPIKeyRecord(UID, rawKey, { name: 'Mi API', scopes: ['read_conversations'] });
    const text = buildKeyInfoText(record);
    expect(text).toContain('Mi API');
    expect(text).toContain(record.keyId);
    expect(text).toContain('read_conversations');
    expect(text).toContain('active');
  });
  test('buildKeyInfoText vacio si null', () => {
    expect(buildKeyInfoText(null)).toBe('');
  });
});
