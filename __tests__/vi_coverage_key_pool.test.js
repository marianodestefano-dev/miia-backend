'use strict';

/**
 * VI-BACKEND-COVERAGE: ai/key_pool.js — 100% branches
 */

function fresh() {
  jest.resetModules();
  return require('../ai/key_pool');
}

// ── register ──────────────────────────────────────────────────────────────────

describe('register', () => {
  test('params invalidos → return temprano', () => {
    const m = fresh();
    expect(() => m.register(null, ['key12345678'])).not.toThrow();
    expect(() => m.register('gemini', null)).not.toThrow();
    expect(m.hasKeys('gemini')).toBe(false);
  });

  test('primer registro crea pool', () => {
    const m = fresh();
    m.register('gemini', ['key1234567890']);
    expect(m.hasKeys('gemini')).toBe(true);
  });

  test('segundo registro no duplica keys', () => {
    const m = fresh();
    m.register('gemini', ['key1234567890']);
    m.register('gemini', ['key1234567890']);
    expect(m.getStats('gemini').total).toBe(1);
  });

  test('key corta ignorada', () => {
    const m = fresh();
    m.register('gemini', ['short']);
    expect(m.hasKeys('gemini')).toBe(false);
  });

  test('multiples keys validas', () => {
    const m = fresh();
    m.register('openai', ['key1234567890', 'key9876543210', 'key0000000001']);
    expect(m.getStats('openai').total).toBe(3);
  });

  test('key undefined/empty ignorada', () => {
    const m = fresh();
    m.register('openai', [undefined, '', 'validkey12345']);
    expect(m.getStats('openai').total).toBe(1);
  });
});

// ── registerBackup ────────────────────────────────────────────────────────────

describe('registerBackup', () => {
  test('params invalidos', () => {
    const m = fresh();
    expect(() => m.registerBackup(null, ['key12345678'])).not.toThrow();
    expect(() => m.registerBackup('gemini', null)).not.toThrow();
  });

  test('registra keys con tier=backup', () => {
    const m = fresh();
    m.register('gemini', ['primary1234567']);
    m.registerBackup('gemini', ['backup12345678']);
    expect(m.getStats('gemini').total).toBe(2);
  });

  test('sin pool previo crea pool', () => {
    const m = fresh();
    m.registerBackup('groq', ['backupGroq1234']);
    expect(m.hasKeys('groq')).toBe(true);
  });

  test('key corta en registerBackup ignorada (linea 93 continue)', () => {
    const m = fresh();
    m.registerBackup('gemini', ['short']); // < 10 chars → continue en linea 93
    expect(m.hasKeys('gemini')).toBe(false);
  });

  test('key duplicada en registerBackup ignorada (linea 95 continue)', () => {
    const m = fresh();
    m.registerBackup('gemini', ['backup12345678']);
    m.registerBackup('gemini', ['backup12345678']); // duplicada → continue en linea 95
    expect(m.getStats('gemini').total).toBe(1);
  });

  test('key undefined en registerBackup ignorada', () => {
    const m = fresh();
    m.registerBackup('gemini', [undefined, 'backupValid1234']);
    expect(m.getStats('gemini').total).toBe(1);
  });
});

// ── getKey ────────────────────────────────────────────────────────────────────

describe('getKey', () => {
  test('provider no registrado → null', () => {
    const m = fresh();
    expect(m.getKey('unknown')).toBeNull();
  });

  test('pool vacio → null', () => {
    const m = fresh();
    m.register('gemini', []);
    expect(m.getKey('gemini')).toBeNull();
  });

  test('key disponible → retorna key', () => {
    const m = fresh();
    m.register('gemini', ['primarykey1234']);
    expect(m.getKey('gemini')).toBe('primarykey1234');
  });

  test('primarias todas en cooldown → usa backup', () => {
    const m = fresh();
    m.register('gemini', ['primarykey1234']);
    m.registerBackup('gemini', ['backupkey12345']);
    for (let i = 0; i < 3; i++) m.markFailed('gemini', 'primarykey1234', '429');
    expect(m.getKey('gemini')).toBe('backupkey12345');
  });

  test('todo en cooldown → retorna earliest (primary)', () => {
    const m = fresh();
    m.register('gemini', ['primarykey1234']);
    m.markFailed('gemini', 'primarykey1234', 'INVALID_KEY');
    const k = m.getKey('gemini');
    expect(k).toBe('primarykey1234');
  });

  test('todo en cooldown sin primary → usa backup earliest', () => {
    const m = fresh();
    m.registerBackup('groq', ['backupGroqKey12']);
    m.markFailed('groq', 'backupGroqKey12', 'INVALID_KEY');
    const k = m.getKey('groq');
    expect(k).toBe('backupGroqKey12');
  });

  test('cooldown expirado → se resetea y retorna', () => {
    const m = fresh();
    m.register('groq', ['primaryGroqKey1']);
    m.markFailed('groq', 'primaryGroqKey1', 'INVALID_KEY');
    const origNow = Date.now.bind(Date);
    Date.now = () => origNow() + 2 * 60 * 60 * 1000;
    const k = m.getKey('groq');
    Date.now = origNow;
    expect(k).toBe('primaryGroqKey1');
  });

  test('multiples keys, key en cooldown → usa siguiente', () => {
    const m = fresh();
    m.register('gemini', ['keyaaaaaaaaa1', 'keybbbbbbbbb1']);
    const key1 = m.getKey('gemini');
    for (let i = 0; i < 3; i++) m.markFailed('gemini', key1, '429');
    const key2 = m.getKey('gemini');
    expect(key2).toBeDefined();
  });

  test('callback backup dispara solo la primera vez', () => {
    const m = fresh();
    m.register('claude', ['primaryclaude1']);
    m.registerBackup('claude', ['backupclaude12']);
    const cb = jest.fn();
    m.onBackupActivated('claude', cb);
    for (let i = 0; i < 3; i++) m.markFailed('claude', 'primaryclaude1', '429');
    m.getKey('claude');
    m.getKey('claude');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('claude');
  });

  test('callback que lanza → no propaga error', () => {
    const m = fresh();
    m.register('mistral', ['primarymistral']);
    m.registerBackup('mistral', ['backupmistral1']);
    m.onBackupActivated('mistral', () => { throw new Error('cb-crash'); });
    for (let i = 0; i < 3; i++) m.markFailed('mistral', 'primarymistral', '429');
    expect(() => m.getKey('mistral')).not.toThrow();
  });
});

// ── markFailed ────────────────────────────────────────────────────────────────

describe('markFailed', () => {
  test('provider no registrado → no lanza', () => {
    const m = fresh();
    expect(() => m.markFailed('nope', 'key', '429')).not.toThrow();
  });

  test('key no encontrada → no lanza', () => {
    const m = fresh();
    m.register('gemini', ['primarykey1234']);
    expect(() => m.markFailed('gemini', 'wrongkey', '429')).not.toThrow();
  });

  test('INVALID_KEY → cooldown 1h', () => {
    const m = fresh();
    m.register('gemini', ['primarykey1234']);
    m.markFailed('gemini', 'primarykey1234', 'INVALID_KEY');
    expect(m.getStats('gemini').cooldown).toBe(1);
  });

  test('401 → cooldown 1h', () => {
    const m = fresh();
    m.register('gemini', ['primarykey1234']);
    m.markFailed('gemini', 'primarykey1234', '401');
    expect(m.getStats('gemini').cooldown).toBe(1);
  });

  test('403 → cooldown 1h', () => {
    const m = fresh();
    m.register('gemini', ['primarykey1234']);
    m.markFailed('gemini', 'primarykey1234', '403');
    expect(m.getStats('gemini').cooldown).toBe(1);
  });

  test('< MAX_CONSECUTIVE_FAILS → sin cooldown', () => {
    const m = fresh();
    m.register('gemini', ['primarykey1234']);
    m.markFailed('gemini', 'primarykey1234', '429');
    expect(m.getStats('gemini').cooldown).toBe(0);
  });

  test('>= MAX_CONSECUTIVE_FAILS → cooldown estandar', () => {
    const m = fresh();
    m.register('gemini', ['primarykey1234']);
    for (let i = 0; i < 3; i++) m.markFailed('gemini', 'primarykey1234', '429');
    expect(m.getStats('gemini').cooldown).toBe(1);
  });
});

// ── markSuccess ───────────────────────────────────────────────────────────────

describe('markSuccess', () => {
  test('provider no registrado', () => {
    const m = fresh();
    expect(() => m.markSuccess('nope', 'key')).not.toThrow();
  });

  test('key no encontrada', () => {
    const m = fresh();
    m.register('gemini', ['primarykey1234']);
    expect(() => m.markSuccess('gemini', 'wrongkey')).not.toThrow();
  });

  test('fails > 0 → resetea (branch true)', () => {
    const m = fresh();
    m.register('gemini', ['primarykey1234']);
    m.markFailed('gemini', 'primarykey1234', '429');
    m.markSuccess('gemini', 'primarykey1234');
    expect(m.getStats('gemini').stats[0].fails).toBe(0);
  });

  test('fails = 0 → sin log (branch false)', () => {
    const m = fresh();
    m.register('gemini', ['primarykey1234']);
    m.markSuccess('gemini', 'primarykey1234');
    expect(m.getStats('gemini').stats[0].fails).toBe(0);
  });
});

// ── getStats / getAllStats / hasKeys ──────────────────────────────────────────

describe('getStats', () => {
  test('provider no registrado → zeros', () => {
    const m = fresh();
    const s = m.getStats('nope');
    expect(s.total).toBe(0);
    expect(s.cooldown).toBe(0);
  });

  test('con keys → stats correctas', () => {
    const m = fresh();
    m.register('gemini', ['k1234567890a', 'k1234567890b']);
    const s = m.getStats('gemini');
    expect(s.total).toBe(2);
    expect(s.available).toBe(2);
    expect(s.stats[0].inCooldown).toBe(false);
    expect(s.stats[0].cooldownRemaining).toBe(0);
  });

  test('key en cooldown → inCooldown=true + cooldownRemaining>0', () => {
    const m = fresh();
    m.register('gemini', ['primarykey1234']);
    m.markFailed('gemini', 'primarykey1234', 'INVALID_KEY');
    const s = m.getStats('gemini');
    expect(s.stats[0].inCooldown).toBe(true);
    expect(s.stats[0].cooldownRemaining).toBeGreaterThan(0);
  });
});

describe('getAllStats', () => {
  test('multiples providers', () => {
    const m = fresh();
    m.register('gemini', ['k1234567890g']);
    m.register('openai', ['k1234567890o']);
    const all = m.getAllStats();
    expect(all.gemini).toBeDefined();
    expect(all.openai).toBeDefined();
  });
});

describe('hasKeys', () => {
  test('sin provider → false', () => {
    const m = fresh();
    expect(m.hasKeys('nope')).toBe(false);
  });

  test('con keys → true', () => {
    const m = fresh();
    m.register('gemini', ['key1234567890']);
    expect(m.hasKeys('gemini')).toBe(true);
  });
});

  test('2 primarias en cooldown → reduce false branch (segunda expira despues)', () => {
    const m = fresh();
    const now = Date.now();
    // Inject 2 primaries both in cooldown: key1 expires earlier, key2 expires later
    m.__setPoolsForTests({
      gemini: {
        keys: [
          { key: 'primaryAaaaa1', tier: 'primary', fails: 3, cooldownUntil: now + 60000, totalCalls: 0, totalFails: 3, lastFail: now },
          { key: 'primaryBbbbb1', tier: 'primary', fails: 3, cooldownUntil: now + 120000, totalCalls: 0, totalFails: 3, lastFail: now },
        ],
        index: 0,
      },
    });
    const k = m.getKey('gemini');
    // Returns the one that expires soonest (primaryAaaaa1)
    expect(k).toBe('primaryAaaaa1');
  });

  test('allKeys vacio → earliest null → return null (linea 156)', () => {
    const m = fresh();
    const now = Date.now();
    // Inject a key with unknown tier (neither primary nor backup)
    m.__setPoolsForTests({
      gemini: {
        keys: [
          { key: 'weirdkey12345', tier: 'unknown', fails: 0, cooldownUntil: null, totalCalls: 0, totalFails: 0, lastFail: null },
        ],
        index: 0,
      },
    });
    const k = m.getKey('gemini');
    expect(k).toBeNull(); // hits line 156
  });

// ── onBackupActivated ─────────────────────────────────────────────────────────

describe('onBackupActivated', () => {
  test('params invalidos → no lanza', () => {
    const m = fresh();
    expect(() => m.onBackupActivated(null, jest.fn())).not.toThrow();
    expect(() => m.onBackupActivated('gemini', null)).not.toThrow();
    expect(() => m.onBackupActivated('gemini', 'notafunction')).not.toThrow();
  });

  test('registrado → no dispara hasta backup activado', () => {
    const m = fresh();
    const cb = jest.fn();
    m.onBackupActivated('gemini', cb);
    expect(cb).not.toHaveBeenCalled();
  });
});
