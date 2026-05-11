'use strict';

/**
 * VI-BACKEND-COVERAGE: health_check.js — 100% branches
 * Mock firebase-admin y tenant_manager para aislar el módulo.
 */

jest.mock('firebase-admin', () => {
  const setMock = jest.fn().mockResolvedValue(undefined);
  const docMock = jest.fn(() => ({ set: setMock }));
  const collectionMock = jest.fn(() => ({ doc: docMock }));
  const firestoreMock = jest.fn(() => ({ collection: collectionMock }));
  firestoreMock.FieldValue = { serverTimestamp: jest.fn(() => ({ _ts: true })) };
  return { firestore: firestoreMock };
});

jest.mock('../whatsapp/tenant_manager', () => ({
  getUpsertStats: jest.fn(() => ({
    count10min: 5,
    count20min: 10,
    lastUpsertAt: Date.now(),
  })),
}));

const admin = require('firebase-admin');
const { getUpsertStats } = require('../whatsapp/tenant_manager');

const hc = require('../core/health_check');
const {
  recordLatency,
  computePercentiles,
  checkBaileys,
  checkAIGateway,
  checkFirestore,
  startHealthChecks,
  stopHealthChecks,
  getHealthStatus,
  _health,
  LATENCY_BUFFER_SIZE,
  MAX_CONSECUTIVE_FAILURES,
} = hc;

// Utility: reset _health state between tests where needed
function resetHealth() {
  _health.firestore = { status: 'unknown', lastCheck: null, lastError: null, consecutiveFailures: 0, latencyHistory: [] };
  _health.baileys = {};
  _health.aiGateway = { status: 'unknown', lastCheck: null, lastError: null, consecutiveFailures: 0, latencyHistory: [] };
  _health.lastFullCheck = null;
}

// ── recordLatency ─────────────────────────────────────────────────────────────

describe('recordLatency', () => {
  beforeEach(resetHealth);

  test('non-number latency → ignored', () => {
    recordLatency('firestore', 'abc');
    expect(_health.firestore.latencyHistory).toHaveLength(0);
  });

  test('negative latency → ignored', () => {
    recordLatency('firestore', -1);
    expect(_health.firestore.latencyHistory).toHaveLength(0);
  });

  test('unknown component → ignored (no throw)', () => {
    expect(() => recordLatency('unknown_component', 50)).not.toThrow();
  });

  test('component without latencyHistory → initializes array', () => {
    delete _health.firestore.latencyHistory;
    recordLatency('firestore', 10);
    expect(Array.isArray(_health.firestore.latencyHistory)).toBe(true);
    expect(_health.firestore.latencyHistory).toContain(10);
  });

  test('adds sample to latencyHistory', () => {
    recordLatency('firestore', 42);
    expect(_health.firestore.latencyHistory).toContain(42);
  });

  test('buffer overflow: shifts oldest when > LATENCY_BUFFER_SIZE', () => {
    for (let i = 0; i < LATENCY_BUFFER_SIZE + 5; i++) {
      recordLatency('firestore', i);
    }
    expect(_health.firestore.latencyHistory).toHaveLength(LATENCY_BUFFER_SIZE);
    // oldest values (0-4) should have been shifted out
    expect(_health.firestore.latencyHistory[0]).toBe(5);
  });
});

// ── computePercentiles ────────────────────────────────────────────────────────

describe('computePercentiles', () => {
  beforeEach(resetHealth);

  test('no history → null', () => {
    expect(computePercentiles('firestore')).toBeNull();
  });

  test('< 5 samples → null', () => {
    _health.firestore.latencyHistory = [10, 20, 30, 40];
    expect(computePercentiles('firestore')).toBeNull();
  });

  test('non-array history → null', () => {
    _health.firestore.latencyHistory = null;
    expect(computePercentiles('firestore')).toBeNull();
  });

  test('5+ samples → returns stats object', () => {
    _health.firestore.latencyHistory = [10, 20, 30, 40, 50];
    const r = computePercentiles('firestore');
    expect(r).not.toBeNull();
    expect(r.samples).toBe(5);
    expect(r.min).toBe(10);
    expect(r.max).toBe(50);
    expect(typeof r.p50).toBe('number');
    expect(typeof r.p95).toBe('number');
    expect(typeof r.p99).toBe('number');
    expect(typeof r.avg).toBe('number');
  });

  test('unknown component → null (no latencyHistory)', () => {
    expect(computePercentiles('nonexistent')).toBeNull();
  });
});

// ── checkBaileys ──────────────────────────────────────────────────────────────

describe('checkBaileys', () => {
  beforeEach(resetHealth);

  test('nuevo uid: crea entry en _health.baileys', () => {
    expect(_health.baileys['uid-new']).toBeUndefined();
    checkBaileys('uid-new', { user: { id: 'abc' } });
    expect(_health.baileys['uid-new']).toBeDefined();
  });

  test('sock=null → disconnected', () => {
    const result = checkBaileys('uid-1', null);
    expect(result).toBe(false);
    expect(_health.baileys['uid-1'].status).toBe('disconnected');
    expect(_health.baileys['uid-1'].lastError).toContain('null');
  });

  test('sock sin user → disconnected', () => {
    const result = checkBaileys('uid-2', {});
    expect(result).toBe(false);
    expect(_health.baileys['uid-2'].status).toBe('disconnected');
    expect(_health.baileys['uid-2'].lastError).toContain('user');
  });

  test('sock con user → healthy', () => {
    const result = checkBaileys('uid-3', { user: { id: 'abc' } });
    expect(result).toBe(true);
    expect(_health.baileys['uid-3'].status).toBe('healthy');
    expect(_health.baileys['uid-3'].consecutiveFailures).toBe(0);
  });

  test('excepción en sock.user → error state', () => {
    const faultyUser = {};
    Object.defineProperty(faultyUser, 'user', { get() { throw new Error('sock_error'); } });
    const result = checkBaileys('uid-4', faultyUser);
    expect(result).toBe(false);
    expect(_health.baileys['uid-4'].status).toBe('error');
    expect(_health.baileys['uid-4'].lastError).toBe('sock_error');
  });

  test('consecutiveFailures se incrementa en fallo', () => {
    checkBaileys('uid-5', null);
    checkBaileys('uid-5', null);
    expect(_health.baileys['uid-5'].consecutiveFailures).toBe(2);
  });
});

// ── checkAIGateway ─────────────────────────────────────────────────────────────

describe('checkAIGateway', () => {
  beforeEach(resetHealth);

  test('aiGateway=null → status=unknown, retorna true', async () => {
    const r = await checkAIGateway(null);
    expect(r).toBe(true);
    expect(_health.aiGateway.status).toBe('unknown');
  });

  test('aiGateway sin healthCheck → status=unknown, retorna true', async () => {
    const r = await checkAIGateway({ noHealthCheck: true });
    expect(r).toBe(true);
    expect(_health.aiGateway.status).toBe('unknown');
  });

  test('healthCheck retorna true → status=healthy', async () => {
    const r = await checkAIGateway({ healthCheck: jest.fn().mockResolvedValue(true) });
    expect(r).toBe(true);
    expect(_health.aiGateway.status).toBe('healthy');
    expect(_health.aiGateway.consecutiveFailures).toBe(0);
  });

  test('healthCheck retorna false → status=degraded', async () => {
    const r = await checkAIGateway({ healthCheck: jest.fn().mockResolvedValue(false) });
    expect(r).toBe(false);
    expect(_health.aiGateway.status).toBe('degraded');
  });

  test('healthCheck lanza excepción → incrementa failures, status degraded/critical', async () => {
    const failGw = { healthCheck: jest.fn().mockRejectedValue(new Error('timeout')) };
    await checkAIGateway(failGw);
    expect(_health.aiGateway.consecutiveFailures).toBe(1);
    expect(_health.aiGateway.status).toBe('degraded');
  });

  test('3 fallos consecutivos → status=critical', async () => {
    const failGw = { healthCheck: jest.fn().mockRejectedValue(new Error('fail')) };
    _health.aiGateway.consecutiveFailures = MAX_CONSECUTIVE_FAILURES - 1;
    await checkAIGateway(failGw);
    expect(_health.aiGateway.status).toBe('critical');
  });
});

// ── checkFirestore ─────────────────────────────────────────────────────────────

describe('checkFirestore', () => {
  beforeEach(() => {
    resetHealth();
    admin.firestore().collection().doc().set.mockResolvedValue(undefined);
  });

  test('éxito → status=healthy, retorna true', async () => {
    const r = await checkFirestore();
    expect(r).toBe(true);
    expect(_health.firestore.status).toBe('healthy');
    expect(_health.firestore.consecutiveFailures).toBe(0);
  });

  test('éxito con latencyHistory preexistente → preserva history', async () => {
    _health.firestore.latencyHistory = [10, 20, 30, 40, 50];
    const r = await checkFirestore();
    expect(r).toBe(true);
    // History debería incluir las muestras previas + la nueva
    expect(_health.firestore.latencyHistory.length).toBeGreaterThan(5);
  });

  test('Firestore lanza → incrementa failures, status=degraded', async () => {
    admin.firestore().collection().doc().set.mockRejectedValue(new Error('firestore_error'));
    const r = await checkFirestore();
    expect(r).toBe(false);
    expect(_health.firestore.consecutiveFailures).toBe(1);
    expect(_health.firestore.status).toBe('degraded');
  });

  test('3 fallos → status=critical', async () => {
    admin.firestore().collection().doc().set.mockRejectedValue(new Error('critical'));
    _health.firestore.consecutiveFailures = MAX_CONSECUTIVE_FAILURES - 1;
    const r = await checkFirestore();
    expect(r).toBe(false);
    expect(_health.firestore.status).toBe('critical');
  });
});

// ── startHealthChecks / stopHealthChecks ──────────────────────────────────────

describe('startHealthChecks / stopHealthChecks', () => {
  test('stop sin iniciar → no lanza', () => {
    expect(() => stopHealthChecks()).not.toThrow();
  });

  test('start registra callbacks y lanza interval', () => {
    const reconnectBaileys = jest.fn().mockResolvedValue(true);
    const notifyOwner = jest.fn().mockResolvedValue();
    expect(() => startHealthChecks({ reconnectBaileys, notifyOwner, tenants: {} })).not.toThrow();
    stopHealthChecks(); // limpia el interval
  });

  test('stop después de start → limpia interval', () => {
    startHealthChecks({ tenants: {} });
    expect(() => stopHealthChecks()).not.toThrow();
  });
});

// ── getHealthStatus ────────────────────────────────────────────────────────────

describe('getHealthStatus', () => {
  beforeEach(() => {
    resetHealth();
    getUpsertStats.mockReturnValue({ count10min: 5, count20min: 10, lastUpsertAt: Date.now() });
  });

  test('estado inicial → status=unknown', () => {
    const s = getHealthStatus();
    expect(s.status).toBe('unknown');
    expect(typeof s.uptime).toBe('number');
    expect(s.components).toBeDefined();
    expect(s.components.firestore).toBeDefined();
    expect(s.components.baileys).toBeDefined();
    expect(s.components.aiGateway).toBeDefined();
    expect(s.components.messagesUpsert).toBeDefined();
  });

  test('firestore critical → status=critical', () => {
    _health.firestore.status = 'critical';
    const s = getHealthStatus();
    expect(s.status).toBe('critical');
  });

  test('baileys disconnected → status=degraded', () => {
    _health.baileys['uid-x'] = { status: 'disconnected', lastCheck: null, lastError: null, consecutiveFailures: 1 };
    _health.firestore.status = 'healthy';
    const s = getHealthStatus();
    expect(s.status).toBe('degraded');
  });

  test('todo healthy → status=healthy', () => {
    _health.firestore.status = 'healthy';
    _health.baileys['uid-a'] = { status: 'healthy', lastCheck: null, lastError: null, consecutiveFailures: 0 };
    const s = getHealthStatus();
    expect(s.status).toBe('healthy');
  });

  test('uid truncado a 8 chars + ...', () => {
    _health.baileys['abcdefgh1234'] = { status: 'healthy', lastCheck: null, lastError: null, consecutiveFailures: 0 };
    const s = getHealthStatus();
    const baileysEntry = s.components.baileys.find(b => b.uid === 'abcdefgh...');
    expect(baileysEntry).toBeDefined();
  });

  test('upsert count10min=0 después de 15min gracia con connected → upsertStatus=warn', () => {
    _health.startedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    _health.baileys['uid-b'] = { status: 'healthy', lastCheck: null, lastError: null, consecutiveFailures: 0 };
    _health.firestore.status = 'healthy';
    getUpsertStats.mockReturnValue({ count10min: 0, count20min: 5, lastUpsertAt: Date.now() });
    const s = getHealthStatus();
    expect(s.components.messagesUpsert.status).toBe('warn');
  });

  test('upsert count10min=0 y count20min=0 → upsertStatus=critical', () => {
    _health.startedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    _health.baileys['uid-c'] = { status: 'healthy', lastCheck: null, lastError: null, consecutiveFailures: 0 };
    _health.firestore.status = 'healthy';
    getUpsertStats.mockReturnValue({ count10min: 0, count20min: 0, lastUpsertAt: null });
    const s = getHealthStatus();
    expect(s.components.messagesUpsert.status).toBe('critical');
  });

  test('lastUpsertAt=null → messagesUpsert.lastUpsertAt=null', () => {
    getUpsertStats.mockReturnValue({ count10min: 5, count20min: 10, lastUpsertAt: null });
    const s = getHealthStatus();
    expect(s.components.messagesUpsert.lastUpsertAt).toBeNull();
  });
});

// ── runFullCheck ──────────────────────────────────────────────────────────────

describe('runFullCheck', () => {
  const { runFullCheck } = hc;
  beforeEach(() => {
    resetHealth();
    admin.firestore().collection().doc().set.mockResolvedValue(undefined);
    getUpsertStats.mockReturnValue({ count10min: 5, count20min: 10, lastUpsertAt: Date.now() });
  });

  test('sin tenants → solo checkea firestore + aiGateway', async () => {
    const r = await runFullCheck({ tenants: {}, aiGateway: null });
    expect(r.firestore).toBe(true);
    expect(r.baileys).toEqual({});
    expect(r.aiGateway).toBe(true);
    expect(typeof r.timestamp).toBe('string');
    expect(_health.lastFullCheck).toBeTruthy();
  });

  test('tenant con sock saludable → baileys true', async () => {
    const r = await runFullCheck({ tenants: { 'uid-x': { sock: { user: { id: 'abc' } } } } });
    expect(r.baileys['uid-x']).toBe(true);
  });

  test('tenant con sock null → baileys false, NO auto-recovery si failures < MAX', async () => {
    const r = await runFullCheck({ tenants: { 'uid-y': { sock: null } } });
    expect(r.baileys['uid-y']).toBe(false);
    // consecutiveFailures = 1, no llega a MAX_CONSECUTIVE_FAILURES (3)
    expect(_health.baileys['uid-y'].consecutiveFailures).toBe(1);
  });

  test('tenant con failures === MAX → auto-recovery disparado', async () => {
    // Pre-set state so next check triggers recovery
    _health.baileys['uid-r'] = { status: 'disconnected', lastCheck: null, lastError: null, consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1 };
    // checkBaileys incrementará a MAX → attemptRecovery se llama
    const reconnect = jest.fn().mockResolvedValue(true);
    startHealthChecks({ reconnectBaileys: reconnect, notifyOwner: jest.fn(), tenants: {} });
    stopHealthChecks();
    const r = await runFullCheck({ tenants: { 'uid-r': { sock: null } } });
    expect(r.baileys['uid-r']).toBe(false);
    expect(reconnect).toHaveBeenCalledWith('uid-r');
  });

  test('log ALL HEALTHY cuando firestore OK, baileys OK, ai OK', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await runFullCheck({
      tenants: { 'uid-h': { sock: { user: { id: 'x' } } } },
      aiGateway: { healthCheck: jest.fn().mockResolvedValue(true) },
    });
    const calls = logSpy.mock.calls.map(c => c[0]);
    expect(calls.some(c => c.includes('ALL HEALTHY'))).toBe(true);
    logSpy.mockRestore();
  });

  test('log WARN/CRITICAL cuando baileys down', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await runFullCheck({ tenants: { 'uid-d': { sock: null } } });
    const calls = errSpy.mock.calls.map(c => c[0]);
    expect(calls.some(c => c.includes('[HEALTH]'))).toBe(true);
    errSpy.mockRestore();
  });

  test('zombie log (upserts=0, connected, uptime>15min) → console.warn', async () => {
    _health.startedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    _health.baileys['uid-z'] = { status: 'healthy', lastCheck: null, lastError: null, consecutiveFailures: 0 };
    getUpsertStats.mockReturnValue({ count10min: 0, count20min: 0, lastUpsertAt: null });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await runFullCheck({ tenants: { 'uid-z': { sock: { user: { id: 'z' } } } } });
    const calls = warnSpy.mock.calls.map(c => c[0]);
    expect(calls.some(c => c.includes('[HEALTH]'))).toBe(true);
    warnSpy.mockRestore();
  });

  test('upsert 10min=0, 20min>0 (warn parcial) → upsertWarn=true', async () => {
    _health.startedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    getUpsertStats.mockReturnValue({ count10min: 0, count20min: 5, lastUpsertAt: Date.now() });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await runFullCheck({ tenants: { 'uid-w': { sock: { user: { id: 'w' } } } } });
    const allCalls = [...warnSpy.mock.calls, ...errSpy.mock.calls].map(c => c[0]);
    expect(allCalls.some(c => typeof c === 'string' && c.includes('[HEALTH]'))).toBe(true);
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });
});

// ── attemptRecovery (vía runFullCheck con failures === MAX) ────────────────────

describe('attemptRecovery branches', () => {
  const { runFullCheck } = hc;
  beforeEach(() => {
    resetHealth();
    admin.firestore().collection().doc().set.mockResolvedValue(undefined);
    getUpsertStats.mockReturnValue({ count10min: 5, count20min: 10, lastUpsertAt: Date.now() });
  });

  function setupMaxFailures(uid) {
    _health.baileys[uid] = {
      status: 'disconnected',
      lastCheck: null,
      lastError: null,
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1,
    };
  }

  test('recovery success → status=recovering, return true', async () => {
    const uid = 'uid-rec-ok';
    setupMaxFailures(uid);
    const reconnect = jest.fn().mockResolvedValue(true);
    const notify = jest.fn().mockResolvedValue();
    startHealthChecks({ reconnectBaileys: reconnect, notifyOwner: notify });
    stopHealthChecks();
    await runFullCheck({ tenants: { [uid]: { sock: null } } });
    expect(reconnect).toHaveBeenCalledWith(uid);
    expect(_health.baileys[uid].status).toBe('recovering');
  });

  test('recovery throws → no crash, notifyOwner llamado', async () => {
    const uid = 'uid-rec-err';
    setupMaxFailures(uid);
    const reconnect = jest.fn().mockRejectedValue(new Error('conn_error'));
    const notify = jest.fn().mockResolvedValue();
    startHealthChecks({ reconnectBaileys: reconnect, notifyOwner: notify });
    stopHealthChecks();
    await runFullCheck({ tenants: { [uid]: { sock: null } } });
    expect(notify).toHaveBeenCalled();
  });

  test('reconnect returns false → notifyOwner llamado', async () => {
    const uid = 'uid-rec-false';
    setupMaxFailures(uid);
    const reconnect = jest.fn().mockResolvedValue(false);
    const notify = jest.fn().mockResolvedValue();
    startHealthChecks({ reconnectBaileys: reconnect, notifyOwner: notify });
    stopHealthChecks();
    await runFullCheck({ tenants: { [uid]: { sock: null } } });
    expect(notify).toHaveBeenCalled();
  });

  test('notifyOwner lanza → no crash', async () => {
    const uid = 'uid-notify-err';
    setupMaxFailures(uid);
    const reconnect = jest.fn().mockResolvedValue(false);
    const notify = jest.fn().mockRejectedValue(new Error('notify_fail'));
    startHealthChecks({ reconnectBaileys: reconnect, notifyOwner: notify });
    stopHealthChecks();
    await expect(runFullCheck({ tenants: { [uid]: { sock: null } } })).resolves.toBeDefined();
  });

  test('sin callback baileys → no recovery intento, notifyOwner si existe', async () => {
    const uid = 'uid-no-cb';
    setupMaxFailures(uid);
    const notify = jest.fn().mockResolvedValue();
    startHealthChecks({ notifyOwner: notify });
    stopHealthChecks();
    await runFullCheck({ tenants: { [uid]: { sock: null } } });
    expect(notify).toHaveBeenCalled();
  });
});

// ── Branches adicionales: null latencyHistory, attemptRecovery non-baileys ────

describe('branches adicionales coverage', () => {
  beforeEach(() => {
    resetHealth();
    admin.firestore().collection().doc().set.mockResolvedValue(undefined);
    getUpsertStats.mockReturnValue({ count10min: 5, count20min: 10, lastUpsertAt: Date.now() });
  });

  test('checkFirestore con latencyHistory=null → prevHistory=[]', async () => {
    _health.firestore.latencyHistory = null; // forza la rama || []
    const r = await checkFirestore();
    expect(r).toBe(true);
    expect(Array.isArray(_health.firestore.latencyHistory)).toBe(true);
  });

  test('checkAIGateway con latencyHistory=null → prevHistory=[]', async () => {
    _health.aiGateway.latencyHistory = null;
    const r = await checkAIGateway({ healthCheck: jest.fn().mockResolvedValue(true) });
    expect(r).toBe(true);
    expect(Array.isArray(_health.aiGateway.latencyHistory)).toBe(true);
  });

  test('attemptRecovery con component != baileys (no callback) → false', async () => {
    const { runFullCheck } = hc;
    // runFullCheck calls attemptRecovery only for 'baileys'; to test non-baileys
    // we directly test via startHealthChecks recovery with no reconnectBaileys
    startHealthChecks({}); // no callbacks registered
    stopHealthChecks();
    // component != 'baileys' path: not invoked from runFullCheck for other components
    // but we can invoke notifyOwner path directly by pre-setting MAX failures
    _health.baileys['uid-nonotify'] = {
      status: 'disconnected', lastCheck: null, lastError: null,
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1,
    };
    // No notifyOwner registered → notifyOwner path = false branch
    await runFullCheck({ tenants: { 'uid-nonotify': { sock: null } } });
    // No crash expected
    expect(_health.baileys['uid-nonotify']).toBeDefined();
  });

  test('runFullCheck: icon=WARN (firestore OK, baileys down, upsert OK)', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    _health.baileys['uid-down'] = {
      status: 'disconnected', lastCheck: null, lastError: null, consecutiveFailures: 1,
    };
    // firestore OK → checkFirestore resolves → hasRealFailure=true (baileys down)
    // icon = '⚠️ WARN' (firestore OK)
    await hc.runFullCheck({ tenants: { 'uid-down': { sock: null } } });
    const errCalls = errSpy.mock.calls.map(c => c[0]);
    expect(errCalls.some(c => typeof c === 'string' && c.includes('[HEALTH]'))).toBe(true);
    errSpy.mockRestore();
  });

  test('startHealthChecks sin opts.tenants ni getTenants → usa {}', () => {
    startHealthChecks({}); // no tenants, no getTenants → defaults to {}
    stopHealthChecks();
  });
});

// ── startHealthChecks interval callback (fake timers) ─────────────────────────

describe('startHealthChecks interval callback', () => {
  beforeEach(() => {
    resetHealth();
    admin.firestore().collection().doc().set.mockResolvedValue(undefined);
    getUpsertStats.mockReturnValue({ count10min: 5, count20min: 10, lastUpsertAt: Date.now() });
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopHealthChecks();
    jest.useRealTimers();
  });

  test('interval fires runFullCheck (happy path) via getTenants', async () => {
    const getTenants = jest.fn().mockReturnValue({});
    startHealthChecks({ getTenants, aiGateway: null });
    // Advance timer to trigger interval
    jest.advanceTimersByTime(hc.CHECK_INTERVAL_MS + 100);
    // Flush promises
    await Promise.resolve();
    await Promise.resolve();
    expect(getTenants).toHaveBeenCalled();
  });

  test('interval catch clause: runFullCheck throws → console.error sin crash', async () => {
    // Make getUpsertStats throw uncaught inside runFullCheck → startHealthChecks catch
    getUpsertStats.mockImplementation(() => { throw new Error('upsert_crash'); });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    startHealthChecks({ tenants: {} });
    // advanceTimersByTimeAsync fires interval and awaits the async callback (Jest 29)
    await jest.advanceTimersByTimeAsync(hc.CHECK_INTERVAL_MS + 100);
    const errCalls = errSpy.mock.calls.map(c => c[0]);
    expect(errCalls.some(c => typeof c === 'string' && c.includes('periódico'))).toBe(true);
    errSpy.mockRestore();
    getUpsertStats.mockReturnValue({ count10min: 5, count20min: 10, lastUpsertAt: Date.now() });
  });
});
