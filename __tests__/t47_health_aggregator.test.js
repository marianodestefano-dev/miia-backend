'use strict';

/**
 * T47 — health_aggregator.js coverage tests
 */

const ha = require('../core/health_aggregator');

// ═════════════════════════════════════════════════════════════════
// §A — checkBaileys
// ═════════════════════════════════════════════════════════════════

describe('T47 §A — checkBaileys', () => {
  test('sin tenantManager → status unknown', async () => {
    const r = await ha.checkBaileys(null);
    expect(r.status).toBe('unknown');
  });

  test('tenant_manager con .tenants Map → cuenta correctamente', async () => {
    const tenants = new Map();
    tenants.set('uid1', { isReady: true, lastError: null });
    tenants.set('uid2', { isReady: true });
    tenants.set('uid3', { isReady: false });
    tenants.set('uid4', { lastError: new Error('boom') });
    const tm = { tenants };
    const r = await ha.checkBaileys(tm);
    // 2 online de 4 (uid1, uid2) + 1 errored (uid4) + 1 offline (uid3) → ratio 0.5 → degraded
    expect(r.status).toBe('degraded');
    expect(r.online).toBe(2);
    expect(r.errored).toBe(1);
    expect(r.offline).toBe(1);
    expect(r.total).toBe(4);
  });

  test('todos online → status ok', async () => {
    const tm = { getAllTenants: () => [{ isReady: true }, { isReady: true }] };
    const r = await ha.checkBaileys(tm);
    expect(r.status).toBe('ok');
    expect(r.online).toBe(2);
    expect(r.total).toBe(2);
  });

  test('mitad online → degraded', async () => {
    const tm = { getAllTenants: () => [{ isReady: true }, { isReady: false }, { isReady: true }, { isReady: false }] };
    const r = await ha.checkBaileys(tm);
    expect(r.status).toBe('degraded');
  });

  test('mayoria offline → critical', async () => {
    const tm = { getAllTenants: () => [{ isReady: true }, { isReady: false }, { isReady: false }, { isReady: false }] };
    const r = await ha.checkBaileys(tm);
    expect(r.status).toBe('critical');
  });

  test('tenant con cryptoErrorCount > 5 → errored', async () => {
    const tm = { getAllTenants: () => [{ isReady: true, cryptoErrorCount: 10 }] };
    const r = await ha.checkBaileys(tm);
    expect(r.errored).toBe(1);
  });

  test('lista vacía → status idle', async () => {
    const tm = { getAllTenants: () => [] };
    const r = await ha.checkBaileys(tm);
    expect(r.status).toBe('idle');
    expect(r.total).toBe(0);
  });

  test('tenant_manager con array directo', async () => {
    const tm = { getAllTenants: [{ isReady: true }] };
    const r = await ha.checkBaileys(tm);
    // array no es function ni Map → fallback unknown
    expect(['ok', 'unknown']).toContain(r.status);
  });

  test('getAllTenants throw → status error', async () => {
    const tm = { getAllTenants: () => { throw new Error('boom'); } };
    const r = await ha.checkBaileys(tm);
    expect(r.status).toBe('error');
    expect(r.error).toBe('boom');
  });

  test('API no reconocida → unknown', async () => {
    const tm = { weirdField: 123 };
    const r = await ha.checkBaileys(tm);
    expect(r.status).toBe('unknown');
  });
});

// ═════════════════════════════════════════════════════════════════
// §B — checkAI
// ═════════════════════════════════════════════════════════════════

describe('T47 §B — checkAI', () => {
  test('sin shield → unknown', async () => {
    const r = await ha.checkAI(null);
    expect(r.status).toBe('unknown');
  });

  test('circuit cerrado → ok', async () => {
    const shield = {
      SYSTEMS: { GEMINI: 'gemini' },
      isCircuitOpen: () => false,
      getHealthDashboard: () => ({ healthy: true }),
    };
    const r = await ha.checkAI(shield);
    expect(r.status).toBe('ok');
    expect(r.circuit_open).toBe(false);
    expect(r.dashboard_available).toBe(true);
  });

  test('circuit abierto → critical', async () => {
    const shield = {
      SYSTEMS: { GEMINI: 'gemini' },
      isCircuitOpen: () => true,
      getHealthDashboard: () => null,
    };
    const r = await ha.checkAI(shield);
    expect(r.status).toBe('critical');
    expect(r.circuit_open).toBe(true);
  });

  test('shield throw → status error', async () => {
    const shield = {
      isCircuitOpen: () => { throw new Error('fail'); },
    };
    const r = await ha.checkAI(shield);
    expect(r.status).toBe('error');
  });
});

// ═════════════════════════════════════════════════════════════════
// §C — checkFirestore
// ═════════════════════════════════════════════════════════════════

describe('T47 §C — checkFirestore', () => {
  test('sin client → unknown', async () => {
    const r = await ha.checkFirestore(null);
    expect(r.status).toBe('unknown');
  });

  test('probe ok → status ok + latency_ms', async () => {
    const fs = {
      collection: () => ({
        limit: () => ({
          get: () => Promise.resolve({ docs: [] }),
        }),
      }),
    };
    const r = await ha.checkFirestore(fs);
    expect(r.status).toBe('ok');
    expect(typeof r.latency_ms).toBe('number');
    expect(r.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test('probe rejected → status error', async () => {
    const fs = {
      collection: () => ({
        limit: () => ({
          get: () => Promise.reject(new Error('fs down')),
        }),
      }),
    };
    const r = await ha.checkFirestore(fs);
    expect(r.status).toBe('error');
    expect(r.error).toBe('fs down');
  });

  test('probe collection custom', async () => {
    let collArg = null;
    const fs = {
      collection: (name) => { collArg = name; return { limit: () => ({ get: () => Promise.resolve({}) }) }; },
    };
    await ha.checkFirestore(fs, '_my_probe');
    expect(collArg).toBe('_my_probe');
  });
});

// ═════════════════════════════════════════════════════════════════
// §D — checkProcess
// ═════════════════════════════════════════════════════════════════

describe('T47 §D — checkProcess', () => {
  test('retorna metadata válida', () => {
    const r = ha.checkProcess();
    expect(r.status).toBe('ok');
    expect(typeof r.uptime_s).toBe('number');
    expect(typeof r.memory_mb.rss).toBe('number');
    expect(typeof r.memory_mb.heapUsed).toBe('number');
    expect(typeof r.memory_mb.heapTotal).toBe('number');
    expect(r.node_version).toMatch(/^v\d+/);
  });
});

// ═════════════════════════════════════════════════════════════════
// §E — aggregateHealth (integración)
// ═════════════════════════════════════════════════════════════════

describe('T47 §E — aggregateHealth', () => {
  test('todos los subsistemas ok → status overall ok', async () => {
    const tm = { getAllTenants: () => [{ isReady: true }] };
    const shield = {
      SYSTEMS: { GEMINI: 'gemini' },
      isCircuitOpen: () => false,
      getHealthDashboard: () => ({}),
    };
    const fs = {
      collection: () => ({ limit: () => ({ get: () => Promise.resolve({}) }) }),
    };
    const r = await ha.aggregateHealth({ tenantManager: tm, shield, firestoreClient: fs });
    expect(r.status).toBe('ok');
    expect(r.subsystems.baileys.status).toBe('ok');
    expect(r.subsystems.ai.status).toBe('ok');
    expect(r.subsystems.firestore.status).toBe('ok');
    expect(r.subsystems.process.status).toBe('ok');
    expect(typeof r.duration_ms).toBe('number');
    expect(typeof r.timestamp).toBe('string');
  });

  test('un subsistema critical → overall critical', async () => {
    const shield = {
      SYSTEMS: { GEMINI: 'gemini' },
      isCircuitOpen: () => true,
      getHealthDashboard: () => null,
    };
    const r = await ha.aggregateHealth({ shield });
    expect(r.status).toBe('critical');
  });

  test('un subsistema error → overall error', async () => {
    const fs = {
      collection: () => ({ limit: () => ({ get: () => Promise.reject(new Error('x')) }) }),
    };
    const r = await ha.aggregateHealth({ firestoreClient: fs });
    expect(r.status).toBe('error');
  });

  test('sin deps → reporta unknown en cada sub', async () => {
    const r = await ha.aggregateHealth({});
    expect(r.subsystems.baileys.status).toBe('unknown');
    expect(r.subsystems.ai.status).toBe('unknown');
    expect(r.subsystems.firestore.status).toBe('unknown');
    expect(r.subsystems.process.status).toBe('ok');
  });
});

// ═════════════════════════════════════════════════════════════════
// §F — withTimeout
// ═════════════════════════════════════════════════════════════════

describe('T47 §F — withTimeout', () => {
  test('promesa que resuelve antes del timeout pasa', async () => {
    const r = await ha.withTimeout(Promise.resolve('ok'), 1000, 'test');
    expect(r).toBe('ok');
  });
  test('promesa que tarda más del timeout rechaza', async () => {
    const slow = new Promise(resolve => setTimeout(() => resolve('late'), 200));
    await expect(ha.withTimeout(slow, 50, 'slow')).rejects.toThrow(/timeout/);
  });
});
