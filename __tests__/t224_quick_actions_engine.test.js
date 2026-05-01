'use strict';

const {
  enqueueAction, updateActionStatus, getQueuedActions, getRecentActions,
  cancelAction, isActionExpired, summarizeQueue, isValidAction,
  ACTION_TYPES, ACTION_STATUSES, MAX_QUEUE_SIZE, ACTION_TTL_MS,
  __setFirestoreForTests,
} = require('../core/quick_actions_engine');

const UID = 'testUid1234567890';

function makeMockDb({ throwSet = false, throwGet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            set: async (data, opts) => { if (throwSet) throw new Error('set error'); },
          }),
          where: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { forEach: fn => {} };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return { forEach: fn => {} };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('ACTION_TYPES y constants', () => {
  test('ACTION_TYPES tiene 12 elementos', () => { expect(ACTION_TYPES.length).toBe(12); });
  test('ACTION_STATUSES tiene 5 elementos', () => { expect(ACTION_STATUSES.length).toBe(5); });
  test('frozen ACTION_TYPES', () => { expect(() => { ACTION_TYPES.push('x'); }).toThrow(); });
  test('MAX_QUEUE_SIZE es 50', () => { expect(MAX_QUEUE_SIZE).toBe(50); });
  test('ACTION_TTL_MS es 24h', () => { expect(ACTION_TTL_MS).toBe(24 * 60 * 60 * 1000); });
});

describe('isValidAction', () => {
  test('pause_miia es valido', () => { expect(isValidAction('pause_miia')).toBe(true); });
  test('resume_miia es valido', () => { expect(isValidAction('resume_miia')).toBe(true); });
  test('set_ooo es valido', () => { expect(isValidAction('set_ooo')).toBe(true); });
  test('block_contact es valido', () => { expect(isValidAction('block_contact')).toBe(true); });
  test('desconocido no es valido', () => { expect(isValidAction('desconocido')).toBe(false); });
  test('undefined no es valido', () => { expect(isValidAction(undefined)).toBe(false); });
});

describe('enqueueAction', () => {
  test('lanza si uid undefined', async () => {
    await expect(enqueueAction(undefined, 'pause_miia')).rejects.toThrow('uid requerido');
  });
  test('lanza si type undefined', async () => {
    await expect(enqueueAction(UID, undefined)).rejects.toThrow('type requerido');
  });
  test('lanza si type invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(enqueueAction(UID, 'tipo_raro')).rejects.toThrow('action type invalido');
  });
  test('retorna actionId y record', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await enqueueAction(UID, 'pause_miia');
    expect(r.actionId).toMatch(/^qa_/);
    expect(r.record.status).toBe('queued');
    expect(r.record.type).toBe('pause_miia');
  });
  test('record tiene params y triggeredBy', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await enqueueAction(UID, 'block_contact', { phone: '+54111' }, { triggeredBy: 'api' });
    expect(r.record.params.phone).toBe('+54111');
    expect(r.record.triggeredBy).toBe('api');
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(enqueueAction(UID, 'pause_miia')).rejects.toThrow('set error');
  });
});

describe('updateActionStatus', () => {
  test('lanza si uid undefined', async () => {
    await expect(updateActionStatus(undefined, 'a1', 'done')).rejects.toThrow('uid requerido');
  });
  test('lanza si actionId undefined', async () => {
    await expect(updateActionStatus(UID, undefined, 'done')).rejects.toThrow('actionId requerido');
  });
  test('lanza si status invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateActionStatus(UID, 'a1', 'nope')).rejects.toThrow('status invalido');
  });
  test('done agrega executedAt', async () => {
    let saved = null;
    __setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
        set: async (data) => { saved = data; },
      })})})}),
    });
    await updateActionStatus(UID, 'a1', 'done', { success: true });
    expect(saved.executedAt).toBeDefined();
    expect(saved.status).toBe('done');
  });
});

describe('getQueuedActions', () => {
  test('lanza si uid undefined', async () => {
    await expect(getQueuedActions(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay cola', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getQueuedActions(UID);
    expect(r).toEqual([]);
  });
  test('fail-open si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getQueuedActions(UID);
    expect(r).toEqual([]);
  });
});

describe('getRecentActions', () => {
  test('lanza si uid undefined', async () => {
    await expect(getRecentActions(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay acciones', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getRecentActions(UID);
    expect(r).toEqual([]);
  });
  test('fail-open si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getRecentActions(UID);
    expect(r).toEqual([]);
  });
});

describe('cancelAction', () => {
  test('lanza si uid undefined', async () => {
    await expect(cancelAction(undefined, 'a1')).rejects.toThrow('uid requerido');
  });
  test('lanza si actionId undefined', async () => {
    await expect(cancelAction(UID, undefined)).rejects.toThrow('actionId requerido');
  });
  test('cancela sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(cancelAction(UID, 'a1')).resolves.toBeUndefined();
  });
});

describe('isActionExpired', () => {
  test('retorna false si record nulo', () => { expect(isActionExpired(null)).toBe(false); });
  test('retorna false si createdAt falta', () => { expect(isActionExpired({})).toBe(false); });
  test('retorna true si createdAt hace mas de 24h', () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    expect(isActionExpired({ createdAt: old })).toBe(true);
  });
  test('retorna false si createdAt reciente', () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    expect(isActionExpired({ createdAt: recent })).toBe(false);
  });
});

describe('summarizeQueue', () => {
  test('retorna totales correctos', () => {
    const actions = [
      { type: 'pause_miia', status: 'queued' },
      { type: 'pause_miia', status: 'done' },
      { type: 'block_contact', status: 'queued' },
    ];
    const s = summarizeQueue(actions);
    expect(s.total).toBe(3);
    expect(s.byType['pause_miia']).toBe(2);
    expect(s.byType['block_contact']).toBe(1);
    expect(s.byStatus['queued']).toBe(2);
    expect(s.hasPendingActions).toBe(true);
  });
  test('hasPendingActions false si no hay queued', () => {
    const actions = [{ type: 'pause_miia', status: 'done' }];
    expect(summarizeQueue(actions).hasPendingActions).toBe(false);
  });
  test('array vacio da total 0', () => {
    const s = summarizeQueue([]);
    expect(s.total).toBe(0);
    expect(s.hasPendingActions).toBe(false);
  });
});
