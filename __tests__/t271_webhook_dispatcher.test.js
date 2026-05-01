'use strict';

// T271: webhook_dispatcher
const {
  buildDispatchRecord, buildDispatchResult, shouldRetry, applyDispatchResult,
  buildDispatchSummaryText, saveDispatch, getDispatch, updateDispatch,
  listPendingDispatches, listDispatchesByEvent, dispatchWebhook, computeBackoffMs,
  DISPATCH_STATUSES, MAX_RETRY_ATTEMPTS, INITIAL_BACKOFF_MS, MAX_BACKOFF_MS,
  __setFirestoreForTests,
} = require('../core/webhook_dispatcher');

const UID = 'testWHKUid';

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
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { exists: !!db_stored[id], data: () => db_stored[id] };
            },
          }),
          where: (field, op, val) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const entries = Object.values(db_stored).filter(d => d && d[field] === val);
              return {
                empty: entries.length === 0,
                forEach: fn => entries.forEach(d => fn({ data: () => d })),
              };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return {
              empty: Object.keys(db_stored).length === 0,
              forEach: fn => Object.values(db_stored).forEach(d => fn({ data: () => d })),
            };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
describe('constants', () => {
  test('DISPATCH_STATUSES frozen con 5 valores', () => {
    expect(DISPATCH_STATUSES).toHaveLength(5);
    expect(DISPATCH_STATUSES).toContain('pending');
    expect(DISPATCH_STATUSES).toContain('success');
    expect(DISPATCH_STATUSES).toContain('exhausted');
    expect(Object.isFrozen(DISPATCH_STATUSES)).toBe(true);
  });

  test('MAX_RETRY_ATTEMPTS es 3', () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(3);
  });

  test('computeBackoffMs escala exponencialmente', () => {
    expect(computeBackoffMs(0)).toBe(1000);
    expect(computeBackoffMs(1)).toBe(2000);
    expect(computeBackoffMs(2)).toBe(4000);
    expect(computeBackoffMs(10)).toBe(MAX_BACKOFF_MS);
  });
});

// ─── buildDispatchRecord ──────────────────────────────────────────────────────
describe('buildDispatchRecord', () => {
  test('crea record con defaults correctos', () => {
    const r = buildDispatchRecord('integ_001', 'evt_001', {
      webhookUrl: 'https://example.com/hook', payload: { event: 'test' },
    });
    expect(r.integrationId).toBe('integ_001');
    expect(r.eventId).toBe('evt_001');
    expect(r.status).toBe('pending');
    expect(r.attempts).toBe(0);
    expect(r.maxAttempts).toBe(MAX_RETRY_ATTEMPTS);
    expect(r.webhookMethod).toBe('POST');
    expect(r.succeededAt).toBeNull();
    expect(r.exhaustedAt).toBeNull();
  });

  test('dispatchId incluye integrationId y eventId', () => {
    const r = buildDispatchRecord('integ_abc', 'evt_xyz', {});
    expect(r.dispatchId).toContain('integ_abc'.slice(0, 10));
  });

  test('acepta maxAttempts personalizado', () => {
    const r = buildDispatchRecord('i', 'e', { maxAttempts: 5 });
    expect(r.maxAttempts).toBe(5);
  });

  test('webhookHeaders se copia defensivamente', () => {
    const headers = { Authorization: 'Bearer token123' };
    const r = buildDispatchRecord('i', 'e', { webhookHeaders: headers });
    expect(r.webhookHeaders.Authorization).toBe('Bearer token123');
    headers.extra = 'modified';
    expect(r.webhookHeaders.extra).toBeUndefined();
  });
});

// ─── buildDispatchResult ─────────────────────────────────────────────────────
describe('buildDispatchResult', () => {
  test('resultado exitoso', () => {
    const r = buildDispatchResult(true, 200, 'OK', null);
    expect(r.ok).toBe(true);
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('OK');
    expect(r.errorMsg).toBeNull();
  });

  test('resultado fallido', () => {
    const r = buildDispatchResult(false, 500, 'Server Error', 'HTTP error 500');
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(500);
    expect(r.errorMsg).toBe('HTTP error 500');
  });

  test('body se trunca a 500 chars', () => {
    const longBody = 'x'.repeat(600);
    const r = buildDispatchResult(true, 200, longBody, null);
    expect(r.body.length).toBe(500);
  });
});

// ─── shouldRetry ─────────────────────────────────────────────────────────────
describe('shouldRetry', () => {
  test('pending con 0 intentos → retry', () => {
    const r = buildDispatchRecord('i', 'e', {});
    expect(shouldRetry(r)).toBe(true);
  });

  test('success → no retry', () => {
    const r = { ...buildDispatchRecord('i', 'e', {}), status: 'success' };
    expect(shouldRetry(r)).toBe(false);
  });

  test('exhausted → no retry', () => {
    const r = { ...buildDispatchRecord('i', 'e', {}), status: 'exhausted', attempts: 3 };
    expect(shouldRetry(r)).toBe(false);
  });

  test('retrying con attempts < max → retry', () => {
    const r = { ...buildDispatchRecord('i', 'e', {}), status: 'retrying', attempts: 2 };
    expect(shouldRetry(r)).toBe(true);
  });

  test('null → false', () => {
    expect(shouldRetry(null)).toBe(false);
  });
});

// ─── applyDispatchResult ─────────────────────────────────────────────────────
describe('applyDispatchResult', () => {
  test('resultado exitoso → status success + succeededAt', () => {
    let r = buildDispatchRecord('i', 'e', { webhookUrl: 'https://ex.com' });
    const res = buildDispatchResult(true, 200, 'OK', null);
    r = applyDispatchResult(r, res);
    expect(r.status).toBe('success');
    expect(r.succeededAt).toBeDefined();
    expect(r.attempts).toBe(1);
    expect(r.nextRetryAt).toBeNull();
  });

  test('primer fallo → status retrying con nextRetryAt', () => {
    let r = buildDispatchRecord('i', 'e', { webhookUrl: 'https://ex.com' });
    const res = buildDispatchResult(false, 503, 'Service Unavailable', 'HTTP 503');
    r = applyDispatchResult(r, res);
    expect(r.status).toBe('retrying');
    expect(r.attempts).toBe(1);
    expect(r.nextRetryAt).toBeGreaterThan(Date.now() - 100);
    expect(r.lastError).toBe('HTTP 503');
  });

  test('tercer fallo → status exhausted', () => {
    let r = buildDispatchRecord('i', 'e', { maxAttempts: 3 });
    r = { ...r, attempts: 2, status: 'retrying' };
    const res = buildDispatchResult(false, 500, null, 'Error');
    r = applyDispatchResult(r, res);
    expect(r.status).toBe('exhausted');
    expect(r.exhaustedAt).toBeDefined();
    expect(r.nextRetryAt).toBeNull();
  });

  test('backoff aumenta con cada intento', () => {
    let r = buildDispatchRecord('i', 'e', { maxAttempts: 5 });
    const res = buildDispatchResult(false, 503, null, 'Error');

    const r1 = applyDispatchResult(r, res);
    const r2 = applyDispatchResult(r1, res);

    expect(r2.nextRetryAt).toBeGreaterThan(r1.nextRetryAt);
  });
});

// ─── FIRESTORE CRUD ──────────────────────────────────────────────────────────
describe('saveDispatch + getDispatch round-trip', () => {
  test('guarda y recupera dispatch', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const r = buildDispatchRecord('integ_001', 'evt_001', {
      webhookUrl: 'https://test.com', payload: { event: 'test' },
    });
    await saveDispatch(UID, r);
    __setFirestoreForTests(db);
    const loaded = await getDispatch(UID, r.dispatchId);
    expect(loaded).not.toBeNull();
    expect(loaded.status).toBe('pending');
    expect(loaded.webhookUrl).toBe('https://test.com');
  });

  test('getDispatch retorna null si no existe', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const result = await getDispatch(UID, 'nonexistent_id');
    expect(result).toBeNull();
  });

  test('saveDispatch con throwSet retorna error', async () => {
    const db = makeMockDb({ throwSet: true });
    __setFirestoreForTests(db);
    const r = buildDispatchRecord('i', 'e', {});
    await expect(saveDispatch(UID, r)).rejects.toThrow('set error');
  });
});

describe('updateDispatch', () => {
  test('actualiza campos con merge', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const r = buildDispatchRecord('integ_001', 'evt_001', { webhookUrl: 'https://test.com' });
    await saveDispatch(UID, r);
    __setFirestoreForTests(db);
    await updateDispatch(UID, r.dispatchId, { status: 'success', responseCode: 200 });
    __setFirestoreForTests(db);
    const loaded = await getDispatch(UID, r.dispatchId);
    expect(loaded.status).toBe('success');
    expect(loaded.responseCode).toBe(200);
    expect(loaded.webhookUrl).toBe('https://test.com');
  });
});

describe('listPendingDispatches', () => {
  test('retorna dispatches pending', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const r1 = buildDispatchRecord('integ_001', 'evt_a', { webhookUrl: 'https://a.com' });
    const r2 = buildDispatchRecord('integ_001', 'evt_b', { webhookUrl: 'https://b.com' });
    await saveDispatch(UID, r1);
    await saveDispatch(UID, r2);
    __setFirestoreForTests(db);
    const pending = await listPendingDispatches(UID);
    expect(pending.length).toBeGreaterThanOrEqual(2);
  });

  test('filtra por integrationId', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const r1 = buildDispatchRecord('integ_A', 'evt_1', {});
    const r2 = buildDispatchRecord('integ_B', 'evt_2', {});
    await saveDispatch(UID, r1);
    await saveDispatch(UID, r2);
    __setFirestoreForTests(db);
    const pending = await listPendingDispatches(UID, { integrationId: 'integ_A' });
    expect(pending.every(p => p.integrationId === 'integ_A')).toBe(true);
  });
});

describe('listDispatchesByEvent', () => {
  test('retorna todos los dispatches de un evento', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const r1 = buildDispatchRecord('integ_1', 'evt_target', {});
    const r2 = buildDispatchRecord('integ_2', 'evt_target', {});
    const r3 = buildDispatchRecord('integ_3', 'evt_other', {});
    await saveDispatch(UID, r1);
    await saveDispatch(UID, r2);
    await saveDispatch(UID, r3);
    __setFirestoreForTests(db);
    const results = await listDispatchesByEvent(UID, 'evt_target');
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.every(r => r.eventId === 'evt_target')).toBe(true);
  });
});

// ─── dispatchWebhook ─────────────────────────────────────────────────────────
describe('dispatchWebhook', () => {
  test('con fetchFn exitoso → result.ok = true', async () => {
    const r = buildDispatchRecord('i', 'e', { webhookUrl: 'https://test.com', payload: { x: 1 } });
    const mockFetch = async (url, opts) => ({ status: 200, text: async () => 'OK' });
    const result = await dispatchWebhook(r, mockFetch);
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  test('con fetchFn 500 → result.ok = false', async () => {
    const r = buildDispatchRecord('i', 'e', { webhookUrl: 'https://test.com' });
    const mockFetch = async () => ({ status: 500, text: async () => 'Internal Error' });
    const result = await dispatchWebhook(r, mockFetch);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(500);
  });

  test('con fetchFn que lanza → result.ok = false con errorMsg', async () => {
    const r = buildDispatchRecord('i', 'e', { webhookUrl: 'https://test.com' });
    const mockFetch = async () => { throw new Error('Connection refused'); };
    const result = await dispatchWebhook(r, mockFetch);
    expect(result.ok).toBe(false);
    expect(result.errorMsg).toContain('Connection refused');
  });

  test('sin fetchFn → error controlado', async () => {
    const r = buildDispatchRecord('i', 'e', { webhookUrl: 'https://test.com' });
    const result = await dispatchWebhook(r, null);
    expect(result.ok).toBe(false);
    expect(result.errorMsg).toBe('fetchFn no provisto');
  });

  test('sin webhookUrl → error controlado', async () => {
    const r = buildDispatchRecord('i', 'e', {});
    const result = await dispatchWebhook(r, async () => ({ status: 200 }));
    expect(result.ok).toBe(false);
    expect(result.errorMsg).toContain('webhookUrl vacia');
  });
});

// ─── buildDispatchSummaryText ─────────────────────────────────────────────────
describe('buildDispatchSummaryText', () => {
  test('dispatch null retorna mensaje por defecto', () => {
    expect(buildDispatchSummaryText(null)).toContain('no encontrado');
  });

  test('dispatch success incluye estado', () => {
    let r = buildDispatchRecord('i', 'e', { webhookUrl: 'https://ex.com/hook' });
    r = applyDispatchResult(r, buildDispatchResult(true, 200, 'OK', null));
    const text = buildDispatchSummaryText(r);
    expect(text).toContain('success');
    expect(text).toContain('https://ex.com/hook');
  });

  test('dispatch exhausted incluye error', () => {
    let r = buildDispatchRecord('i', 'e', { maxAttempts: 1 });
    r = applyDispatchResult(r, buildDispatchResult(false, 503, null, 'Service down'));
    const text = buildDispatchSummaryText(r);
    expect(text).toContain('exhausted');
    expect(text).toContain('Service down');
  });
});

// ─── PIPELINE: dispatch con retry ────────────────────────────────────────────
describe('Pipeline: retry hasta exito en tercer intento', () => {
  test('falla 2 veces luego exito', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);

    let callCount = 0;
    const mockFetch = async (url, opts) => {
      callCount++;
      if (callCount < 3) throw new Error('Network error attempt ' + callCount);
      return { status: 200, text: async () => 'OK finally' };
    };

    const dispatch = buildDispatchRecord('integ_webhook', 'evt_pay_conf', {
      webhookUrl: 'https://erp.test/hook',
      payload: { event: 'payment_confirmed', amount: 1000 },
      maxAttempts: 3,
    });
    await saveDispatch(UID, dispatch);

    let current = dispatch;

    // Intento 1 — falla
    const r1 = await dispatchWebhook(current, mockFetch);
    current = applyDispatchResult(current, r1);
    expect(current.status).toBe('retrying');
    expect(current.attempts).toBe(1);
    __setFirestoreForTests(db);
    await updateDispatch(UID, current.dispatchId, { status: current.status, attempts: current.attempts, nextRetryAt: current.nextRetryAt, lastError: current.lastError });

    // Intento 2 — falla
    __setFirestoreForTests(db);
    const r2 = await dispatchWebhook(current, mockFetch);
    current = applyDispatchResult(current, r2);
    expect(current.status).toBe('retrying');
    expect(current.attempts).toBe(2);
    __setFirestoreForTests(db);
    await updateDispatch(UID, current.dispatchId, { status: current.status, attempts: current.attempts, nextRetryAt: current.nextRetryAt });

    // Intento 3 — exito
    __setFirestoreForTests(db);
    const r3 = await dispatchWebhook(current, mockFetch);
    current = applyDispatchResult(current, r3);
    expect(current.status).toBe('success');
    expect(current.attempts).toBe(3);
    expect(current.succeededAt).toBeDefined();
    __setFirestoreForTests(db);
    await updateDispatch(UID, current.dispatchId, { status: current.status, attempts: current.attempts, succeededAt: current.succeededAt });

    // Verificar estado final en Firestore
    __setFirestoreForTests(db);
    const loaded = await getDispatch(UID, current.dispatchId);
    expect(loaded.status).toBe('success');
    expect(loaded.attempts).toBe(3);
    expect(callCount).toBe(3);
  });
});
