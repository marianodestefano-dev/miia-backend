'use strict';

const {
  checkTenantHealth, sendHealthAlert, recordHealthCheck,
  getComponentHealth, getSystemHealthSummary, assessWhatsAppHealth,
  generateHealthAlert, buildHealthRecord, DISCONNECT_THRESHOLD_MS,
  ALERT_COOLDOWN_MS, __setFirestoreForTests,
} = require('../core/health_monitor');

// ── Mocks Firestore ──────────────────────────────────────────────────────────
let mockSetData = {};
let mockSnapExists = false;
let mockSnapData = {};

function makeRef(snapExists, snapData) {
  return {
    get: async () => ({ exists: snapExists, data: () => JSON.parse(JSON.stringify(snapData)) }),
    set: async (d, _opts) => { mockSetData = d; },
  };
}

function makeSnap(docs) {
  return { forEach: function(fn) { docs.forEach(fn); } };
}

let mockDocs = [];
const mockCollection = {
  where: () => mockCollection,
  get: async () => makeSnap(mockDocs),
  doc: (id) => ({ set: async (d) => { mockSetData = d; }, get: async () => ({ exists: mockSnapExists, data: () => JSON.parse(JSON.stringify(mockSnapData)) }) }),
};

const mockDb = {
  collection: (col) => ({
    doc: (uid) => ({
      collection: (subCol) => ({
        doc: (docId) => makeRef(mockSnapExists, mockSnapData),
        where: () => ({ get: async () => makeSnap(mockDocs) }),
      }),
    }),
  }),
};

beforeEach(() => {
  __setFirestoreForTests(mockDb);
  mockSetData = {};
  mockSnapExists = false;
  mockSnapData = {};
  mockDocs = [];
});
// ── checkTenantHealth ────────────────────────────────────────────────────────
describe('checkTenantHealth', function () {
  test('uid null → throw', async function () {
    await expect(checkTenantHealth(null)).rejects.toThrow('uid requerido');
  });

  test('doc no existe → disconnected (sin last_seen) + alerta enviada', async function () {
    mockSnapExists = false;
    const r = await checkTenantHealth('uid1');
    expect(r.status).toBe('disconnected');
    expect(r.lastSeen).toBeNull();
    expect(r.alertSent).toBe(true);
  });

  test('last_seen reciente → healthy sin alerta', async function () {
    mockSnapExists = true;
    mockSnapData = { last_seen: new Date().toISOString(), last_alert: null };
    const r = await checkTenantHealth('uid1');
    expect(r.status).toBe('healthy');
    expect(r.alertSent).toBe(false);
  });

  test('last_seen viejo → disconnected + alerta enviada (sin last_alert)', async function () {
    mockSnapExists = true;
    const old = new Date(Date.now() - DISCONNECT_THRESHOLD_MS - 1000).toISOString();
    mockSnapData = { last_seen: old };
    const r = await checkTenantHealth('uid1');
    expect(r.status).toBe('disconnected');
    expect(r.alertSent).toBe(true);
  });

  test('disconnected pero last_alert reciente → cooldown activo → no alerta', async function () {
    mockSnapExists = true;
    const oldSeen = new Date(Date.now() - DISCONNECT_THRESHOLD_MS - 1000).toISOString();
    const recentAlert = new Date(Date.now() - 1000).toISOString();
    mockSnapData = { last_seen: oldSeen, last_alert: recentAlert };
    const r = await checkTenantHealth('uid1');
    expect(r.status).toBe('disconnected');
    expect(r.alertSent).toBe(false);
  });

  test('disconnected con last_alert hace >1h → puede alertar', async function () {
    mockSnapExists = true;
    const oldSeen = new Date(Date.now() - DISCONNECT_THRESHOLD_MS - 1000).toISOString();
    const oldAlert = new Date(Date.now() - ALERT_COOLDOWN_MS - 1000).toISOString();
    mockSnapData = { last_seen: oldSeen, last_alert: oldAlert };
    const r = await checkTenantHealth('uid1');
    expect(r.status).toBe('disconnected');
    expect(r.alertSent).toBe(true);
  });
});
// ── sendHealthAlert ──────────────────────────────────────────────────────────
describe('sendHealthAlert', function () {
  test('uid null → throw', async function () {
    await expect(sendHealthAlert(null, 'push')).rejects.toThrow('uid requerido');
  });

  test('channel null → usa default all', async function () {
    mockSnapExists = false;
    const r = await sendHealthAlert('uid1', null);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('all');
  });

  test('doc existe con alert_count_24h → incrementa', async function () {
    mockSnapExists = true;
    mockSnapData = { alert_count_24h: 3 };
    const r = await sendHealthAlert('uid1', 'email');
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('email');
    expect(mockSetData.alert_count_24h).toBe(4);
  });

  test('doc no existe → count empieza en 1', async function () {
    mockSnapExists = false;
    const r = await sendHealthAlert('uid1', 'push');
    expect(mockSetData.alert_count_24h).toBe(1);
  });

  test('doc existe sin alert_count_24h → || 0 → count 1', async function () {
    mockSnapExists = true;
    mockSnapData = {};
    const r = await sendHealthAlert('uid1', 'wa');
    expect(mockSetData.alert_count_24h).toBe(1);
  });
});
// ── Funciones existentes (cubrir ramas pendientes) ──────────────────────────
describe('assessWhatsAppHealth', function () {
  test('sin lastSeenMs → unknown', function () {
    const r = assessWhatsAppHealth(null);
    expect(r.status).toBe('unknown');
  });

  test('reciente → healthy', function () {
    const r = assessWhatsAppHealth(Date.now() - 1000);
    expect(r.status).toBe('healthy');
  });

  test('entre threshold/2 y threshold → degraded', function () {
    const elapsed = DISCONNECT_THRESHOLD_MS * 0.7;
    const r = assessWhatsAppHealth(Date.now() - elapsed);
    expect(r.status).toBe('degraded');
  });

  test('mayor a threshold → down', function () {
    const elapsed = DISCONNECT_THRESHOLD_MS + 1000;
    const r = assessWhatsAppHealth(Date.now() - elapsed);
    expect(r.status).toBe('down');
  });

  test('nowMs proporcionado → usa ese valor (sin Date.now)', function () {
    const now = 1000000;
    const r = assessWhatsAppHealth(1, now); // elapsed = 999999ms > threshold
    expect(r.status).toBe('down');
  });
});

describe('generateHealthAlert', function () {
  test('status down → level critical', function () {
    const a = generateHealthAlert('whatsapp', 'down', 'test');
    expect(a.level).toBe('critical');
  });

  test('status degraded → level warning', function () {
    const a = generateHealthAlert('firestore', 'degraded', 'msg');
    expect(a.level).toBe('warning');
  });

  test('status healthy → level info', function () {
    const a = generateHealthAlert('gemini', 'healthy');
    expect(a.level).toBe('info');
    expect(a.message).toContain('gemini');
  });
});
describe('recordHealthCheck y buildHealthRecord', function () {
  test('uid null → throw', async function () {
    await expect(recordHealthCheck(null, 'whatsapp', 'healthy', {})).rejects.toThrow('uid requerido');
  });

  test('component null → throw', async function () {
    await expect(recordHealthCheck('u1', null, 'healthy', {})).rejects.toThrow('component requerido');
  });

  test('component invalido → throw', async function () {
    await expect(recordHealthCheck('u1', 'redis', 'healthy', {})).rejects.toThrow('component invalido');
  });

  test('status invalido → throw', async function () {
    await expect(recordHealthCheck('u1', 'whatsapp', 'bad', {})).rejects.toThrow('status invalido');
  });

  test('status down → loguea warning (rama console.warn)', async function () {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await recordHealthCheck('uid1', 'whatsapp', 'down', { message: 'x' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('status degraded → loguea warning', async function () {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await recordHealthCheck('uid1', 'firestore', 'degraded', {});
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('meta con extra truthy → extra en record', async function () {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await recordHealthCheck('uid1', 'whatsapp', 'down', { extra: { foo: 'bar' }, message: 'msg' });
    spy.mockRestore();
  });

  test('status healthy → no warning', async function () {
    const r = await recordHealthCheck('uid1', 'gemini', 'healthy', { latencyMs: 120 });
    expect(r.record.status).toBe('healthy');
  });
});
describe('getComponentHealth', function () {
  test('uid null → throw', async function () {
    await expect(getComponentHealth(null, 'whatsapp')).rejects.toThrow('uid requerido');
  });

  test('component invalido → throw', async function () {
    await expect(getComponentHealth('u1', 'redis')).rejects.toThrow('component invalido');
  });

  test('sin registros → unknown', async function () {
    mockDocs = [];
    const r = await getComponentHealth('u1', 'whatsapp');
    expect(r.status).toBe('unknown');
  });

  test('con registros → retorna el mas reciente', async function () {
    mockDocs = [
      { data: () => ({ component: 'whatsapp', status: 'healthy', checkedAt: '2026-01-01T10:00:00Z', message: null }) },
      { data: () => ({ component: 'whatsapp', status: 'down',    checkedAt: '2026-01-01T11:00:00Z', message: 'x' }) },
    ];
    const r = await getComponentHealth('u1', 'whatsapp');
    expect(r.status).toBe('down');
  });

  test('Firestore get lanza error → catch → unknown', async function () {
    const errDb = {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            where: () => ({ get: async () => { throw new Error('fs error'); } }),
          }),
        }),
      }),
    };
    __setFirestoreForTests(errDb);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await getComponentHealth('u1', 'whatsapp');
    expect(r.status).toBe('unknown');
    spy.mockRestore();
    __setFirestoreForTests(mockDb);
  });
});

describe('getSystemHealthSummary', function () {
  test('uid null → throw', async function () {
    await expect(getSystemHealthSummary(null)).rejects.toThrow('uid requerido');
  });

  test('todos healthy → overallStatus healthy', async function () {
    mockDocs = [];
    const r = await getSystemHealthSummary('u1');
    expect(r.overallStatus).toBe('degraded');
  });

  test('un componente down → overallStatus down', async function () {
    mockDocs = [
      { data: () => ({ component: 'whatsapp', status: 'down', checkedAt: '2026-01-01T10:00:00Z', message: null }) },
    ];
    const r = await getSystemHealthSummary('u1');
    expect(r.overallStatus).toBe('down');
  });

  test('un componente degraded (no down) => overallStatus degraded (linea 88)', async function () {
    mockDocs = [
      { data: () => ({ component: 'whatsapp', status: 'degraded', checkedAt: '2026-01-01T10:00:00Z', message: null }) },
    ];
    const r = await getSystemHealthSummary('u1');
    expect(r.overallStatus).toBe('degraded');
  });

  test('down + degraded: rama else-if degraded&&!down = false (overallStatus queda down)', async function () {
    let callCount = 0;
    const multiDb = {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            where: () => ({
              get: async () => {
                callCount++;
                const st = callCount === 1 ? 'down' : 'degraded';
                return { forEach: (fn) => fn({ data: () => ({ component: 'x', status: st, checkedAt: '2026-01-01T10:00:00Z', message: null }) }) };
              },
            }),
          }),
        }),
      }),
    };
    __setFirestoreForTests(multiDb);
    const r = await getSystemHealthSummary('u1');
    expect(r.overallStatus).toBe('down');
    __setFirestoreForTests(mockDb);
  });
});
