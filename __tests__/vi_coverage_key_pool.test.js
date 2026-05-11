'use strict';

/**
 * VI-BACKEND-COVERAGE: ai/key_pool.js — 100% branches
 * Usa __setPoolsForTests() para aislar estado global entre tests.
 */

const kp = require('../ai/key_pool');

const VALID_KEY = 'sk-test-valid-key-xxxxxxxxxxxx';
const VALID_KEY2 = 'sk-test-valid-key-yyyyyyyyyyyy';
const BACKUP_KEY = 'sk-test-backup-key-zzzzzzzzzzzz';

beforeEach(() => {
  kp.__setPoolsForTests({});
});

describe('register', () => {
  test('!provider → return (branch !provider)', () => {
    kp.register('', [VALID_KEY]);
    expect(kp.hasKeys('')).toBe(false);
  });

  test('!Array.isArray(keys) → return (branch !Array.isArray)', () => {
    kp.register('gemini', 'not-an-array');
    expect(kp.hasKeys('gemini')).toBe(false);
  });

  test('pool ya existe → agrega sin recrear (branch !pools[provider] false)', () => {
    kp.register('gemini', [VALID_KEY]);
    kp.register('gemini', [VALID_KEY2]);
    expect(kp.getStats('gemini').total).toBe(2);
  });

  test('key null → skip (branch !key)', () => {
    kp.register('gemini', [null, VALID_KEY]);
    expect(kp.getStats('gemini').total).toBe(1);
  });

  test('key no string → skip (branch typeof)', () => {
    kp.register('gemini', [42, VALID_KEY]);
    expect(kp.getStats('gemini').total).toBe(1);
  });

  test('key < 10 chars → skip (branch length < 10)', () => {
    kp.register('gemini', ['short', VALID_KEY]);
    expect(kp.getStats('gemini').total).toBe(1);
  });

  test('key duplicada → skip (branch existingKeys.has)', () => {
    kp.register('gemini', [VALID_KEY, VALID_KEY]);
    expect(kp.getStats('gemini').total).toBe(1);
  });

  test('key valida → registrada', () => {
    kp.register('gemini', [VALID_KEY]);
    expect(kp.hasKeys('gemini')).toBe(true);
  });
});

describe('registerBackup', () => {
  test('!provider → return', () => {
    kp.registerBackup('', [BACKUP_KEY]);
    expect(kp.hasKeys('')).toBe(false);
  });

  test('!Array.isArray → return', () => {
    kp.registerBackup('claude', 'not-array');
    expect(kp.hasKeys('claude')).toBe(false);
  });

  test('sin pool existente → crea pool (branch !pools[provider])', () => {
    kp.registerBackup('groq', [BACKUP_KEY]);
    expect(kp.hasKeys('groq')).toBe(true);
  });

  test('pool existente → agrega (branch !pools[provider] false)', () => {
    kp.register('openai', [VALID_KEY]);
    kp.registerBackup('openai', [BACKUP_KEY]);
    expect(kp.getStats('openai').total).toBe(2);
  });

  test('key corta → skip', () => {
    kp.registerBackup('groq', ['short', BACKUP_KEY]);
    expect(kp.getStats('groq').total).toBe(1);
  });

  test('key duplicada → skip', () => {
    kp.register('openai', [VALID_KEY]);
    kp.registerBackup('openai', [VALID_KEY]);
    expect(kp.getStats('openai').total).toBe(1);
  });
});

describe('hasKeys', () => {
  test('sin pool → false', () => expect(kp.hasKeys('nonexistent')).toBe(false));

  test('pool vacio → false', () => {
    kp.__setPoolsForTests({ mistral: { keys: [], index: 0 } });
    expect(kp.hasKeys('mistral')).toBe(false);
  });

  test('pool con keys → true', () => {
    kp.register('gemini', [VALID_KEY]);
    expect(kp.hasKeys('gemini')).toBe(true);
  });
});

describe('getKey', () => {
  test('sin pool → null (branch !pool)', () => {
    expect(kp.getKey('nonexistent')).toBeNull();
  });

  test('pool vacio → null (branch keys.length === 0)', () => {
    kp.__setPoolsForTests({ gemini: { keys: [], index: 0 } });
    expect(kp.getKey('gemini')).toBeNull();
  });

  test('primary disponible → retorna key (FASE 1)', () => {
    kp.register('gemini', [VALID_KEY]);
    expect(kp.getKey('gemini')).toBe(VALID_KEY.trim());
  });

  test('primary en cooldown, backup disponible → FASE 2: usa backup + callback', () => {
    const now = Date.now();
    kp.__setPoolsForTests({
      gemini: {
        keys: [
          { key: VALID_KEY, fails: 3, lastFail: now, cooldownUntil: now + 60000, totalCalls: 0, totalFails: 3, tier: 'primary' },
          { key: BACKUP_KEY, fails: 0, lastFail: null, cooldownUntil: null, totalCalls: 0, totalFails: 0, tier: 'backup' },
        ],
        index: 0,
      }
    });
    const callbackFn = jest.fn();
    kp.onBackupActivated('gemini', callbackFn);
    const key = kp.getKey('gemini');
    expect(key).toBe(BACKUP_KEY);
    expect(callbackFn).toHaveBeenCalledWith('gemini');
  });

  test('callback ya notificado → no dispara 2da vez (branch entry.notified true)', () => {
    const now = Date.now();
    kp.__setPoolsForTests({
      gemini: {
        keys: [
          { key: VALID_KEY, fails: 3, cooldownUntil: now + 60000, totalCalls: 0, totalFails: 3, tier: 'primary' },
          { key: BACKUP_KEY, fails: 0, cooldownUntil: null, totalCalls: 0, totalFails: 0, tier: 'backup' },
        ],
        index: 0,
      }
    });
    const cb = jest.fn();
    kp.onBackupActivated('gemini', cb);
    kp.getKey('gemini'); // primera vez
    kp.getKey('gemini'); // segunda → notified=true → no dispara
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('callback que lanza error → catch (branch try/catch)', () => {
    const now = Date.now();
    kp.__setPoolsForTests({
      gemini: {
        keys: [
          { key: VALID_KEY, fails: 3, cooldownUntil: now + 60000, totalCalls: 0, totalFails: 3, tier: 'primary' },
          { key: BACKUP_KEY, fails: 0, cooldownUntil: null, totalCalls: 0, totalFails: 0, tier: 'backup' },
        ],
        index: 0,
      }
    });
    kp.onBackupActivated('gemini', () => { throw new Error('cb error'); });
    expect(() => kp.getKey('gemini')).not.toThrow();
  });

  test('sin backup registrado + _fireBackupCallback sin entry → no error (branch !entry)', () => {
    const now = Date.now();
    kp.__setPoolsForTests({
      mistral: {
        keys: [
          { key: VALID_KEY, fails: 3, cooldownUntil: now + 60000, totalCalls: 0, totalFails: 3, tier: 'primary' },
          { key: BACKUP_KEY, fails: 0, cooldownUntil: null, totalCalls: 0, totalFails: 0, tier: 'backup' },
        ],
        index: 0,
      }
    });
    expect(() => kp.getKey('mistral')).not.toThrow();
  });

  test('FASE 3: allKeys vacío (tier desconocido) → null (branch if(earliest) false → line 156)', () => {
    kp.__setPoolsForTests({
      gemini: {
        keys: [
          { key: VALID_KEY, fails: 0, cooldownUntil: null, totalCalls: 0, totalFails: 0, tier: 'unknown_tier' },
        ],
        index: 0,
      }
    });
    expect(kp.getKey('gemini')).toBeNull();
  });

  test('FASE 3: todas primarias en cooldown → retorna la que expira antes', () => {
    const now = Date.now();
    kp.__setPoolsForTests({
      gemini: {
        keys: [
          { key: VALID_KEY, fails: 3, cooldownUntil: now + 5000, totalCalls: 0, totalFails: 3, tier: 'primary' },
          { key: VALID_KEY2, fails: 3, cooldownUntil: now + 30000, totalCalls: 0, totalFails: 3, tier: 'primary' },
        ],
        index: 0,
      }
    });
    const key = kp.getKey('gemini');
    expect(key).toBe(VALID_KEY.trim()); // menor cooldown
  });

  test('FASE 3: solo backups en cooldown → allKeys=backupKeys (branch primaryKeys.length === 0)', () => {
    const now = Date.now();
    kp.__setPoolsForTests({
      gemini: {
        keys: [
          { key: BACKUP_KEY, fails: 3, cooldownUntil: now + 5000, totalCalls: 0, totalFails: 3, tier: 'backup' },
        ],
        index: 0,
      }
    });
    const key = kp.getKey('gemini');
    expect(key).toBe(BACKUP_KEY);
  });

  test('cooldown expirado → reset y retorna key (branch cooldownUntil && now >= cooldownUntil)', () => {
    const expired = Date.now() - 1000;
    kp.__setPoolsForTests({
      gemini: {
        keys: [
          { key: VALID_KEY, fails: 2, cooldownUntil: expired, totalCalls: 0, totalFails: 2, tier: 'primary' },
        ],
        index: 0,
      }
    });
    const key = kp.getKey('gemini');
    expect(key).toBe(VALID_KEY.trim());
    expect(kp.getStats('gemini').stats[0].inCooldown).toBe(false);
  });
});

describe('markFailed', () => {
  test('!pool → return', () => {
    expect(() => kp.markFailed('nonexistent', VALID_KEY, '429')).not.toThrow();
  });

  test('!entry → return (key no encontrada)', () => {
    kp.register('gemini', [VALID_KEY]);
    expect(() => kp.markFailed('gemini', 'wrong-key', '429')).not.toThrow();
  });

  test('reason INVALID_KEY → cooldown 1h', () => {
    kp.register('gemini', [VALID_KEY]);
    kp.markFailed('gemini', VALID_KEY.trim(), 'INVALID_KEY');
    expect(kp.getStats('gemini').stats[0].inCooldown).toBe(true);
    expect(kp.getStats('gemini').stats[0].cooldownRemaining).toBeGreaterThan(3500);
  });

  test('reason 401 → cooldown 1h (branch 401)', () => {
    kp.register('gemini', [VALID_KEY]);
    kp.markFailed('gemini', VALID_KEY.trim(), '401');
    expect(kp.getStats('gemini').stats[0].inCooldown).toBe(true);
  });

  test('reason 403 → cooldown 1h (branch 403)', () => {
    kp.register('gemini', [VALID_KEY]);
    kp.markFailed('gemini', VALID_KEY.trim(), '403');
    expect(kp.getStats('gemini').stats[0].inCooldown).toBe(true);
  });

  test('fails >= MAX_CONSECUTIVE_FAILS → cooldown 5min', () => {
    kp.register('gemini', [VALID_KEY]);
    const k = VALID_KEY.trim();
    kp.markFailed('gemini', k, '429'); // fails=1
    kp.markFailed('gemini', k, '429'); // fails=2
    kp.markFailed('gemini', k, '429'); // fails=3 >= MAX=3 → cooldown
    expect(kp.getStats('gemini').stats[0].inCooldown).toBe(true);
    expect(kp.getStats('gemini').stats[0].cooldownRemaining).toBeLessThanOrEqual(300);
  });

  test('fails < MAX, reason no inválida → solo warn, sin cooldown (else branch)', () => {
    kp.register('gemini', [VALID_KEY]);
    kp.markFailed('gemini', VALID_KEY.trim(), '429'); // fails=1 < 3
    expect(kp.getStats('gemini').stats[0].inCooldown).toBe(false);
  });
});

describe('markSuccess', () => {
  test('!pool → return', () => {
    expect(() => kp.markSuccess('nonexistent', VALID_KEY)).not.toThrow();
  });

  test('!entry → return', () => {
    kp.register('gemini', [VALID_KEY]);
    expect(() => kp.markSuccess('gemini', 'wrong-key')).not.toThrow();
  });

  test('entry.fails > 0 → log + reset (branch fails > 0)', () => {
    kp.register('gemini', [VALID_KEY]);
    const k = VALID_KEY.trim();
    kp.markFailed('gemini', k, '429'); // fails=1
    kp.markSuccess('gemini', k);
    expect(kp.getStats('gemini').stats[0].fails).toBe(0);
  });

  test('entry.fails === 0 → reset sin log (branch fails === 0)', () => {
    kp.register('gemini', [VALID_KEY]);
    kp.markSuccess('gemini', VALID_KEY.trim());
    expect(kp.getStats('gemini').stats[0].fails).toBe(0);
  });
});

describe('getStats', () => {
  test('!pool → {total:0,...} (branch !pool)', () => {
    const s = kp.getStats('nonexistent');
    expect(s.total).toBe(0);
    expect(s.stats).toEqual([]);
  });

  test('key sin cooldown → cooldownRemaining=0 (branch k.cooldownUntil ? ... : 0)', () => {
    kp.register('gemini', [VALID_KEY]);
    const s = kp.getStats('gemini');
    expect(s.stats[0].cooldownRemaining).toBe(0);
  });

  test('key con cooldown → cooldownRemaining > 0', () => {
    kp.register('gemini', [VALID_KEY]);
    kp.markFailed('gemini', VALID_KEY.trim(), '401');
    const s = kp.getStats('gemini');
    expect(s.stats[0].cooldownRemaining).toBeGreaterThan(0);
    expect(s.stats[0].inCooldown).toBe(true);
  });
});

describe('getAllStats', () => {
  test('sin providers → {}', () => {
    expect(Object.keys(kp.getAllStats())).toHaveLength(0);
  });

  test('con providers → tiene ambos', () => {
    kp.register('gemini', [VALID_KEY]);
    kp.register('openai', [VALID_KEY2]);
    const s = kp.getAllStats();
    expect(s.gemini).toBeDefined();
    expect(s.openai).toBeDefined();
  });
});

describe('onBackupActivated', () => {
  test('!provider → return (branch !provider)', () => {
    expect(() => kp.onBackupActivated('', jest.fn())).not.toThrow();
  });

  test('typeof callback !== function → return (branch typeof)', () => {
    expect(() => kp.onBackupActivated('gemini', 'not-a-fn')).not.toThrow();
  });

  test('params validos → registra callback', () => {
    const cb = jest.fn();
    expect(() => kp.onBackupActivated('claude', cb)).not.toThrow();
  });
});
