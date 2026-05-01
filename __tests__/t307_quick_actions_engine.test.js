'use strict';

/**
 * T307 -- quick_actions_engine unit tests (25/25)
 */

const {
  enqueueAction,
  updateActionStatus,
  getQueuedActions,
  getRecentActions,
  cancelAction,
  isActionExpired,
  summarizeQueue,
  isValidAction,
  ACTION_TYPES,
  ACTION_STATUSES,
  MAX_QUEUE_SIZE,
  ACTION_TTL_MS,
  __setFirestoreForTests,
} = require('../core/quick_actions_engine');

function makeMockDb() {
  const store = {};
  return {
    store,
    db: {
      collection: () => ({
        doc: (uid) => ({
          collection: (subCol) => ({
            doc: (id) => ({
              set: async (data, opts) => {
                if (!store[uid]) store[uid] = {};
                if (!store[uid][subCol]) store[uid][subCol] = {};
                if (opts && opts.merge) {
                  store[uid][subCol][id] = { ...(store[uid][subCol][id] || {}), ...data };
                } else {
                  store[uid][subCol][id] = { ...data };
                }
              },
              get: async () => {
                const rec = store[uid] && store[uid][subCol] && store[uid][subCol][id];
                return { exists: !!rec, data: () => rec, id };
              },
            }),
            where: (field, op, val) => ({
              get: async () => {
                const all = Object.entries((store[uid] || {})[subCol] || {});
                const filtered = all.filter(([, r]) => op === '==' ? r[field] === val : true);
                return {
                  empty: filtered.length === 0,
                  forEach: (fn) => filtered.forEach(([docId, d]) => fn({ id: docId, data: () => d })),
                };
              },
            }),
            get: async () => {
              const all = Object.entries((store[uid] || {})[subCol] || {});
              return {
                empty: all.length === 0,
                forEach: (fn) => all.forEach(([docId, d]) => fn({ id: docId, data: () => d })),
              };
            },
          }),
        }),
      }),
    },
  };
}

const UID = 'tenant_t307_001';

describe('T307 -- quick_actions_engine (25 tests)', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    __setFirestoreForTests(mock.db);
  });

  // Constantes

  test('ACTION_TYPES frozen con 12 tipos validos', () => {
    expect(Object.isFrozen(ACTION_TYPES)).toBe(true);
    expect(ACTION_TYPES.length).toBe(12);
    expect(ACTION_TYPES).toContain('pause_miia');
    expect(ACTION_TYPES).toContain('resume_miia');
    expect(ACTION_TYPES).toContain('block_contact');
    expect(ACTION_TYPES).toContain('send_template');
  });

  test('ACTION_STATUSES frozen con 5 estados', () => {
    expect(Object.isFrozen(ACTION_STATUSES)).toBe(true);
    expect(ACTION_STATUSES.length).toBe(5);
    ['queued', 'executing', 'done', 'failed', 'cancelled'].forEach(s => {
      expect(ACTION_STATUSES).toContain(s);
    });
  });

  test('MAX_QUEUE_SIZE es 50 y ACTION_TTL_MS es 24h en ms', () => {
    expect(MAX_QUEUE_SIZE).toBe(50);
    expect(ACTION_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  // isValidAction

  test('isValidAction: tipos validos retornan true', () => {
    expect(isValidAction('pause_miia')).toBe(true);
    expect(isValidAction('send_template')).toBe(true);
    expect(isValidAction('export_contacts')).toBe(true);
  });

  test('isValidAction: tipos invalidos retornan false', () => {
    expect(isValidAction('tipo_raro')).toBe(false);
    expect(isValidAction('')).toBe(false);
    expect(isValidAction(null)).toBe(false);
  });

  // enqueueAction

  test('enqueueAction: lanza error si uid falta', async () => {
    await expect(enqueueAction(null, 'pause_miia', {})).rejects.toThrow('uid requerido');
    await expect(enqueueAction('', 'pause_miia', {})).rejects.toThrow('uid requerido');
  });

  test('enqueueAction: lanza error si type invalido', async () => {
    await expect(enqueueAction(UID, 'tipo_raro', {})).rejects.toThrow('invalido');
  });

  test('enqueueAction: guarda record en Firestore y retorna actionId + record', async () => {
    const { actionId, record } = await enqueueAction(UID, 'pause_miia', { reason: 'vacaciones' });
    expect(actionId).toMatch(/^qa_/);
    expect(record.type).toBe('pause_miia');
    expect(record.status).toBe('queued');
    expect(record.params.reason).toBe('vacaciones');
    expect(record.triggeredBy).toBe('owner_dashboard');

    // verificar en store
    const stored = mock.store[UID]['quick_actions'][actionId];
    expect(stored).toBeDefined();
    expect(stored.status).toBe('queued');
  });

  test('enqueueAction: triggeredBy custom pasado por opts', async () => {
    const { record } = await enqueueAction(UID, 'set_ooo', {}, { triggeredBy: 'api' });
    expect(record.triggeredBy).toBe('api');
  });

  test('enqueueAction: lanza error si type falta', async () => {
    await expect(enqueueAction(UID, '', {})).rejects.toThrow('type requerido');
  });

  // updateActionStatus

  test('updateActionStatus: actualiza status a executing con merge', async () => {
    const { actionId } = await enqueueAction(UID, 'pause_miia', {});
    await updateActionStatus(UID, actionId, 'executing', null, null);
    const stored = mock.store[UID]['quick_actions'][actionId];
    expect(stored.status).toBe('executing');
    expect(stored.executedAt).not.toBeNull();
  });

  test('updateActionStatus: done setea executedAt y result', async () => {
    const { actionId } = await enqueueAction(UID, 'resume_miia', {});
    await updateActionStatus(UID, actionId, 'done', { ok: true }, null);
    const stored = mock.store[UID]['quick_actions'][actionId];
    expect(stored.status).toBe('done');
    expect(stored.result).toEqual({ ok: true });
    expect(stored.executedAt).not.toBeNull();
  });

  test('updateActionStatus: failed setea error y executedAt', async () => {
    const { actionId } = await enqueueAction(UID, 'block_contact', {});
    await updateActionStatus(UID, actionId, 'failed', null, 'timeout');
    const stored = mock.store[UID]['quick_actions'][actionId];
    expect(stored.status).toBe('failed');
    expect(stored.error).toBe('timeout');
    expect(stored.executedAt).not.toBeNull();
  });

  test('updateActionStatus: lanza error si status invalido', async () => {
    const { actionId } = await enqueueAction(UID, 'pause_miia', {});
    await expect(updateActionStatus(UID, actionId, 'estado_raro')).rejects.toThrow('invalido');
  });

  // getQueuedActions

  test('getQueuedActions: retorna solo acciones en estado queued', async () => {
    const { actionId: id1 } = await enqueueAction(UID, 'pause_miia', {});
    const { actionId: id2 } = await enqueueAction(UID, 'resume_miia', {});
    await updateActionStatus(UID, id2, 'done', null, null);

    const queued = await getQueuedActions(UID);
    expect(queued.length).toBe(1);
    expect(queued[0].type).toBe('pause_miia');
  });

  test('getQueuedActions: retorna array vacio si no hay queued', async () => {
    const queued = await getQueuedActions('uid_sin_acciones_99999');
    expect(queued).toEqual([]);
  });

  // getRecentActions

  test('getRecentActions: retorna todas las acciones ordenadas por createdAt desc', async () => {
    await enqueueAction(UID, 'pause_miia', {});
    await new Promise(r => setTimeout(r, 5));
    await enqueueAction(UID, 'resume_miia', {});

    const recent = await getRecentActions(UID);
    expect(recent.length).toBe(2);
    // El mas reciente primero
    expect(recent[0].type).toBe('resume_miia');
    expect(recent[1].type).toBe('pause_miia');
  });

  test('getRecentActions: respeta limitCount', async () => {
    for (let i = 0; i < 5; i++) {
      await enqueueAction(UID, 'pause_miia', { i });
    }
    const recent = await getRecentActions(UID, 3);
    expect(recent.length).toBe(3);
  });

  // cancelAction

  test('cancelAction: setea status a cancelled', async () => {
    const { actionId } = await enqueueAction(UID, 'pause_miia', {});
    await cancelAction(UID, actionId);
    const stored = mock.store[UID]['quick_actions'][actionId];
    expect(stored.status).toBe('cancelled');
    expect(stored.error).toBe('Cancelado por owner');
  });

  // isActionExpired

  test('isActionExpired: false para record reciente', () => {
    const record = { createdAt: new Date().toISOString() };
    expect(isActionExpired(record)).toBe(false);
  });

  test('isActionExpired: true para record de hace mas de 24h', () => {
    const oldDate = new Date(Date.now() - ACTION_TTL_MS - 1000).toISOString();
    const record = { createdAt: oldDate };
    expect(isActionExpired(record)).toBe(true);
  });

  test('isActionExpired: false si record es null o sin createdAt', () => {
    expect(isActionExpired(null)).toBe(false);
    expect(isActionExpired({})).toBe(false);
  });

  test('isActionExpired: acepta nowMs custom para calcular expiry', () => {
    const record = { createdAt: new Date(1000).toISOString() };
    // Pasamos nowMs muy grande para forzar expirado
    expect(isActionExpired(record, Date.now())).toBe(true);
    // Pasamos nowMs = 2000 (solo 1s despues de creacion)
    expect(isActionExpired(record, 2000)).toBe(false);
  });

  // summarizeQueue

  test('summarizeQueue: agrega por tipo, status y hasPendingActions', () => {
    const actions = [
      { type: 'pause_miia', status: 'queued' },
      { type: 'pause_miia', status: 'done' },
      { type: 'send_template', status: 'queued' },
    ];
    const summary = summarizeQueue(actions);
    expect(summary.total).toBe(3);
    expect(summary.byType['pause_miia']).toBe(2);
    expect(summary.byType['send_template']).toBe(1);
    expect(summary.byStatus['queued']).toBe(2);
    expect(summary.byStatus['done']).toBe(1);
    expect(summary.hasPendingActions).toBe(true);
  });

  test('summarizeQueue: array vacio retorna totales en 0', () => {
    const summary = summarizeQueue([]);
    expect(summary.total).toBe(0);
    expect(summary.hasPendingActions).toBe(false);
  });

  test('summarizeQueue: hasPendingActions false si todas done', () => {
    const actions = [
      { type: 'resume_miia', status: 'done' },
      { type: 'resume_miia', status: 'done' },
    ];
    const summary = summarizeQueue(actions);
    expect(summary.hasPendingActions).toBe(false);
  });
});
