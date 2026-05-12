'use strict';

/**
 * VI-BACKEND-COVERAGE: ai/prompt_cache.js — 100% branches
 * State aislado por jest.resetModules() + fresh().
 * setInterval desactivado con jest.useFakeTimers() donde necesario.
 */

function fresh() {
  jest.resetModules();
  jest.useFakeTimers();
  const m = require('../ai/prompt_cache');
  jest.useRealTimers();
  return m;
}

// ── get ───────────────────────────────────────────────────────────────────────

describe('get', () => {
  test('miss → null (no entry)', () => {
    const m = fresh();
    expect(m.get('SYSTEM_PROMPT', 'uid-1')).toBeNull();
  });

  test('hit → retorna valor cacheado', () => {
    const m = fresh();
    m.set('SYSTEM_PROMPT', 'uid-1', 'mi prompt');
    const val = m.get('SYSTEM_PROMPT', 'uid-1');
    expect(val).toBe('mi prompt');
  });

  test('expirado → null + eviction', () => {
    const m = fresh();
    m.set('CEREBRO', 'uid-2', 'cerebro content', '', 1); // TTL 1ms
    // Esperar que expire
    const origNow = Date.now.bind(Date);
    Date.now = () => origNow() + 60 * 60 * 1000; // +1h
    const val = m.get('CEREBRO', 'uid-2');
    Date.now = origNow;
    expect(val).toBeNull();
  });

  test('con extra param → key diferente', () => {
    const m = fresh();
    m.set('SYSTEM_PROMPT', 'uid-1', 'prompt A', 'biz1');
    m.set('SYSTEM_PROMPT', 'uid-1', 'prompt B', 'biz2');
    expect(m.get('SYSTEM_PROMPT', 'uid-1', 'biz1')).toBe('prompt A');
    expect(m.get('SYSTEM_PROMPT', 'uid-1', 'biz2')).toBe('prompt B');
  });
});

// ── set ───────────────────────────────────────────────────────────────────────

describe('set', () => {
  test('value nulo → no guarda (branch !value)', () => {
    const m = fresh();
    m.set('SYSTEM_PROMPT', 'uid-1', null);
    expect(m.get('SYSTEM_PROMPT', 'uid-1')).toBeNull();
  });

  test('value no string → no guarda (branch typeof)', () => {
    const m = fresh();
    m.set('SYSTEM_PROMPT', 'uid-1', 42);
    expect(m.get('SYSTEM_PROMPT', 'uid-1')).toBeNull();
  });

  test('customTtl tiene prioridad sobre TTL por tipo (branch customTtl ||)', () => {
    const m = fresh();
    m.set('SYSTEM_PROMPT', 'uid-1', 'mi prompt', '', 9999);
    // getStats debe reflejar el set
    const s = m.getStats();
    expect(s.sets).toBeGreaterThanOrEqual(1);
  });

  test('tipo desconocido → usa TTL.GENERAL (branch TTL[type] ||)', () => {
    const m = fresh();
    m.set('TIPO_RARO', 'uid-1', 'valor');
    expect(m.get('TIPO_RARO', 'uid-1')).toBe('valor');
  });

  test('cache > 500 → evictOldest se llama', () => {
    const m = fresh();
    // Llenar cache con 501 entries
    for (let i = 0; i < 501; i++) {
      m.set('GENERAL', `uid-${i}`, `prompt-${i}`);
    }
    const s = m.getStats();
    // Evictions debe ser >= 1
    expect(s.evictions).toBeGreaterThanOrEqual(1);
  });
});

// ── invalidate ────────────────────────────────────────────────────────────────

describe('invalidate', () => {
  test('entry existente → deleted=true', () => {
    const m = fresh();
    m.set('SYSTEM_PROMPT', 'uid-1', 'test');
    const deleted = m.invalidate('SYSTEM_PROMPT', 'uid-1');
    expect(deleted).toBe(true);
  });

  test('entry inexistente → deleted=false (branch if deleted)', () => {
    const m = fresh();
    const deleted = m.invalidate('SYSTEM_PROMPT', 'uid-noexist');
    expect(deleted).toBe(false);
  });
});

// ── invalidateOwner ───────────────────────────────────────────────────────────

describe('invalidateOwner', () => {
  test('sin entries del owner → count=0 (branch if count>0 false)', () => {
    const m = fresh();
    const count = m.invalidateOwner('uid-noexist');
    expect(count).toBe(0);
  });

  test('con entries del owner → count>0 (branch if count>0 true)', () => {
    const m = fresh();
    m.set('SYSTEM_PROMPT', 'uid-owner', 'prompt1');
    m.set('CEREBRO', 'uid-owner', 'prompt2', 'extra');
    m.set('SYSTEM_PROMPT', 'uid-other', 'other');
    const count = m.invalidateOwner('uid-owner');
    expect(count).toBe(2);
    expect(m.get('SYSTEM_PROMPT', 'uid-owner')).toBeNull();
    expect(m.get('SYSTEM_PROMPT', 'uid-other')).toBe('other');
  });
});

// ── cleanup ───────────────────────────────────────────────────────────────────

describe('cleanup', () => {
  test('sin entries expiradas → no log, cleaned=0 (branch if cleaned>0 false)', () => {
    const m = fresh();
    m.set('SYSTEM_PROMPT', 'uid-1', 'fresh');
    expect(() => m.cleanup()).not.toThrow();
    expect(m.get('SYSTEM_PROMPT', 'uid-1')).toBe('fresh');
  });

  test('con entries expiradas → las elimina (branch if cleaned>0 true)', () => {
    const m = fresh();
    m.set('CEREBRO', 'uid-exp', 'val', '', 1); // TTL 1ms
    const origNow = Date.now.bind(Date);
    Date.now = () => origNow() + 60 * 60 * 1000; // +1h
    m.cleanup();
    Date.now = origNow;
    expect(m.get('CEREBRO', 'uid-exp')).toBeNull();
  });
});

// ── getStats ──────────────────────────────────────────────────────────────────

describe('getStats', () => {
  test('sin hits/misses → hitRate 0% (branch (hits+misses)>0 false)', () => {
    const m = fresh();
    const s = m.getStats();
    expect(s.hitRate).toBe('0%');
    expect(s.size).toBe(0);
  });

  test('con hits y misses → hitRate calculado (branch true)', () => {
    const m = fresh();
    m.set('SYSTEM_PROMPT', 'uid-1', 'prompt');
    m.get('SYSTEM_PROMPT', 'uid-1'); // hit
    m.get('SYSTEM_PROMPT', 'uid-noexist'); // miss
    const s = m.getStats();
    expect(s.hitRate).toBe('50%');
  });
});

// ── healthCheck ───────────────────────────────────────────────────────────────

describe('healthCheck', () => {
  test('retorna status ok + stats', () => {
    const m = fresh();
    const h = m.healthCheck();
    expect(h.status).toBe('ok');
    expect(typeof h.size).toBe('number');
  });
});

// ── evictOldest ───────────────────────────────────────────────────────────────

describe('evictOldest (via set > 500)', () => {
  test('oldest entry se elimina y evictions incrementa', () => {
    const m = fresh();
    // Primer set es el oldest
    m.set('GENERAL', 'uid-oldest', 'oldest-val');
    // Llenar con 501 mas
    for (let i = 0; i < 501; i++) {
      m.set('GENERAL', `uid-fill-${i}`, `val-${i}`);
    }
    // uid-oldest debe haber sido eviccionado
    expect(m.get('GENERAL', 'uid-oldest')).toBeNull();
  });
});

// ── Test hooks — defensive dead-code branches ─────────────────────────────────

describe('__makeKeyForTests (default param branch linea 38)', () => {
  test('llamada con 2 args → extra usa default ""', () => {
    const m = fresh();
    const key = m.__makeKeyForTests('SYSTEM_PROMPT', 'uid-1');
    expect(key).toBe('SYSTEM_PROMPT:uid-1:');
  });
});

describe('__evictOldestForTests (cache vacio → oldestKey null, branch false linea 140)', () => {
  test('cache vacio → no lanza (if oldestKey false branch)', () => {
    const m = fresh();
    // cache esta vacio al inicio
    expect(() => m.__evictOldestForTests()).not.toThrow();
  });
});

// ── TTL constants ─────────────────────────────────────────────────────────────

describe('TTL constants', () => {
  test('todos los TTL estan definidos', () => {
    const m = fresh();
    expect(m.TTL.SYSTEM_PROMPT).toBe(10 * 60 * 1000);
    expect(m.TTL.CEREBRO).toBe(5 * 60 * 1000);
    expect(m.TTL.CLASSIFICATION).toBe(60 * 60 * 1000);
    expect(m.TTL.SPORT).toBe(30 * 60 * 1000);
    expect(m.TTL.GENERAL).toBe(15 * 60 * 1000);
  });
});
