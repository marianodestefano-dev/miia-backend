'use strict';

const {
  createBroadcast, segmentAudience, calculateOptimalSendTime,
  updateBroadcastState, getScheduledBroadcasts,
  MAX_AUDIENCE_SIZE, OPTIMAL_HOURS, BROADCAST_STATES,
  __setFirestoreForTests,
} = require('../core/broadcast_v2');

const UID = 'testUid1234567890';
const NOW = new Date('2026-05-04T14:00:00.000Z').getTime(); // 14:00 UTC
const NOW_EARLY = new Date('2026-05-04T05:00:00.000Z').getTime(); // 05:00 UTC (fuera de horario)

const SAMPLE_CONTACTS = [
  { phone: '+1', tags: ['cliente', 'vip'] },
  { phone: '+2', tags: ['cliente'] },
  { phone: '+3', tags: ['lead'] },
  { phone: '+4', tags: ['cliente', 'inactivo'] },
  { phone: '+5', tags: [] },
];

function makeMockDb({ throwSet = false, throwGet = false, docs = [] } = {}) {
  return {
    collection: () => ({ doc: () => ({ collection: () => ({
      doc: () => ({ set: async () => { if (throwSet) throw new Error('set error'); } }),
      where: () => ({
        get: async () => {
          if (throwGet) throw new Error('get error');
          const items = docs.map((d, i) => ({ id: d.id || 'bc' + i, data: () => d }));
          return { forEach: fn => items.forEach(fn) };
        },
      }),
    })})})
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('constants', () => {
  test('MAX_AUDIENCE_SIZE es 10000', () => { expect(MAX_AUDIENCE_SIZE).toBe(10000); });
  test('OPTIMAL_HOURS start=9 end=20', () => {
    expect(OPTIMAL_HOURS.start).toBe(9);
    expect(OPTIMAL_HOURS.end).toBe(20);
    expect(() => { OPTIMAL_HOURS.start = 8; }).toThrow();
  });
  test('BROADCAST_STATES es frozen con 5 estados', () => {
    expect(BROADCAST_STATES.length).toBe(5);
    expect(BROADCAST_STATES).toContain('draft');
    expect(BROADCAST_STATES).toContain('scheduled');
    expect(() => { BROADCAST_STATES.push('x'); }).toThrow();
  });
});

describe('createBroadcast', () => {
  test('lanza si uid undefined', async () => {
    await expect(createBroadcast(undefined, {})).rejects.toThrow('uid requerido');
  });
  test('lanza si name undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(createBroadcast(UID, { message: 'x', tags: [] })).rejects.toThrow('name requerido');
  });
  test('lanza si message undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(createBroadcast(UID, { name: 'test', tags: [] })).rejects.toThrow('message requerido');
  });
  test('lanza si tags no es array', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(createBroadcast(UID, { name: 'x', message: 'x', tags: 'nope' })).rejects.toThrow('tags debe ser array');
  });
  test('crea broadcast con state=draft si no scheduledAt', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await createBroadcast(UID, { name: 'Camp 1', message: 'Hola!', tags: ['cliente'] });
    expect(r.state).toBe('draft');
    expect(r.id).toBeDefined();
  });
  test('crea broadcast con state=scheduled si scheduledAt', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await createBroadcast(UID, { name: 'Camp 2', message: 'Hola!', tags: [], scheduledAt: '2026-12-01T09:00:00Z' });
    expect(r.state).toBe('scheduled');
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(createBroadcast(UID, { name: 'x', message: 'x', tags: [] })).rejects.toThrow('set error');
  });
});

describe('segmentAudience', () => {
  test('lanza si contacts no es array', () => {
    expect(() => segmentAudience('nope', ['tag'])).toThrow('debe ser array');
  });
  test('lanza si tags no es array', () => {
    expect(() => segmentAudience([], 'tag')).toThrow('debe ser array');
  });
  test('sin tags retorna todos', () => {
    const r = segmentAudience(SAMPLE_CONTACTS, []);
    expect(r.length).toBe(5);
  });
  test('filtra por tag cliente', () => {
    const r = segmentAudience(SAMPLE_CONTACTS, ['cliente']);
    expect(r.length).toBe(3);
    expect(r.every(c => c.tags.includes('cliente'))).toBe(true);
  });
  test('AND logic: cliente AND vip', () => {
    const r = segmentAudience(SAMPLE_CONTACTS, ['cliente', 'vip']);
    expect(r.length).toBe(1);
    expect(r[0].phone).toBe('+1');
  });
  test('retorna vacio si ningun contacto matchea', () => {
    expect(segmentAudience(SAMPLE_CONTACTS, ['premium'])).toEqual([]);
  });
  test('limita a MAX_AUDIENCE_SIZE', () => {
    const many = Array.from({ length: MAX_AUDIENCE_SIZE + 100 }, (_, i) => ({ phone: '+' + i, tags: ['t'] }));
    expect(segmentAudience(many, ['t']).length).toBe(MAX_AUDIENCE_SIZE);
  });
});

describe('calculateOptimalSendTime', () => {
  test('durante horario optimo retorna isOptimal=true', () => {
    const r = calculateOptimalSendTime(NOW, 'UTC');
    expect(r.isOptimal).toBe(true);
    expect(r.scheduledAt).toBeDefined();
  });
  test('fuera de horario retorna isOptimal=false y ajusta', () => {
    const r = calculateOptimalSendTime(NOW_EARLY, 'UTC');
    expect(r.isOptimal).toBe(false);
    const scheduled = new Date(r.scheduledAt);
    expect(scheduled.getUTCHours()).toBe(OPTIMAL_HOURS.start);
  });
  test('retorna scheduledAt como ISO string', () => {
    const r = calculateOptimalSendTime(NOW);
    expect(typeof r.scheduledAt).toBe('string');
    expect(r.scheduledAt).toContain('T');
  });
});

describe('updateBroadcastState', () => {
  test('lanza si uid undefined', async () => {
    await expect(updateBroadcastState(undefined, 'id', 'sent')).rejects.toThrow('uid requerido');
  });
  test('lanza si state invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateBroadcastState(UID, 'id', 'publicado')).rejects.toThrow('state invalido');
  });
  test('actualiza sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateBroadcastState(UID, 'id', 'sent', { sentCount: 10, failCount: 1 })).resolves.toBeUndefined();
  });
});

describe('getScheduledBroadcasts', () => {
  test('lanza si uid undefined', async () => {
    await expect(getScheduledBroadcasts(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna broadcasts cuyo scheduledAt <= ahora', async () => {
    const docs = [
      { id: 'bc1', state: 'scheduled', scheduledAt: '2026-05-04T13:00:00Z' },
      { id: 'bc2', state: 'scheduled', scheduledAt: '2026-05-04T15:00:00Z' },
    ];
    __setFirestoreForTests(makeMockDb({ docs }));
    const r = await getScheduledBroadcasts(UID, NOW);
    expect(r.length).toBe(1);
    expect(r[0].id).toBe('bc1');
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getScheduledBroadcasts(UID)).toEqual([]);
  });
});
