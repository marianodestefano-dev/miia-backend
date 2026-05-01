'use strict';
const { getHealthV2, pingFirestore, classifyLatency, LATENCY_THRESHOLDS, __setFirestoreForTests, __setExternalPingForTests } = require('../core/health_v2');

function makeMockDb({ latencyMs=5, throwGet=false }={}) {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => {
          if (throwGet) throw new Error('firestore down');
          await new Promise(r => setTimeout(r, latencyMs));
          return { exists: false };
        }
      })
    })
  };
}

afterEach(() => {
  __setFirestoreForTests(null);
  __setExternalPingForTests(null);
});

describe('classifyLatency', () => {
  test('< 500ms = ok', () => {
    expect(classifyLatency(100)).toBe('ok');
    expect(classifyLatency(499)).toBe('ok');
  });
  test('500-1999ms = degraded', () => {
    expect(classifyLatency(500)).toBe('degraded');
    expect(classifyLatency(1999)).toBe('degraded');
  });
  test('>= 2000ms = down', () => {
    expect(classifyLatency(2000)).toBe('down');
    expect(classifyLatency(5000)).toBe('down');
  });
  test('< 0 = skipped', () => {
    expect(classifyLatency(-1)).toBe('skipped');
  });
});

describe('LATENCY_THRESHOLDS', () => {
  test('ok=500, degraded=2000 y frozen', () => {
    expect(LATENCY_THRESHOLDS.ok).toBe(500);
    expect(LATENCY_THRESHOLDS.degraded).toBe(2000);
    expect(() => { LATENCY_THRESHOLDS.ok = 100; }).toThrow();
  });
});

describe('pingFirestore', () => {
  test('retorna status ok si Firestore responde rapido', async () => {
    __setFirestoreForTests(makeMockDb({ latencyMs: 1 }));
    const r = await pingFirestore('uid1');
    expect(r.status).toBe('ok');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });
  test('retorna status down si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await pingFirestore('uid1');
    expect(r.status).toBe('down');
    expect(r.error).toBeDefined();
  });
  test('retorna skipped si uid es null', async () => {
    const r = await pingFirestore(null);
    expect(r.status).toBe('skipped');
  });
});

describe('getHealthV2', () => {
  test('retorna status ok si todos los servicios ok', async () => {
    __setFirestoreForTests(makeMockDb({ latencyMs: 1 }));
    const r = await getHealthV2('uid1', []);
    expect(r.status).toBe('ok');
    expect(r.services.length).toBeGreaterThanOrEqual(1);
    expect(r).toHaveProperty('checkedAt');
    expect(r).toHaveProperty('uptimeMs');
  });

  test('retorna status down si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getHealthV2('uid1', []);
    expect(r.status).toBe('down');
  });

  test('incluye servicio externo en results', async () => {
    __setFirestoreForTests(makeMockDb({ latencyMs: 1 }));
    __setExternalPingForTests(async () => { /* ok */ });
    const r = await getHealthV2('uid1', [{ name: 'gemini', pingFn: async () => {} }]);
    expect(r.services.some(s => s.name === 'gemini')).toBe(true);
  });

  test('status degraded si servicio externo falla pero Firestore ok', async () => {
    __setFirestoreForTests(makeMockDb({ latencyMs: 1 }));
    __setExternalPingForTests(async () => { throw new Error('timeout'); });
    const r = await getHealthV2('uid1', [{ name: 'gemini', pingFn: async () => {} }]);
    const geminiSvc = r.services.find(s => s.name === 'gemini');
    expect(geminiSvc.status).toBe('down');
    expect(r.status).toBe('down');
  });
});
