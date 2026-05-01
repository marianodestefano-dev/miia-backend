'use strict';

const {
  recordHealthCheck, getComponentHealth, getSystemHealthSummary,
  assessWhatsAppHealth, generateHealthAlert,
  isValidComponent, isValidStatus,
  HEALTH_COMPONENTS, HEALTH_STATUSES, ALERT_LEVELS,
  DISCONNECT_THRESHOLD_MS, HEALTH_HISTORY_LIMIT, CHECK_INTERVAL_MS,
  __setFirestoreForTests,
} = require('../core/health_monitor');

const UID = 'testUid1234567890';

function makeMockDb({ docs = [], throwSet = false, throwGet = false } = {}) {
  const docsMap = {};
  docs.forEach(d => { docsMap[d.id || ('doc_' + Math.random())] = d; });
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            set: async (data) => { if (throwSet) throw new Error('set error'); },
          }),
          where: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const items = Object.entries(docsMap).map(([id, data]) => ({ id, data: () => data }));
              return { forEach: fn => items.forEach(fn) };
            },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('Constantes', () => {
  test('HEALTH_COMPONENTS tiene 7 componentes', () => { expect(HEALTH_COMPONENTS.length).toBe(7); });
  test('HEALTH_STATUSES tiene 4 valores', () => { expect(HEALTH_STATUSES.length).toBe(4); });
  test('frozen HEALTH_COMPONENTS', () => { expect(() => { HEALTH_COMPONENTS.push('x'); }).toThrow(); });
  test('DISCONNECT_THRESHOLD_MS es 10 minutos', () => { expect(DISCONNECT_THRESHOLD_MS).toBe(10 * 60 * 1000); });
  test('HEALTH_HISTORY_LIMIT es 100', () => { expect(HEALTH_HISTORY_LIMIT).toBe(100); });
  test('CHECK_INTERVAL_MS es 5 minutos', () => { expect(CHECK_INTERVAL_MS).toBe(5 * 60 * 1000); });
  test('ALERT_LEVELS tiene CRITICAL, WARNING, INFO', () => {
    expect(ALERT_LEVELS.CRITICAL).toBe('critical');
    expect(ALERT_LEVELS.WARNING).toBe('warning');
    expect(ALERT_LEVELS.INFO).toBe('info');
  });
});

describe('isValidComponent e isValidStatus', () => {
  test('whatsapp es componente valido', () => { expect(isValidComponent('whatsapp')).toBe(true); });
  test('unknown no es componente valido', () => { expect(isValidComponent('unknown')).toBe(false); });
  test('healthy es status valido', () => { expect(isValidStatus('healthy')).toBe(true); });
  test('bad no es status valido', () => { expect(isValidStatus('bad')).toBe(false); });
});

describe('recordHealthCheck', () => {
  test('lanza si uid undefined', async () => {
    await expect(recordHealthCheck(undefined, 'whatsapp', 'healthy')).rejects.toThrow('uid requerido');
  });
  test('lanza si component undefined', async () => {
    await expect(recordHealthCheck(UID, undefined, 'healthy')).rejects.toThrow('component requerido');
  });
  test('lanza si component invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordHealthCheck(UID, 'nope', 'healthy')).rejects.toThrow('component invalido');
  });
  test('lanza si status invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordHealthCheck(UID, 'whatsapp', 'bad')).rejects.toThrow('status invalido');
  });
  test('registra sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await recordHealthCheck(UID, 'whatsapp', 'healthy', { latencyMs: 120 });
    expect(r.docId).toBeDefined();
    expect(r.record.status).toBe('healthy');
    expect(r.record.latencyMs).toBe(120);
  });
  test('registra con message', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await recordHealthCheck(UID, 'gemini', 'degraded', { message: 'alta latencia' });
    expect(r.record.message).toBe('alta latencia');
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordHealthCheck(UID, 'firestore', 'down')).rejects.toThrow('set error');
  });
});

describe('getComponentHealth', () => {
  test('lanza si uid undefined', async () => {
    await expect(getComponentHealth(undefined, 'whatsapp')).rejects.toThrow('uid requerido');
  });
  test('lanza si component invalido', async () => {
    await expect(getComponentHealth(UID, 'nope')).rejects.toThrow('component invalido');
  });
  test('retorna unknown si no hay registros', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getComponentHealth(UID, 'whatsapp');
    expect(r.status).toBe('unknown');
    expect(r.component).toBe('whatsapp');
  });
  test('retorna el mas reciente si hay registros', async () => {
    const docs = [
      { id: 'h1', component: 'whatsapp', status: 'healthy', checkedAt: '2026-05-01T10:00:00Z' },
      { id: 'h2', component: 'whatsapp', status: 'down', checkedAt: '2026-05-01T11:00:00Z' },
    ];
    __setFirestoreForTests(makeMockDb({ docs }));
    const r = await getComponentHealth(UID, 'whatsapp');
    expect(r.status).toBe('down');
  });
  test('fail-open retorna unknown si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getComponentHealth(UID, 'whatsapp');
    expect(r.status).toBe('unknown');
  });
});

describe('getSystemHealthSummary', () => {
  test('lanza si uid undefined', async () => {
    await expect(getSystemHealthSummary(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna summary con todos los componentes', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getSystemHealthSummary(UID);
    expect(r.overallStatus).toBeDefined();
    expect(r.components).toBeDefined();
    expect(Object.keys(r.components).length).toBe(HEALTH_COMPONENTS.length);
    expect(r.uid).toBe(UID);
    expect(r.generatedAt).toBeDefined();
  });
});

describe('assessWhatsAppHealth', () => {
  const NOW = new Date('2026-05-04T12:00:00Z').getTime();

  test('retorna unknown si no hay lastSeenMs', () => {
    const r = assessWhatsAppHealth(null, NOW);
    expect(r.status).toBe('unknown');
  });
  test('retorna down si disconnectado mas de 10 min', () => {
    const r = assessWhatsAppHealth(NOW - 11 * 60 * 1000, NOW);
    expect(r.status).toBe('down');
    expect(r.message).toContain('minutos');
  });
  test('retorna degraded si inactivo entre 5 y 10 min', () => {
    const r = assessWhatsAppHealth(NOW - 6 * 60 * 1000, NOW);
    expect(r.status).toBe('degraded');
  });
  test('retorna healthy si activo reciente', () => {
    const r = assessWhatsAppHealth(NOW - 30 * 1000, NOW);
    expect(r.status).toBe('healthy');
  });
});

describe('generateHealthAlert', () => {
  test('down genera nivel CRITICAL', () => {
    const a = generateHealthAlert('whatsapp', 'down', 'Sin conexion');
    expect(a.level).toBe('critical');
    expect(a.component).toBe('whatsapp');
    expect(a.message).toBe('Sin conexion');
  });
  test('degraded genera nivel WARNING', () => {
    const a = generateHealthAlert('gemini', 'degraded');
    expect(a.level).toBe('warning');
  });
  test('healthy genera nivel INFO', () => {
    const a = generateHealthAlert('firestore', 'healthy');
    expect(a.level).toBe('info');
  });
  test('usa mensaje default si no se provee', () => {
    const a = generateHealthAlert('whatsapp', 'down');
    expect(a.message).toContain('whatsapp');
    expect(a.message).toContain('down');
  });
  test('generatedAt esta definido', () => {
    const a = generateHealthAlert('whatsapp', 'healthy');
    expect(a.generatedAt).toBeDefined();
  });
});
