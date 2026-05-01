'use strict';

const {
  recordSent, recordEvent, getCampaignMetrics, getAllCampaignsSummary,
  __setFirestoreForTests,
} = require('../core/broadcast_analytics');

const UID = 'testUid1234567890';
const BC_ID = 'bc_20260504';
const PHONE = '+541155667788';

function makeMockDb({ docs = [], throwGet = false, throwSet = false } = {}) {
  const docsMap = {};
  docs.forEach(d => { docsMap[d.phone] = d; });
  return {
    collection: () => ({ doc: () => ({ collection: () => ({
      doc: () => ({ set: async () => { if (throwSet) throw new Error('set error'); } }),
      get: async () => {
        if (throwGet) throw new Error('get error');
        const items = Object.entries(docsMap).map(([id, data]) => ({ id, data: () => data }));
        return { forEach: fn => items.forEach(fn) };
      },
    })})})
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('recordSent', () => {
  test('lanza si uid undefined', async () => {
    await expect(recordSent(undefined, BC_ID, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si broadcastId undefined', async () => {
    await expect(recordSent(UID, undefined, PHONE)).rejects.toThrow('broadcastId requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(recordSent(UID, BC_ID, undefined)).rejects.toThrow('phone requerido');
  });
  test('registra sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordSent(UID, BC_ID, PHONE)).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordSent(UID, BC_ID, PHONE)).rejects.toThrow('set error');
  });
});

describe('recordEvent', () => {
  test('lanza si event invalido', async () => {
    await expect(recordEvent(UID, BC_ID, PHONE, 'visto')).rejects.toThrow('event invalido');
  });
  test('registra opened sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordEvent(UID, BC_ID, PHONE, 'opened')).resolves.toBeUndefined();
  });
  test('registra replied sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordEvent(UID, BC_ID, PHONE, 'replied')).resolves.toBeUndefined();
  });
});

describe('getCampaignMetrics', () => {
  test('lanza si uid undefined', async () => {
    await expect(getCampaignMetrics(undefined, BC_ID)).rejects.toThrow('uid requerido');
  });
  test('retorna ceros si no hay datos', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getCampaignMetrics(UID, BC_ID);
    expect(r.sent).toBe(0);
    expect(r.openRate).toBe(0);
    expect(r.replyRate).toBe(0);
  });
  test('calcula openRate correctamente', async () => {
    const docs = [
      { phone: '+1', opened: true, replied: false },
      { phone: '+2', opened: true, replied: false },
      { phone: '+3', opened: false, replied: false },
      { phone: '+4', opened: false, replied: false },
    ];
    __setFirestoreForTests(makeMockDb({ docs }));
    const r = await getCampaignMetrics(UID, BC_ID);
    expect(r.sent).toBe(4);
    expect(r.opened).toBe(2);
    expect(r.openRate).toBe(0.5);
    expect(r.replied).toBe(0);
    expect(r.replyRate).toBe(0);
  });
  test('calcula replyRate correctamente', async () => {
    const docs = [
      { phone: '+1', opened: true, replied: true },
      { phone: '+2', opened: false, replied: false },
    ];
    __setFirestoreForTests(makeMockDb({ docs }));
    const r = await getCampaignMetrics(UID, BC_ID);
    expect(r.replyRate).toBe(0.5);
  });
  test('fail-open retorna ceros si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getCampaignMetrics(UID, BC_ID);
    expect(r.sent).toBe(0);
  });
});

describe('getAllCampaignsSummary', () => {
  test('lanza si uid undefined', async () => {
    await expect(getAllCampaignsSummary(undefined, [])).rejects.toThrow('uid requerido');
  });
  test('lanza si broadcastIds no es array', async () => {
    await expect(getAllCampaignsSummary(UID, 'id')).rejects.toThrow('debe ser array');
  });
  test('retorna un item por broadcast', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getAllCampaignsSummary(UID, ['bc1', 'bc2']);
    expect(r.length).toBe(2);
    expect(r[0].broadcastId).toBe('bc1');
    expect(r[1].broadcastId).toBe('bc2');
  });
});
